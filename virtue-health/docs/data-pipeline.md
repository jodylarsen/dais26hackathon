Confirmed: the `/api/facilities` SELECT returns `facility_id` (not `unique_id`), `name`, `organization_type`, `address_city`, `address_stateorregion`, `address_country`, and reads from the plain `facilities` table. Now I have all the load-bearing facts verified. Here is the rewritten document incorporating the relevant findings.

# Virtue Health — Data Pipeline Design

## Overview

This document describes the complete data pipeline for Virtue Health, from the upstream source catalog through Delta Lake to Lakebase Postgres. It covers the full data lineage, architectural decisions, operational patterns, and recovery procedures.

It is the **authoritative source** for the **seed pattern** (Section 5), the **CDF setup/verification** workflow (Section 3), the **sequential synced-table quota workaround** (Section 7), the **synced-table status vocabulary** (Section 7.1), and the **Lakebase resource hierarchy** (Section 8). Other documents should cross-link here rather than restate these procedures.

The analytics-layer formulas (trust weight, demand index, gap score) are defined canonically in `data-model.md`. They are summarized in Section 6 **only** for their data-quality dependencies on the pipeline tables; do not treat Section 6 as the formula source of truth.

> **Glossary (terms used in this document).**
> - **CDF** — Change Data Feed (Delta Lake's row-level change log).
> - **DABs** — Databricks Asset Bundles (the deployment bundle format).
> - **OLTP** — Online Transaction Processing (the Postgres read/write workload).
> - **NFHS-5** — National Family Health Survey, Round 5 (the district health indicator source).
> - **Synced table / online table** — the **same object**. Databricks docs/UI call it a **synced table**; the CLI noun is **online table** (`databricks online-tables ...`). This document uses "synced table" in prose and the CLI's `online-tables` noun in commands.

> **SQL identifier rule (applies to every DDL example below).** The Lakebase UC catalog is `virtue-pg` (hyphen). Because the name contains a hyphen it is **not** a valid bare SQL identifier and **must** be backtick-quoted everywhere: `` `virtue-pg` ``. Unquoted `virtue-pg` is a syntax error; `virtue_pg` (underscore) is simply the wrong catalog name. The fully-qualified synced-table path always includes the `databricks_postgres` database level between the catalog and the schema:
> `` `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table> ``

> **Read path note.** All production API endpoints (`/api/summary`, `/api/facilities*`, `/api/districts*`, `/api/desert/*`) currently read from the **SQL Warehouse** (`5b2b29cce22aa2c4`) via `appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver` — i.e., the **plain** (non-`_live`) tables. The Lakebase Postgres path described in Sections 7–8 is the operational/write-sync target; it is **not** currently the read path for any endpoint.
>
> **API response field naming.** The `/api/facilities` and `/api/desert/heatmap-points` endpoints project a numeric **`facility_id`** column, **not** `unique_id`. Verified in source: `server/routes/virtue-health-routes.ts` (the facilities SELECT projects `facility_id, name, organization_type, address_city, address_stateorregion, address_country`; the heatmap SELECT projects `facility_id, ...`) and the client interfaces (`client/src/pages/facilities/FacilitiesPage.tsx`, `client/src/pages/desert/types.ts`) both declare `facility_id: number`. The physical PK column is documented upstream as `unique_id` (the column that has the duplicate-value issue in Section 11), but the API does **not** return a field named `unique_id`. Any document or test asserting an API response field of `unique_id: string` is wrong; the response field is `facility_id: number`.
>
> **No Lakebase code is active.** The `lakebase` plugin is **not** registered in `server/server.ts` — `createApp` loads only `analytics({})` and `server()` — so `appkit.lakebase` does not exist at runtime. The sample `server/routes/lakebase/todo-routes.ts` exports `setupSampleLakebaseRoutes`, but it is **never imported or called** (`onPluginsReady` only calls `setupVirtueHealthRoutes`), and the matching `client/src/pages/lakebase/LakebasePage.tsx` is not wired into the router. These are orphaned scaffold files; there is no live Lakebase consumer at all. Keep this in mind when reasoning about read freshness: production reads see the static snapshot tables, not the synced Postgres tables, and nothing reads Postgres today.

---

## 1. Data Lineage

> Textual summary (in case the diagram below wraps): the hackathon source catalog is **deep-cloned** into `dais27hack.virtue_foundation_dataset_silver` as three **plain** read-only snapshot tables; those are then **seeded** into three CDF-enabled `_live` tables via the disable-CDF seed pattern; the `_live` tables sync to **Lakebase Postgres** via TRIGGERED synced-table pipelines (only the NFHS table is ONLINE today). Synced-table states use the canonical vocabulary defined in Section 7.1 (`ONLINE` / `BLOCKED-quota` / `BLOCKED-dup-pk`).

```
databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset
        (source catalog — read-only, provided by hackathon organizers)
                        │
                        │  DEEP CLONE
                        ▼
    dais27hack.virtue_foundation_dataset_silver
        ├── facilities                          (read-only snapshot, 10,088 rows)
        ├── nfhs_5_district_health_indicators   (read-only snapshot, 706 rows)
        └── india_post_pincode_directory        (read-only snapshot, 165,627 rows)
                        │
                        │  disable CDF → TRUNCATE → INSERT → re-enable CDF (seed pattern, §5)
                        ▼
    dais27hack.virtue_foundation_dataset_silver  (_live variants, CDF-enabled)
        ├── facilities_live
        ├── nfhs_5_district_health_indicators_live
        └── india_post_pincode_directory_live
                        │
                        │  Lakebase Synced Tables (CDF pipeline, TRIGGERED mode)
                        ▼
    Lakebase Postgres
        Project:    virtue-health
        Endpoint:   ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com
        UC Catalog: virtue-pg
        Database:   databricks_postgres
        Schema:     virtue_foundation_dataset_silver
        ├── facilities_live          (BLOCKED-dup-pk — duplicate unique_id issue)
        ├── nfhs_5_district_health_indicators_live  (ONLINE)
        └── india_post_pincode_directory_live       (BLOCKED-quota — quota limit)
```

All three source tables are cloned into `dais27hack.virtue_foundation_dataset_silver` and exist in two forms:

- **Plain tables** (`facilities`, `nfhs_5_district_health_indicators`, `india_post_pincode_directory`): read-only, used for Delta SQL queries via the SQL Warehouse (`5b2b29cce22aa2c4`) in the Express server's `appkit.analytics.query()` calls. **These are the tables the production API actually reads from today.**
- **Live tables** (`*_live`): writable, CDF-enabled, intended as the source of truth that syncs to Lakebase. App writes are designed to target these tables; changes propagate downstream via CDF. (No endpoint reads from these or from their Postgres replicas yet — and the Lakebase plugin is not even loaded; see the read-path note above.)

---

## 2. Why the `_live` Table Pattern

The live table pattern decouples the stable read-only source data (provided by the hackathon) from the writable operational layer. Key reasons:

1. **Source protection.** The upstream catalog (`databricks_virtue_foundation_dataset_dais_2026`) is read-only. Cloning to `_live` tables in the app's own schema provides a writable layer without touching the source.

2. **CDF enablement.** Change Data Feed (CDF) must be enabled at table creation or explicitly set via `TBLPROPERTIES`. Enabling CDF on the plain clones would mix operational change history with the static snapshot. The `_live` tables start fresh with CDF enabled, giving a clean change log from the moment the app goes live.

3. **Clean sync boundary.** Lakebase synced tables subscribe to the `_live` CDF stream. Using separate tables means the synced table pipeline only sees intentional application writes, not any backfill or exploration queries against the snapshot tables.

4. **Surgical data quality fixes.** The seed process (see Section 5) let the team fix known data issues — specifically, null bytes (`0x00`) in `facilities.name` and `facilities.description` — during the `INSERT INTO SELECT FROM` step. The plain source tables retain the original (dirty) data; the `_live` tables hold the cleaned version.

> **Caveat — the null-byte fix lives only in `_live`.** Because the production API currently reads from the **plain** `facilities` table (not `facilities_live`), API responses can still contain null bytes in any returned text column. Today the `/api/facilities` SELECT returns only `facility_id, name, organization_type, address_city, address_stateorregion, address_country` — so `name` can still carry `0x00` until reads move to `facilities_live` or the fix is applied to the plain table. This is why the null-byte issue is **OPEN on the read path**, not fully resolved — it is remediated only in `facilities_live`, which nothing reads today (see Section 11).

> **Track 4 divergence note.** Track 4 (Data Readiness Desk) is specified to profile `facilities_live` (the remediated table), even though every current read endpoint queries the plain `facilities` table. This is a deliberate design divergence: data-quality counts (null bytes, duplicate `unique_id`, completeness) will **differ** between `facilities` and `facilities_live`. A Track 4 implementer must profile `facilities_live` knowingly, not assume it matches the table the rest of the app reads. See `project-overview.md §8` (Track 4 acceptance criteria) and the read-path note above.

---

## 3. CDF Setup and Verification

### Enabling CDF

CDF was enabled on all three `_live` tables using:

```sql
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);

ALTER TABLE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);

ALTER TABLE dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

### Verifying CDF is Active

Check the table property:

```sql
DESCRIBE EXTENDED dais27hack.virtue_foundation_dataset_silver.facilities_live;
-- Look for: delta.enableChangeDataFeed = true in the Table Properties section
```

### Reading the Change Log

Use `table_changes()` to inspect what CDF has recorded:

```sql
-- Read all changes since version 0
SELECT *
FROM table_changes(
  'dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live',
  0
)
ORDER BY _commit_version, _commit_timestamp;
```

Key CDF metadata columns returned:

| Column | Description |
|---|---|
| `_change_type` | `insert`, `update_preimage`, `update_postimage`, `delete` |
| `_commit_version` | Delta table version number of this change |
| `_commit_timestamp` | Wall-clock time the commit was written |

To read changes since a specific version (useful for incremental sync debugging):

```sql
SELECT *
FROM table_changes(
  'dais27hack.virtue_foundation_dataset_silver.facilities_live',
  5  -- starting from version 5
)
WHERE _change_type IN ('insert', 'update_postimage', 'delete');
```

To check the current version of a `_live` table:

```sql
DESCRIBE HISTORY dais27hack.virtue_foundation_dataset_silver.facilities_live
LIMIT 5;
```

---

## 4. TRIGGERED vs CONTINUOUS Mode Tradeoffs

Virtue Health uses **TRIGGERED** mode for all Lakebase synced tables. This was a deliberate choice given the hackathon context.

### TRIGGERED Mode

- The sync pipeline runs on-demand or on a schedule, not continuously.
- Each run reads the CDF log since the last committed watermark, applies the changes to Postgres, and stops.
- Lower compute cost: the pipeline does not hold a running cluster between syncs.
- Latency is bounded by the trigger interval, not by the change rate.
- Appropriate when Postgres read-freshness requirements are measured in seconds-to-minutes rather than milliseconds.

### CONTINUOUS Mode

- The pipeline stays running, processing CDF changes as they arrive.
- Sub-second latency from Delta write to Postgres visibility.
- Higher compute cost: a cluster runs continuously even when there is no data to process.
- Required for truly real-time operational use cases (e.g., live patient-facing lookup).

### Decision for Virtue Health

The app's OLTP reads (facility lookups, district indicators) are tolerant of slight staleness — a user searching for facilities will not notice a 30-second delay in seeing a newly added record. TRIGGERED mode was chosen to stay within hackathon compute budget constraints. If the app were promoted to production with live user writes, CONTINUOUS mode would be revisited for the `facilities_live` sync.

> Note: this tradeoff only becomes user-visible once the API actually reads from the synced Postgres tables. As of today the API reads the SQL Warehouse snapshot tables (and the Lakebase plugin is not even loaded), so the TRIGGERED sync latency does not affect what users see.

---

## 5. The Seed Pattern (Canonical): Disable CDF → Truncate → Insert → Re-enable CDF

> **This is the single canonical seed/reload ordering for the project.** `runbook.md` and `data-model.md` must use this exact ordering; if any other document shows a different order (e.g., TRUNCATE before disabling CDF), this section governs. The ordering is **disable CDF first**, so that *neither* the `TRUNCATE` *nor* the bulk `INSERT` writes any events to the change log.

Naively reloading a CDF-enabled table records every operation in the change log:

- A `TRUNCATE` while CDF is **enabled** is recorded as `delete` events.
- An `INSERT` while CDF is **enabled** records every inserted row as an `insert` event.

For the initial bulk load of ~10,088 facilities, ~706 NFHS records, and ~165,627 pincode records, this would generate a large and unnecessary CDF log — bloating the synced table's first sync and obscuring the true operational change baseline. The fix is to **disable CDF before doing anything else**, so the truncate and the insert are both invisible to the change log, and re-enable CDF only after the load completes.

```sql
-- Step 1: Disable CDF FIRST so neither the TRUNCATE nor the INSERT is logged.
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = false);

-- Step 2: Truncate the _live table (no 'delete' events recorded — CDF is off).
TRUNCATE TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live;

-- Step 3: Insert cleaned data from the source snapshot table (no 'insert' events — CDF is off).
-- IMPORTANT: do NOT use SELECT * for facilities — null bytes must be stripped
-- from name and description via an explicit, column-aliased projection.
INSERT INTO dais27hack.virtue_foundation_dataset_silver.facilities_live
SELECT
  unique_id,
  REPLACE(name, CAST(CHAR(0) AS STRING), '')         AS name,
  organization_type,
  capability,
  specialties,
  equipment,
  procedure,
  source_types,
  source_ids,
  address_city,
  address_stateorregion,
  address_country,
  latitude,
  longitude,
  REPLACE(description, CAST(CHAR(0) AS STRING), '')  AS description,
  cluster_id,
  source_urls
FROM dais27hack.virtue_foundation_dataset_silver.facilities;

-- Step 4: Re-enable CDF so future operational writes (and only those) are tracked.
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

> **Physical PK column note.** The bulk INSERT above selects the physical column `unique_id` from the source table — this is the underlying primary-key column (the one with the duplicate-value issue in Section 11). It is **not** in conflict with the API's `facility_id` response field: the API projects a numeric `facility_id` at query time (see the Overview read-path note), while the physical seed copies the source schema verbatim.

The same pattern was applied to `nfhs_5_district_health_indicators_live` and `india_post_pincode_directory_live`. For those two tables a `SELECT *` insert is acceptable because the null-byte issue is specific to `facilities`; the disable → truncate → insert → re-enable ordering still applies.

> **Ordering matters — both operations must be inside the CDF-disabled window.** If CDF is re-enabled (or never disabled) before the `TRUNCATE`/`INSERT`, the truncate is logged as `delete` events and the bulk load as `insert` events — defeating the purpose of the pattern and bloating the next sync. Section 10's reload procedure follows this same ordering. The seed verification splits across two tests in `test-plan.md`: row counts are verified by **`P-TC-01`** via `SELECT COUNT(*)` (e.g., `facilities_live` = 10,088), and the **zero-event** CDF assertion (no seed-attributable insert/delete events in the change log under this ordering) is **`P-TC-03`** — `table_changes` from the CDF re-enable version shows no seed events. Cite `P-TC-03` for the zero-CDF-events expectation, not `P-TC-01`.

**Why this works cleanly:** The Lakebase synced table pipeline subscribes to CDF events starting from the version at which the synced table was created (or explicitly configured). Because both the truncate and the bulk INSERT were performed while CDF was disabled, neither appears in the change log. The synced table instead performs an initial full-table snapshot load to establish the Postgres baseline, then tracks only subsequent CDF events (application writes). This gives a clean, minimal change log.

---

## 6. Analytics Formulas — Pipeline Data Dependencies Only

> **Scope.** The trust-weight, demand-index, and gap-score formulas are defined **canonically in `data-model.md`** (and surfaced per-endpoint in `api-reference.md`). They are reproduced here **only** to document the two ways they depend on pipeline-table data quality. Do not maintain a second copy of the formula text — update `data-model.md` and cross-link. (Note: `data-model.md` is the single canonical home for these formulas; `project-overview.md` summarizes them but is not canonical.)

The Express server (`server/routes/virtue-health-routes.ts`, `setupVirtueHealthRoutes`) computes three derived metrics directly in SQL over the **plain** `facilities` and `nfhs_5_district_health_indicators` tables. To locate any of them in source, search the routes file for the distinctive expression quoted below rather than relying on line numbers.

### 6.1 Trust Weight — depends on `facilities.source_types` NULL handling

```sql
-- search the routes file for: SIZE(SPLIT(NULLIF(TRIM(source_types)
LEAST(
  COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0,
  1.0
)
```

Intended behavior: count the comma-separated `source_types` for a facility, divide by 3, cap at 1.0. A facility with 3+ source types gets the maximum weight of 1.0.

> **⚠️ Edge-case bug — NULL/empty `source_types` yields a NEGATIVE weight.** In Spark SQL, `SIZE(SPLIT(NULL, ','))` returns **-1**, not NULL. When `source_types` is NULL or whitespace-only, `NULLIF(TRIM(source_types), '')` becomes NULL, so `SIZE(SPLIT(NULL, ','))` returns **-1**. Because -1 is non-null, the `COALESCE(..., 1)` fallback **never fires**, and the expression evaluates to `LEAST(-1 / 3.0, 1.0) = -0.333`. So facilities with no source types receive a **negative trust weight** — not the `0.333` the data dictionary implies, and not a clamped-to-zero value. The identical expression is used in the heatmap `trust_weight`, the state-gap `avg_trust_weight`/`supply_score`/`gap_score`, and the capability-summary `avg_trust_weight`, so every one of those is affected.
>
> **Recommended canonical fix (NULL `source_types` → intended 0.333):**
> ```sql
> LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
> ```
> Do **not** instead clamp with `GREATEST(..., 0.0)` unless you specifically intend NULL `source_types` to score **0**, not 0.333 — the two fixes have *different semantics*. Pick one, apply it to every occurrence, and update any docs/tests asserting `trust_weight ∈ [0.0, 1.0]`. **OPEN — see Section 13 to confirm `SIZE(SPLIT(NULL, ','))` behavior on the warehouse before shipping the fix.**

### 6.2 Demand Index — a deprivation-based demand proxy

The **field** is named `demand_index` everywhere (code and JSON responses); the **concept** is a *deprivation-based demand proxy*. They are the same number — higher deprivation (lower coverage) ⇒ higher demand. It is fully defined in code; it is the average shortfall across four NFHS access/coverage percentages (100 minus each, averaged), per state, with a null fallback of 50 per component:

```sql
ROUND((
    (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
  + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
  + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
  + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
) / 4.0, 1) AS demand_index
```

The four source columns are exactly the four NFHS columns the `/api/districts` endpoint also returns. Per-column `COALESCE(AVG(...), 50)` means a state missing one indicator contributes a neutral 50 for that component rather than NULLing the whole index.

### 6.3 Gap Score and the State-Name Join (Track 2)

State-level gap scoring joins facility supply against NFHS demand via a **`FULL OUTER JOIN`** between a facility-derived CTE (`facility_state`) and an NFHS-derived CTE (`nfhs_state`), keyed on a **normalized state name** `LOWER(TRIM(state))`:

```sql
-- facility side keyed on LOWER(TRIM(address_stateorregion))
-- nfhs side    keyed on LOWER(TRIM(state_ut))
...
ROUND(
  COALESCE(ns.demand_index, 50) /
  GREATEST(
    COALESCE(fs.facility_count, 0) * COALESCE(fs.avg_trust_weight, 0.0) / 10.0,
    0.1
  ),
  2
) AS gap_score
FROM nfhs_state ns
FULL OUTER JOIN facility_state fs ON ns.state_key = fs.state_key
ORDER BY gap_score DESC NULLS LAST
```

Behaviors the formula encodes:

- **Numerator fallback:** `COALESCE(ns.demand_index, 50)` — a state present on the facility side but absent from NFHS gets a default demand of 50, not NULL.
- **Denominator floor:** `supply_score = facility_count * avg_trust_weight / 10.0`, floored at `0.1` via `GREATEST(..., 0.1)` to avoid division by zero.
- **FULL OUTER JOIN:** states present in only one source still appear (with zero-filled supply or default-50 demand). The output `state` column is `COALESCE(ns.state_ut, fs.address_stateorregion)`.

> **⚠️ Correctness risk — state-name mismatches (the single largest correctness risk in Track 2).** The join key is normalized but **not canonicalized**. `facilities.address_stateorregion` and NFHS's `state_ut` use different spellings for the same state (e.g. `"NCT of Delhi"` vs `"Delhi"`, `"Orissa"` vs `"Odisha"`). Any mismatch produces **two separate rows** instead of one: one with demand but zero supply (inflated gap score) and one with supply but default-50 demand.
>
> **Example remediation — normalize both sides with a crosswalk before joining:**
> ```sql
> -- minimal crosswalk; the WHEN values are ILLUSTRATIVE and must be verified
> -- against the actual mismatches in this dataset (run the EXCEPT diagnostic
> -- in runbook §10.9 to enumerate them first).
> CASE LOWER(TRIM(state))
>   WHEN 'nct of delhi' THEN 'delhi'
>   WHEN 'orissa'       THEN 'odisha'
>   WHEN 'pondicherry'  THEN 'puducherry'
>   ELSE LOWER(TRIM(state))
> END AS state_key
> ```
> Run the diagnostic to enumerate the real mismatches in this dataset, then populate the crosswalk. This is tracked as **BLOCKED-on-decision** in the known-issues table (Section 11).
>
> **Related cross-page note.** This same state-name divergence means the Overview KPI `statesCovered` (which counts NFHS `state_ut`) draws from a *different* state universe than the Facilities-page filter (`/api/facilities/states`, which lists facilities `address_stateorregion`). The two counts can legitimately differ; this is the same root cause as the gap-score mismatch.

`/api/desert/state-gaps` also derives a per-row `confidence` field in application code (not SQL): `source_type_variants >= 3 → 'high'`, `>= 1 → 'medium'`, else `'low'`.

### 6.4 Heatmap Bounding-Box Filter

`/api/desert/heatmap-points` does **not** simply exclude null coordinates — it also restricts points to India's bounding box (search the routes file for `BETWEEN 6.0 AND 37.5`):

```sql
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  AND CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5
  AND CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5
```

Facilities with valid-but-out-of-box coordinates (data-entry errors or genuinely outside India) are **silently dropped** from the heatmap — so "facility locations" on the heatmap means "in-box facility locations," not "all facilities." Note the explicit `CAST(latitude AS DOUBLE)` here and in the SELECT projection: whether this cast is load-bearing or merely defensive depends on the stored type of `facilities.latitude`/`longitude`. **OPEN — see Section 13 to verify that type before asserting "no cast needed."**

---

## 7. Sequential Synced Table Creation: Quota Workaround

### The Constraint

The Databricks workspace (`dbc-0a01f518-764a.cloud.databricks.com`) enforces a quota of **1 concurrent `DATABASE_TABLE_SYNC` pipeline**. Attempting to create multiple Lakebase synced tables simultaneously causes all but one to fail at provisioning time.

### The Workaround

Synced tables must be created **one at a time**, waiting for each to reach `ONLINE` status before starting the next.

Recommended creation order (least to most problematic):

1. `nfhs_5_district_health_indicators_live` — smallest table (706 rows), no known data quality issues. Create first and confirm `ONLINE`.
2. `india_post_pincode_directory_live` — large table (165,627 rows), longer initial sync. Create second.
3. `facilities_live` — blocked until the duplicate `unique_id` issue is resolved upstream (see Section 11). Create last.

### 7.1 Canonical Synced-Table Status Vocabulary

> **This is the canonical status vocabulary for synced-table state across the doc set.** `data-model.md` and `architecture.md` must cross-reference this list rather than coining their own terms (e.g., do not use bare "PENDING" or "Pending (quota limit)" — map to the values below).

| Status | Meaning | Current tables |
|---|---|---|
| `ONLINE` | Synced table provisioned and actively tracking CDF; `Last synced` timestamp recent | `nfhs_5_district_health_indicators_live` |
| `BLOCKED-quota` | Not yet created because the 1-concurrent `DATABASE_TABLE_SYNC` quota is held by another pipeline | `india_post_pincode_directory_live` |
| `BLOCKED-dup-pk` | Not yet created because the source `_live` table has duplicate physical `unique_id` values that violate the Postgres PK | `facilities_live` |
| `SYNCING` | Initial snapshot or an incremental sync run is in progress | (transient) |
| `OFFLINE_FAILED` | Pipeline hit an unrecoverable error; see Section 10 | (none currently) |

These map onto the Databricks-native status badges (`ONLINE`, `SYNCING`, `OFFLINE_FAILED`) plus two project-specific "not-yet-created" reasons (`BLOCKED-quota`, `BLOCKED-dup-pk`) that distinguish *why* a synced table has not been provisioned.

### Verifying Status Before Creating the Next Table

Check the sync pipeline status in the Databricks UI under the Lakebase project `virtue-health`, via the CLI (`databricks online-tables list ...` — confirm the exact subcommand with `databricks online-tables --help`), or query the Unity Catalog information schema (exact system table path may vary by workspace version):

```sql
-- Check synced table status (workspace-dependent system table path)
SELECT table_name, sync_status
FROM system.information_schema.synced_tables
WHERE catalog_name = 'virtue-pg';
```

Alternatively, verify in the Databricks UI:
- Navigate to **Catalog** → `virtue-pg` → `databricks_postgres` → `virtue_foundation_dataset_silver`
- Each synced table shows a status badge: `ONLINE`, `SYNCING`, `OFFLINE_FAILED`, etc.

Only proceed to the next `CREATE` statement once the current table shows `ONLINE`.

---

## 8. Lakebase Project / Endpoint / Catalog Hierarchy

Lakebase Postgres in Databricks has a specific resource hierarchy:

```
Lakebase Project: virtue-health
    │
    ├── Endpoint: ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com
    │       (connection host for psql / app DB connections)
    │
    ├── Unity Catalog catalog: virtue-pg   (backtick-quote in SQL: `virtue-pg`)
    │       (UC representation of all Postgres objects; governs access via UC permissions)
    │
    └── Postgres database: databricks_postgres
            │
            └── Schema: virtue_foundation_dataset_silver
                    ├── facilities_live          (synced table — BLOCKED-dup-pk)
                    ├── nfhs_5_district_health_indicators_live  (synced table — ONLINE)
                    └── india_post_pincode_directory_live       (synced table — BLOCKED-quota)
```

(Status values above use the canonical vocabulary from Section 7.1.)

A synced table is therefore addressed (in UC) as `` `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table> `` — the `databricks_postgres` database level sits between the catalog and the schema, and `virtue-pg` is always backtick-quoted (see the identifier rule in the Overview).

### Connection environment variables (for local dev)

The Lakebase connection settings live in environment variables, but **`.env.example` ships placeholders, not the resolved values**. The actual file contents are:

```
DATABRICKS_HOST=https://...
PGDATABASE=your_postgres_databaseName
LAKEBASE_ENDPOINT=your_postgres_endpointPath
PGHOST=your_postgres_host
PGPORT=5432
PGSSLMODE=require
DATABRICKS_APP_PORT=8000
DATABRICKS_APP_NAME=virtue-health
FLASK_RUN_HOST=0.0.0.0
```

To populate `PGHOST` / `LAKEBASE_ENDPOINT` / `PGDATABASE` for local dev:

1. **Find the Lakebase branch name first** (a Lakebase project has one or more branches; an endpoint belongs to a branch). List the branches for the project:
   ```bash
   # Confirm the exact subcommand against `databricks postgres --help` for your CLI version.
   databricks postgres list-branches --project virtue-health --profile deepak-workspace
   ```
2. **List the endpoints for the chosen branch** and read the host/endpoint path off the result:
   ```bash
   databricks postgres list-endpoints <branch-name> --profile deepak-workspace
   ```
   (`appkit.plugins.json` references this `list-endpoints` step. If `list-branches` is not the exact subcommand in your CLI version, run `databricks postgres --help` to find the branch-listing command — do not guess a `<branch-name>` value.)
3. Set `DATABRICKS_HOST` to the workspace URL.

Do **not** assume `.env.example` already contains `PGDATABASE=databricks_postgres` or the concrete `ep-solitary-poetry-...` hostname — those are the resolved runtime values, not what ships in the file.

> **Note:** Since the Lakebase plugin is not currently loaded (see the read-path note in the Overview), the `PG*` / `LAKEBASE_ENDPOINT` values are **unused at runtime today**. They only matter once the `lakebase` plugin is added to `createApp` and a route actually calls `appkit.lakebase.query()`.

**Project recreation caveat:** The `virtue-health` Lakebase project was deleted and recreated during troubleshooting earlier in the development cycle. The endpoint host string above reflects the recreated project. If the project is ever deleted and recreated again, the endpoint hostname will change and must be updated in:
- The `.env` file (`PGHOST` / `LAKEBASE_ENDPOINT`)
- Any hardcoded connection strings in the Express server
- The DABs bundle environment configuration

The endpoint is in the `us-east-2` AWS region, co-located with the Databricks workspace to minimize latency and avoid cross-region data transfer costs.

---

## 9. Verifying Sync Health

### Check Table Status

In the Databricks UI, navigate to the Lakebase project `virtue-health` and inspect each synced table's status. The expected steady-state is `ONLINE` with a recent `Last synced` timestamp (see Section 7.1 for the status vocabulary).

### Verify Row Counts Match

After a sync cycle completes, compare row counts between Delta and Postgres:

```sql
-- Delta source (via SQL Warehouse 5b2b29cce22aa2c4)
SELECT COUNT(*) FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
-- Expected: 706
```

```sql
-- Postgres (connect via psql or the Data API to virtue-pg)
SELECT COUNT(*) FROM virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
-- Should match Delta count after sync
```

### Verify Recent Changes Propagated

After an application write to a `_live` Delta table, confirm the change appears in Postgres within the TRIGGERED sync interval:

1. Write a test record to `nfhs_5_district_health_indicators_live` (or update an existing one).
2. Note the `_commit_version` from `DESCRIBE HISTORY`.
3. Wait for the next TRIGGERED sync to complete (check the pipeline run log in the Lakebase UI).
4. Query Postgres for the updated row.

### Check the CDF Watermark

The synced table pipeline internally tracks a watermark (the last processed CDF version). If the pipeline falls behind or stalls, the gap between the current Delta table version and the watermark version will grow. This is visible in the Lakebase pipeline run logs under the `virtue-health` project.

---

## 10. Recovering from `OFFLINE_FAILED`

A synced table enters `OFFLINE_FAILED` when the sync pipeline encounters an unrecoverable error — for example, a schema mismatch, a Postgres constraint violation, or a network partition.

### Diagnosis

1. Open the Databricks UI, navigate to the Lakebase project `virtue-health`.
2. Click the affected synced table to view the pipeline run history.
3. Inspect the most recent failed run's error message. Common causes:
   - **Schema drift**: a column was added or dropped in the Delta `_live` table without a corresponding Postgres schema migration.
   - **Constraint violation**: a row in the CDF log violates a Postgres primary key or not-null constraint (e.g., duplicate `unique_id` in `facilities_live`).
   - **Quota exhaustion**: the `DATABASE_TABLE_SYNC` quota was hit by another pipeline starting concurrently.

### Recovery Steps

**For schema drift:**
1. Alter the Postgres table schema in the `virtue-pg` catalog to match the Delta table schema.
2. Resume the pipeline from the Lakebase UI (do not recreate — resuming preserves the watermark).

**For constraint violations (e.g., duplicate `unique_id`):**
1. Fix the data quality issue in the Delta `_live` table (deduplicate, or wait for upstream fix).
2. If the pipeline cannot resume, the synced table may need to be dropped and recreated after the data is clean. This triggers a full re-snapshot load and resets the watermark.
3. Remember the quota constraint: if recreating, ensure no other sync pipeline is running.

**For quota exhaustion:**
1. Identify which other pipeline is running (check all synced tables in the `virtue-pg` catalog).
2. Wait for it to complete or pause it manually.
3. Resume the `OFFLINE_FAILED` pipeline.

**General reset procedure** (last resort — drops and recreates the synced table):

> **Synced-table DDL is Lakebase-version-specific and has NOT been verified against this workspace.** Before running any `CREATE ... TABLE` here, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version). The form below is a **template**, not a known-good command. The DDL **keyword** (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`) is itself an open verification item — standardize on `CREATE ONLINE TABLE` everywhere until verified, and track the keyword check at **`runbook.md §12 OV-3`** (the canonical home for that task). `runbook.md §4.1` must use this **same** template (backticked `` `virtue-pg` ``, four-level path including `databricks_postgres`) — do not introduce a differently-leveled or unquoted path there, and do not add a `TIMESERIES KEY` clause that no other doc carries.

```sql
-- Step 1: Drop the synced table in Postgres (this stops the pipeline).
-- Run against Postgres via the virtue-pg catalog.
DROP TABLE virtue_foundation_dataset_silver.facilities_live;

-- Step 2: Recreate the synced table (triggers full snapshot re-load).
-- TEMPLATE — verify syntax before use (keyword: see runbook §12 OV-3). Do this
-- only when no other sync pipeline is active (quota = 1 concurrent). Note the
-- backticked catalog and the databricks_postgres database level in the target path.
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.facilities_live
  PRIMARY KEY (unique_id)
  FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

After recreation, the pipeline performs a full initial snapshot before tracking CDF changes. Monitor the run log until status returns to `ONLINE`.

> If you need to re-seed the `_live` Delta source before recreating, follow the **disable CDF → TRUNCATE → INSERT → re-enable CDF** ordering from Section 5 (and use the explicit null-byte-stripping column list for `facilities`, never `SELECT *`).

---

## 11. Known Data Issues Affecting the Pipeline

> **Status legend:** **OPEN** = needs work, no decision yet · **ACCEPTED** = known and intentionally not fixing (rationale given) · **BLOCKED** = needs an external/upstream fix or an unmade decision · **RESOLVED** = fixed.
>
> The project's **canonical** Known-Issues list is `project-overview.md §10`. The rows below are the pipeline-relevant subset; where a canonical number exists, cite it from `project-overview.md §10` rather than re-numbering here. (The null-byte issue must be added as a row in that canonical list — it is currently absent there; see the row below.)

| Issue | Table | Impact | Status |
|---|---|---|---|
| Duplicate `unique_id` values | `facilities` / `facilities_live` | Blocks Lakebase synced table creation (Postgres PK violation) — synced-table state `BLOCKED-dup-pk` (§7.1) | **BLOCKED** — awaiting upstream fix in source catalog |
| `latitude`/`longitude` as `STRING` type | `india_post_pincode_directory_live` | Geographic queries require explicit `CAST(... AS DOUBLE)` | **ACCEPTED** — document the cast workaround in the query layer |
| `facilities.latitude`/`longitude` actual type unconfirmed | `facilities` | Heatmap query casts `CAST(latitude AS DOUBLE)`; if already DOUBLE the cast is redundant, if STRING it is load-bearing | **OPEN** — verify on warehouse (Section 13) |
| Null bytes (`0x00`) in `name`, `description` | `facilities` → `facilities_live` | Stripped during seed via `REPLACE(col, CAST(CHAR(0) AS STRING), '')` in `_live` **only**; plain `facilities` (the table the API actually reads) still contains null bytes | **OPEN (read path)** — remediated in `facilities_live`, NOT in the plain `facilities` table the API serves. (Add to canonical `project-overview.md §10`, which currently omits it.) |
| Negative trust_weight on NULL/empty `source_types` | `facilities` (analytics layer) | `SIZE(SPLIT(NULL,','))` returns -1 in Spark, so `COALESCE(...,1)` never fires → `trust_weight = -0.333`; pollutes heatmap, supply/gap scores, capability summary | **OPEN** — verify on warehouse (Section 13); apply the canonical fix in §6.1 |
| State-name mismatch in gap-score join | `facilities.address_stateorregion` vs NFHS `state_ut` | `FULL OUTER JOIN` on `LOWER(TRIM(state))` leaves mismatched spellings (e.g. "NCT of Delhi" vs "Delhi") unmatched → split rows, inflated/missing gap scores; same root cause as Overview-vs-Facilities state-count divergence (§6.3) | **BLOCKED** — needs a canonicalization decision + crosswalk (see §6.3) |
| Heatmap silently drops out-of-box coordinates | `facilities` (analytics layer) | Facilities outside `lat 6–37.5 / lon 68–97.5` never appear on the heatmap, regardless of validity | **ACCEPTED** — by design; document so "facility locations" is not read as "all facilities" |
| SQL injection via string interpolation | Server API routes | User-supplied `search`/`state`/`capability` are interpolated into SQL **after single-quote escaping** (`.replace(/'/g, "''")`), not via bound/parameterized queries. Mitigates basic quote-breakout but is not equivalent to parameterization and is easy to forget on new routes. | **ACCEPTED (partial)** — migration to parameterized queries still recommended |
| In-memory cache for Desert endpoints | Express server | Cache lost on app restart; no cross-instance sharing. Keys: `heatmap-points:<capability>`, `state-gaps:<capability>`, `capability-summary` (5-min TTL) | **ACCEPTED** — fine for hackathon scope |
| Lakebase plugin not loaded / sample routes orphaned | Express server / Lakebase | `createApp` registers only `analytics` + `server`; `appkit.lakebase` is unavailable at runtime. `setupSampleLakebaseRoutes` (`todo-routes.ts`) is never imported, and `LakebasePage.tsx` is unrouted. No live Postgres consumer exists. | **ACCEPTED** — by design for now; wiring required before any Lakebase read/write works |

---

## 12. Resource Reference

| Resource | Value |
|---|---|
| Source catalog | `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset` |
| Working catalog/schema | `dais27hack.virtue_foundation_dataset_silver` |
| SQL Warehouse ID | `5b2b29cce22aa2c4` (supplied to the app via DABs variable `warehouse_id` → app resource binding `sql-warehouse`; `app.yaml` reads it as env `DATABRICKS_WAREHOUSE_ID` with `valueFrom: sql-warehouse`) |
| Workspace URL | `https://dbc-0a01f518-764a.cloud.databricks.com` |
| Lakebase project | `virtue-health` |
| Lakebase endpoint | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` (env: `PGHOST` / `LAKEBASE_ENDPOINT`; placeholders in `.env.example`) |
| Lakebase UC catalog | `virtue-pg` (backtick-quote in SQL: `` `virtue-pg` ``) |
| Lakebase Postgres database | `databricks_postgres` |
| Lakebase schema (in Postgres) | `virtue_foundation_dataset_silver` |
| App Service Principal client ID | `5ccf106a-7211-489d-a075-5ca82e07b0ae` |
| DABs bundle / app name | bundle `virtue-health`; app resource key `app` with `name: "virtue-health"` |
| DABs `sync.include` | `dist/` **and** `client/dist/` (both entries — ships the built server bundle and client assets; do not drop `client/dist/`) |
| Databricks CLI profile | `deepak-workspace` |

Relevant source files (use the named function/anchor, not line numbers): `server/server.ts` (plugin registration — `lakebase` NOT loaded, only `analytics` + `server`; `onPluginsReady` calls only `setupVirtueHealthRoutes`), `server/routes/virtue-health-routes.ts` (all formulas and read paths — the facilities/heatmap SELECTs project `facility_id`, not `unique_id`; search by the SQL snippets quoted in Section 6), `client/src/pages/facilities/FacilitiesPage.tsx` and `client/src/pages/desert/types.ts` (both declare the response field `facility_id: number`), `server/routes/lakebase/todo-routes.ts` (orphaned sample, `setupSampleLakebaseRoutes` never imported), `client/src/pages/lakebase/LakebasePage.tsx` (orphaned, unrouted), `databricks.yml` (warehouse variable + app resource binding; `sync.include` = `dist/` + `client/dist/`), `app.yaml` (`valueFrom: sql-warehouse`), `.env.example` (placeholder Postgres/`PG*` connection env vars).

---

## 13. Open Verification Tasks

These two questions are empirically answerable in under a minute against warehouse `5b2b29cce22aa2c4`. Until they are answered, the conditional hedging in Sections 6.1, 6.4, and 11 stands. Record the result here and then delete the corresponding hedges across all docs.

| # | Question | Query to run | Owner | Opened | Result |
|---|---|---|---|---|---|
| V-1 | Does `SIZE(SPLIT(NULL, ','))` return `-1` on this warehouse (confirming the negative-trust-weight bug)? | `SELECT SIZE(SPLIT(NULLIF(TRIM(CAST(NULL AS STRING)), ''), ','));` | TBD | 2026-06-15 | `____` |
| V-2 | What is the stored type of `facilities.latitude` / `facilities.longitude` (DOUBLE → casts are defensive; STRING → casts are load-bearing)? | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | TBD | 2026-06-15 | `____` |

On resolution of **V-1**, apply the canonical fix in §6.1 (or the documented `GREATEST(..., 0.0)` alternative) and update any `[0,1]` assertions. On resolution of **V-2**, either confirm the cast as defensive or as required, and correct any doc claiming `facilities` lat/lon "does not require casting."

> The synced-table **DDL keyword** verification (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`) is tracked canonically at `runbook.md §12 OV-3`, not here; the §10 reset template and `runbook.md §4.1` both standardize on `CREATE ONLINE TABLE` until that task resolves.
