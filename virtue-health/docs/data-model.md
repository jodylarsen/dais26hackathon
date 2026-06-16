I'll rewrite the data-model.md document, incorporating the relevant adversarial review findings. The findings relevant to this document are: Finding 1 (downgrade V3, confirm `facility_id` is the API response field), Finding 4 (status vocabulary cross-reference), Finding 5 (DDL keyword verification cross-link), Finding 6 (P-TC-03 not P-TC-01), Finding 7 (canonical formula home), Finding 8 (Known-Issues numbering collision), Finding 9 (null bytes not in canonical list), and Finding 10 (RESOLVED → PARTIALLY RESOLVED).

# Virtue Health — Data Model

## Glossary (acronyms used in this document)

| Term | Expansion |
|---|---|
| CDF | Change Data Feed (Delta) |
| DLT | Delta Live Tables |
| OLTP | Online Transaction Processing |
| NFHS-5 | National Family Health Survey, Round 5 |
| PK | Primary Key |
| TTL | Time To Live (cache) |

> **SQL identifier rule — `virtue-pg` must be backtick-quoted.** The Lakebase Unity Catalog catalog is named `virtue-pg` (with a **hyphen**). Because a hyphen is not legal in a bare SQL identifier, it **must** be backtick-quoted in all SQL/DDL: `` `virtue-pg` ``. Unquoted `virtue-pg` is a syntax error, and `virtue_pg` (underscore) is simply the wrong catalog name.

> **Terminology — "synced table" = "online table."** Databricks calls these **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables ...`). They are the same object. This document uses "synced table" in prose and the CLI's `online-tables` noun in commands.

> **Cross-document conventions:**
> - **Canonical formula home:** The trust-weight, demand-index, and gap-score formula definitions in this document (`data-model.md`) are the **single canonical source**. `architecture.md §7` and `data-pipeline.md §6` point here; `project-overview.md §5.4` summarizes but defers here. Do not re-derive them elsewhere.
> - **Canonical Known-Issues numbering:** `project-overview.md §10` is the **authoritative numbered Known-Issues list (#1–#15)**. The "Known Data Quality Issues" section below uses a **local** numbering for readability but cites the canonical project-overview number in each heading. Do not treat this document's local "#1/#2/…" as the project-wide numbers — they collide with project-overview's different issues.
> - **Synced-table status vocabulary:** `data-pipeline.md` owns the canonical status vocabulary (`ONLINE` / `BLOCKED-quota` / `BLOCKED-dup-pk`). This document uses those exact tokens and cross-references it rather than coining "PENDING."

---

## Overview

Virtue Health operates on a two-tier data architecture: a read-only source layer of Delta tables cloned from the upstream hackathon dataset, and a mutable live layer that supports application writes and propagates changes downstream to a Lakebase Postgres instance via CDF. All tables reside in the Unity Catalog schema `dais27hack.virtue_foundation_dataset_silver` on the workspace `dbc-0a01f518-764a.cloud.databricks.com`.

> **Read-path note (important):** Although the Lakebase synced-table pipeline described in this document exists in the data layer, **all production API endpoints currently read from the Databricks SQL Warehouse (`5b2b29cce22aa2c4`) via `appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver`.** No application endpoint reads facilities, districts, or desert data from Lakebase.
>
> **The API reads the plain source tables, not `_live`.** Verified: the `/api/summary`, `/api/facilities`, and Desert endpoints all `SELECT ... FROM dais27hack.virtue_foundation_dataset_silver.facilities` (the **plain** table), not `facilities_live`. This matters for data quality: null-byte remediation and any future enrichment land in `_live`, but the read path serves the un-remediated source table (see Known Issue, Null Bytes, below).
>
> **No Lakebase code is active at all.** Verified in `server/server.ts`: `createApp` loads only `analytics({})` and `server()`, and `onPluginsReady` invokes only `setupVirtueHealthRoutes`. The `lakebase` plugin is **not** registered, so the `appkit.lakebase` helper does not exist at runtime. The Lakebase OLTP read path for facilities/districts is therefore **aspirational, not implemented**. To make any Lakebase route functional you would need to (a) add the `lakebase` plugin to `createApp`, (b) wire a Lakebase route handler in `onPluginsReady`, and (c) register the route/nav entry in the client router.

---

## Source Catalog and Schema

| Property | Value |
|---|---|
| Unity Catalog | `dais27hack` |
| Schema | `virtue_foundation_dataset_silver` |
| Upstream source | `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset` |
| Workspace | `https://dbc-0a01f518-764a.cloud.databricks.com` |

Tables were cloned (not linked) from the upstream catalog so that the application schema can evolve independently of the hackathon-provided source, and so that CDF and Lakebase synced tables can be applied without modifying upstream data.

---

## Open Verification Tasks

These questions are empirically answerable in under a minute against warehouse `5b2b29cce22aa2c4`. They are tracked here as actionable open tasks rather than restated as conditional hedging throughout the document. On resolution, record the result and delete the corresponding caveat.

| # | Open task | Exact check | Result |
|---|---|---|---|
| V1 | Confirm the physical type of `facilities.latitude` / `longitude` (DOUBLE vs STRING). The heatmap query applies `CAST(... AS DOUBLE)` defensively. | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | `____` (opened 2026-06-15, owner TBD) |
| V2 | Confirm whether `SIZE(SPLIT(NULL, ','))` returns `-1` on this warehouse (drives the negative-trust-weight bug). | `SELECT SIZE(SPLIT(CAST(NULL AS STRING), ','));` | `____` (opened 2026-06-15, owner TBD) |
| V3 | Confirm the **physical** PK column name of `facilities`: is the physical column `unique_id` (string, per upstream context) or `facility_id` (numeric, per shipped queries)? See "PK column-name discrepancy" below. **Note: the *API response field* is already resolved (`facility_id: number`); V3 is only about the physical column.** | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | `____` (opened 2026-06-15, owner TBD) |

> **DDL-keyword verification (canonical owner `runbook.md §12 OV-3`):** Whether the verified synced-table DDL keyword is `CREATE ONLINE TABLE` or `CREATE SYNCED TABLE` is tracked as an open task in `runbook.md §12 OV-3`. Every "TEMPLATE — verify syntax" callout in this document defers to that task; do not duplicate it as a separate V-task here.

---

## Source Tables (Read-Only)

These three tables are the canonical, read-only representations of the upstream data. Application code queries them via the Databricks SQL Warehouse (`5b2b29cce22aa2c4`) using `appkit.analytics.query()`. They are not written to by the application.

> **Projection note:** The columns listed below are the *physical schema* of each table. They are **not** the columns returned by the API. Most endpoints project a narrow subset (see each table's "Columns returned by the API" note and the API reference for full response shapes).

### 1. `facilities`

Represents 10,088 healthcare facilities across India.

| Column | Type | Notes |
|---|---|---|
| `unique_id` | string | Intended PK per upstream context — has duplicate values (see Known Issues). **But the shipped API projects a column named `facility_id`, not `unique_id` — see PK column-name discrepancy below.** |
| `name` | string | Facility name; contained null bytes (0x00) — cleaned in `_live` only |
| `organization_type` | string | Type of organization |
| `capability` | string | Care capability category (used in Desert Planner queries) |
| `specialties` | string | Comma-separated specialty list |
| `equipment` | string | Equipment available at facility |
| `procedure` | string | Procedures available |
| `source_types` | string | Comma-separated list of data sources contributing this record |
| `source_ids` | string | Identifiers from contributing sources |
| `address_city` | string | City |
| `address_stateorregion` | string | State or region — used as the primary geographic partition in all queries |
| `address_country` | string | Country |
| `latitude` | double | Geographic latitude — type unverified, see Open Verification Task V1 |
| `longitude` | double | Geographic longitude — type unverified, see Open Verification Task V1 |
| `description` | string | Facility description; contained null bytes (0x00) — cleaned in `_live` only |
| `cluster_id` | string | Cluster assignment (origin unknown; not used in current queries) |
| `source_urls` | string | URLs for contributing data sources |

**Columns returned by the API:** The `/api/facilities` endpoint returns **only** `facility_id, name, organization_type, address_city, address_stateorregion, address_country` (in the `/api/facilities` handler — search for `facility_id, name, organization_type`). It does **not** return `capability`, `specialties`, `equipment`, `procedure`, `source_types`, `source_ids`, `latitude`, `longitude`, `description`, `cluster_id`, or `source_urls`. (The Desert Planner endpoints return `latitude`/`longitude`/`capability`/`trust_weight` separately — see Trust Weight and the API reference.)

**PK column-name discrepancy (`unique_id` physical vs `facility_id` API field) — API field RESOLVED; physical column is Open Verification Task V3:** The upstream project context describes the facilities PK as `unique_id` (a string with duplicate values). However, **the API response field is `facility_id` (numeric), and this is settled, not open.** The shipped TypeScript client interfaces are authoritative for the response shape and both type it numeric: `HeatmapPoint.facility_id: number` (`client/src/pages/desert/types.ts`) and the `Facility` interface in `client/src/pages/facilities/FacilitiesPage.tsx` (`facility_id: number`). The server handlers `SELECT facility_id` (no `AS` alias) in both `/api/facilities` and `/api/desert/heatmap-points`. **The only remaining open question (V3) is whether the *physical column* is also literally named `facility_id` or whether `facility_id` is produced some other way:**

- If the physical column is named `facility_id`, then the project-context "`unique_id`" PK label and every "`unique_id`" reference in the broader doc set is mislabeled — the schema row above should read `facility_id`.
- If the physical column is named `unique_id`, then the shipped queries (`SELECT facility_id` with no alias) would be selecting a non-existent column and would be broken — which they are not, in shipped code — so this case is unlikely. Resolve V3 with `DESCRIBE` to settle the schema table above.

In all cases, documents describing the **API response** (`api-reference.md`, `architecture.md`, `project-overview.md`, `runbook.md`, and the `test-plan.md` row-key assertions) must use `facility_id: number`, not `unique_id: string`.

**Latitude/longitude casting:** The heatmap query applies `CAST(latitude AS DOUBLE)` / `CAST(longitude AS DOUBLE)` (in the `/api/desert/heatmap-points` handler — search for `CAST(latitude AS DOUBLE)`). If the columns are truly `DOUBLE`, this cast is defensive/redundant; if not, this table's type entries must be corrected. Type unverified — see Open Verification Task V1.

**Primary Key Design:** The intended primary key (named `unique_id` per upstream context, but see V3) contains duplicate values in the upstream data. This is a blocking issue for Lakebase synced table creation (see Known Issues). No composite-key alternative has been defined.

---

### 2. `nfhs_5_district_health_indicators`

Represents 706 district-level health indicator records from NFHS-5.

| Column | Type | Notes |
|---|---|---|
| `district_name` | string | Part of composite PK |
| `state_ut` | string | State or Union Territory — part of composite PK |
| *(~100 additional indicator columns)* | numeric/string | Immunization rates, maternal-health metrics, nutrition indicators, anemia prevalence, blood-pressure statistics, water/sanitation coverage, civil registration, sex ratio, and others |

**Columns returned by `/api/districts`:** The endpoint returns **only** seven columns: `district_name, state_ut, households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct` (in the `/api/districts` handler). It does **not** return immunization, maternal-health, anemia, or blood-pressure columns despite those existing in the physical table. The response is an object: `{ districts: DistrictIndicator[], syncing?: boolean }`.

**Columns used by the Desert Planner:** State-level `demand_index` is derived from four of these columns — `hh_electricity_pct`, `hh_improved_water_pct`, `hh_use_improved_sanitation_pct`, and `child_u5_whose_birth_was_civil_reg_pct` (see Demand Index and Gap Score below). `sex_ratio_total_f_per_1000_m` feeds the `/api/summary` `avgSexRatio` KPI.

**Primary Key Design:** Composite key of `(district_name, state_ut)`. Neither column alone is unique because district names repeat across states. The composite key is assumed unique in the upstream data. Consequently, `COUNT(DISTINCT district_name)` is **strictly less than 706** (the `/api/summary` `districtsCovered` value), because the same district name appears in multiple states — any documentation example asserting `districtsCovered == 706` is internally inconsistent with this composite-key design.

> **State universe note:** `state_ut` (NFHS-5) is a **different** set of values from `address_stateorregion` (facilities). The Overview-page "States Covered" KPI (`/api/summary.statesCovered`) counts `COUNT(DISTINCT state_ut)` from NFHS-5, whereas the Facilities-page state filter (`/api/facilities/states`) lists distinct `address_stateorregion` from facilities. These two universes do not necessarily coincide — this is the same state-name mismatch tracked as the state-name Known Issue below.

---

### 3. `india_post_pincode_directory`

Represents 165,627 records from the India Post pincode directory, providing geographic coverage data at the post-office level.

| Column | Type | Notes |
|---|---|---|
| `officename` | string | Part of composite PK |
| `pincode` | bigint | Part of composite PK |
| `statename` | string | Part of composite PK |
| `circlename` | string | Postal circle name |
| `regionname` | string | Postal region name |
| `divisionname` | string | Postal division name |
| `officetype` | string | Type of post office |
| `delivery` | string | Delivery classification |
| `district` | string | District name |
| `latitude` | **string** | Geographic latitude stored as STRING — requires explicit CAST for geographic queries (see Type Mapping) |
| `longitude` | **string** | Geographic longitude stored as STRING — requires explicit CAST for geographic queries |

**Primary Key Design:** Composite key of `(officename, pincode, statename)`. A single post-office name may exist in multiple pincodes or states; the three-column composite covers known duplication patterns in the India Post dataset.

**Type Anomaly — latitude/longitude:** This table stores both `latitude` and `longitude` as `STRING`. Any geographic computation (distance calculations, bounding-box filters, heatmap aggregations) must cast these columns: `CAST(latitude AS DOUBLE)`. Failure to cast will cause silent type errors or query failures. This is a known issue carried forward from the upstream data. No current API endpoint queries this table.

---

## Live Tables (`_live` Pattern)

For each source table there is a corresponding live variant in the same schema:

| Source Table | Live Table |
|---|---|
| `facilities` | `facilities_live` |
| `nfhs_5_district_health_indicators` | `nfhs_5_district_health_indicators_live` |
| `india_post_pincode_directory` | `india_post_pincode_directory_live` |

### Purpose

The `_live` tables exist to separate read-only source data from mutable application state. The source tables are treated as immutable snapshots from the upstream hackathon dataset. Application writes — corrections, enrichments, or user-driven updates — target the `_live` tables. This pattern:

- Preserves the upstream source for reproducibility and auditability.
- Prevents application logic from corrupting the base dataset.
- Enables CDF (see below) on the mutable layer without requiring CDF on the upstream clones.

> **Current read reality:** Despite the `_live`/CDF/Lakebase design, the shipped API endpoints read from the **read-only source tables** via the SQL Warehouse, not from `_live` tables or Lakebase. The `_live` layer is provisioned for the eventual write/sync path but is not on the current read path. A direct consequence: data-quality fixes applied only in `_live` (e.g., null-byte stripping) are **not** reflected in API responses. (And as noted in the Overview, no Lakebase plugin is loaded, so even the sync target is not reachable from the app today.)

### Seeding Procedure (canonical order)

> **Canonical order — single source of truth for this project: disable CDF → TRUNCATE → INSERT → re-enable CDF.** TRUNCATE must occur **while CDF is disabled**, otherwise the TRUNCATE is logged as delete events and the seed history is not clean. This ordering is authoritative; any operational runbook or test that disagrees (e.g., a "TRUNCATE first, then disable CDF" sequence) must be reconciled to this order.

1. `ALTER TABLE <live_table> SET TBLPROPERTIES ('delta.enableChangeDataFeed' = false)` — disable CDF first, so neither the TRUNCATE nor the bulk insert generates change events.
2. `TRUNCATE TABLE <live_table>` — clears existing rows while CDF is off (no delete events recorded).
3. `INSERT INTO <live_table> SELECT ... FROM <source_table>` — copies source data. **For `facilities_live`, do NOT use `SELECT *`** — use an explicit column list that applies the null-byte stripping `REPLACE(...)` to `name` and `description` (see Known Issues, Null Bytes).
4. `ALTER TABLE <live_table> SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true)` — re-enable CDF, establishing a clean starting version *after* the seed.

> **Reload caveat:** Any operational "reload"/re-seed must follow this same order. Re-enabling CDF *before* the insert, or running TRUNCATE while CDF is enabled, causes seed/delete operations to be logged as CDF events, defeating the purpose of the pattern. For `facilities_live`, re-seeding with `SELECT *` re-introduces null bytes and breaks the Postgres sync. The corresponding pipeline test that asserts a clean (zero-event) CDF log after seeding is **`test-plan.md` P-TC-03** (the zero-CDF-events assertion); P-TC-01 is the separate row-count check (`COUNT(*) = 10,088`). Cite **P-TC-03** — not P-TC-01 — for the zero-event expectation.

---

## Change Data Feed (CDF)

CDF is enabled on all three `_live` tables using:

```sql
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.<table>_live
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

CDF records row-level insert, update, and delete operations as versioned change events in the Delta log. The Lakebase synced-table pipeline reads these change events in TRIGGERED mode to replicate mutations from Delta into Postgres. Without CDF, the synced-table mechanism cannot detect incremental changes and would require full-table scans to synchronize, which is impractical at production scale.

---

## Lakebase Postgres Synced Table Pipeline

> **Reachability caveat:** This entire pipeline is data-layer infrastructure that the **application does not currently consume**. The `lakebase` plugin is not loaded in `server/server.ts`, so no app code path reads from Lakebase. The sections below describe the provisioned data infrastructure, not a live application read path.

### Lakebase Project Configuration

| Property | Value |
|---|---|
| Lakebase project name | `virtue-health` |
| Unity Catalog catalog | `virtue-pg` (backtick-quote in SQL — see identifier rule at top) |
| Postgres database | `databricks_postgres` |
| Postgres schema | `virtue_foundation_dataset_silver` |
| Endpoint | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` |

The Lakebase project was deleted and recreated during troubleshooting; the current project is the second instance named `virtue-health`. The full addressing hierarchy has **four levels** and must be used consistently: UC catalog `` `virtue-pg` `` → Postgres database `databricks_postgres` → schema `virtue_foundation_dataset_silver` → table. Do not omit the `databricks_postgres` database level.

#### Finding the endpoint (Lakebase branch)

The endpoint is obtained per Lakebase **branch**. To find the branch name first, list branches for the project, then list that branch's endpoints:

```bash
# 1. List branches for the project
databricks postgres list-branches --project virtue-health --profile deepak-workspace

# 2. Pass the chosen branch name/ID to list its endpoints
databricks postgres list-endpoints <branch-name> --profile deepak-workspace
```

> The exact subcommand names are Lakebase-/CLI-version-specific. If `list-branches` / `list-endpoints` are not present, confirm against `databricks postgres --help` for your CLI version. Do not run a command with a literal unresolved `<branch-name>` placeholder.

### Sync Mode: TRIGGERED

All synced tables use TRIGGERED scheduling rather than CONTINUOUS mode. In TRIGGERED mode, the pipeline is invoked on demand or on a schedule rather than running as a persistent streaming job. This is appropriate for a hackathon application where near-real-time replication is not required and where workspace quota constraints (see below) make continuous pipelines impractical.

### Synced Table DDL (template — verify before use)

> **Synced-table DDL is Lakebase-version-specific and has NOT been verified against this workspace.** Before running any `CREATE ... TABLE` here, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version), and see the keyword-verification task at **`runbook.md §12 OV-3`** (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`). The form below is a **template**, not a known-good command. Use this identical template everywhere a synced-table DDL appears across the documentation set.

```sql
-- TEMPLATE — verify syntax before use (see runbook.md §12 OV-3). Note the four-level, backticked path.
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table>
  PRIMARY KEY (...)
  FROM dais27hack.virtue_foundation_dataset_silver.<table>_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

### Synced Table Status

> **Status vocabulary is owned by `data-pipeline.md`.** The tokens below (`ONLINE`, `BLOCKED-quota`, `BLOCKED-dup-pk`) are the canonical synced-table status set defined there. This document does not coin "PENDING"; cross-reference `data-pipeline.md` for the authoritative state of each table.

| Delta source (`_live`) | Postgres target | Status |
|---|---|---|
| `nfhs_5_district_health_indicators_live` | `` `virtue-pg` ``.`databricks_postgres`.`virtue_foundation_dataset_silver`.`nfhs_5_district_health_indicators` | `ONLINE` |
| `india_post_pincode_directory_live` | …`.india_post_pincode_directory` | `BLOCKED-quota` |
| `facilities_live` | …`.facilities` | `BLOCKED-quota` + `BLOCKED-dup-pk` (duplicate PK Known Issue) |

> Even though `nfhs_5_district_health_indicators` is `ONLINE` in Lakebase, the `/api/districts` endpoint still reads from the SQL Warehouse source table, not from Lakebase. (Nor could it read from Lakebase today: the `lakebase` plugin is not registered.)

### Quota Constraint: Sequential Creation

The Databricks workspace enforces a quota of **1 concurrent `DATABASE_TABLE_SYNC` pipeline**. Synced tables cannot be created or initialized in parallel; each must reach `ONLINE` status before the next can be started. This is a hard workspace-level limit, not a configurable setting. The creation order was:

1. `nfhs_5_district_health_indicators_live` — created first; currently `ONLINE`.
2. `india_post_pincode_directory_live` — creation `BLOCKED-quota` (awaiting quota availability).
3. `facilities_live` — creation `BLOCKED-quota` + `BLOCKED-dup-pk` (also blocked by the duplicate-PK issue).

### Delta-to-Postgres Type Mapping

These mappings apply when synced tables replicate Delta columns into Postgres. Where the upstream Delta type is anomalous (e.g., `latitude` as STRING in `india_post_pincode_directory`), the Postgres column inherits the anomalous type unless the live-table schema is explicitly altered before sync.

| Delta Type | Postgres Type | Notes |
|---|---|---|
| `string` | `text` | Default string mapping |
| `double` | `double precision` | Used for `facilities.latitude`, `facilities.longitude` (pending V1) |
| `bigint` | `bigint` | Used for `india_post_pincode_directory.pincode` |
| `string` (latitude/longitude in `india_post_pincode_directory`) | `text` | Anomalous — application must CAST on read |

Mappings for the ~100 numeric indicator columns in `nfhs_5_district_health_indicators` are not individually documented; they depend on the upstream Delta schema and should be verified post-sync.

---

## Known Data Quality Issues

> **Numbering note:** The local `#1/#2/…` below is for in-document readability **only** and does **not** correspond to the canonical numbers in `project-overview.md §10` (the authoritative list). Each heading cites the canonical project-overview number where one exists. Do not cross-reference this document's local numbers from other documents — cite the project-overview canonical number instead.

> **Status legend (applies to every row):** **OPEN** = needs work, no decision; **PARTIALLY RESOLVED** = fixed in one location but not on the read path; **ACCEPTED** = known and intentionally not fixing (rationale documented); **BLOCKED** = needs an external/upstream/quota fix; **RESOLVED** = fixed everywhere it matters.

### Local #1 — Null Bytes in `facilities.name` and `facilities.description` — PARTIALLY RESOLVED (canonical: add to `project-overview.md §10`)

The upstream `facilities` table contains null-byte characters (`0x00`, U+0000) embedded in the `name` and `description` string columns. Postgres rejects rows containing null bytes in `text` columns, which would cause the Lakebase synced-table pipeline to fail on insert.

**Status — PARTIALLY RESOLVED, not RESOLVED.** The fix is applied to `facilities_live` only. **The production API reads the plain `facilities` table (see Overview read-path note), which still contains null bytes** — so API responses can still serve null-byte-corrupted `name`/`description` values. The issue is remediated on the *sync* path but **not** on the current *read* path.

> **Canonical-list gap:** `project-overview.md §10` (the authoritative Known-Issues list) currently has **no row** for null bytes. Add one — e.g., *"Null bytes in `facilities.name`/`description` — stripped in `facilities_live` only; the plain `facilities` table, which the API reads, still contains them. Status: OPEN/PARTIALLY RESOLVED (remediated in `_live`, not on the read path)."* — and have this document and `data-pipeline.md` cite that canonical number rather than local numbering. `data-pipeline.md §11` already marks this issue OPEN for the same read-path reason; reconcile both docs to the single canonical status above (do not leave one doc claiming "RESOLVED").

**Fix applied to `facilities_live`:**

```sql
REPLACE(name, CAST(CHAR(0) AS STRING), '')
REPLACE(description, CAST(CHAR(0) AS STRING), '')
```

Applied when populating `facilities_live` from source. The source table is not modified. Any future re-seeding of `facilities_live` must reapply this transformation via an explicit column list — `SELECT *` re-introduces the null bytes.

### Local #2 — Duplicate PK Values in `facilities` — BLOCKED (upstream) — canonical: `project-overview.md §10 #2`

The intended primary-key column in `facilities` (named `unique_id` per upstream context; physical name pending V3 / see PK column-name discrepancy) contains duplicate values.

**Impact:**
- Lakebase synced-table creation for `facilities_live` is blocked (`BLOCKED-dup-pk`). Synced tables require a uniquely identifying key to track row-level changes from CDF; a non-unique key fails the pipeline at initialization.
- The `/api/facilities` endpoint returns results without deduplication, so duplicate facilities may appear in search results.
- No composite-key alternative has been identified or implemented.

**Resolution path:** The upstream dataset maintainer must correct the duplicates, or a surrogate key (a monotonically increasing row ID or a multi-column hash) must be introduced in the `_live` table before synced-table creation can proceed.

### Local #3 — State-Name Mismatch Between `facilities` and NFHS-5 — OPEN (largest Track 2 correctness risk) — canonical: `project-overview.md §10` state-join issue

The Desert Planner's state-level aggregation joins facilities (`address_stateorregion`) to NFHS-5 (`state_ut`) on a normalized key `LOWER(TRIM(state))` via a **`FULL OUTER JOIN`** (in the `/api/desert/state-gaps` handler — search for `FULL OUTER JOIN facility_state`; see Gap Score below). Because the two sources use independent state-name vocabularies, normalizing case/whitespace alone does **not** reconcile semantic mismatches — e.g., "NCT of Delhi" vs. "Delhi", or differing spellings/abbreviations. Mismatched states produce unmatched rows on one side of the FULL OUTER JOIN, which can yield states with a `demand_index` but zero `facility_count` (inflated gap), or states with facilities but no NFHS demand (handled by a default-50 fallback). This is the single largest correctness risk in Track 2 and is currently unmitigated.

This same vocabulary divergence is why the Overview "States Covered" KPI (NFHS `state_ut`) and the Facilities-page state filter (`address_stateorregion`) draw from different state universes (see the state-universe note under `nfhs_5_district_health_indicators`).

**Example remediation — normalize both sides with a crosswalk before joining.** First run a diagnostic (an `EXCEPT` or anti-join of the two normalized state-key sets) to enumerate the actual mismatches in *this* dataset, then populate the crosswalk:

```sql
-- minimal crosswalk; the WHEN values below are ILLUSTRATIVE and must be
-- verified against the diagnostic before use.
CASE LOWER(TRIM(state))
  WHEN 'nct of delhi' THEN 'delhi'
  WHEN 'orissa'       THEN 'odisha'
  WHEN 'pondicherry'  THEN 'puducherry'
  ELSE LOWER(TRIM(state))
END AS state_key
```

### Local #4 — `SIZE(SPLIT(NULL, ','))` Edge Case in Trust Weight — Possible Negative Weight — OPEN (see V2) — canonical: `project-overview.md §10` trust-weight issue

The trust-weight formula relies on `COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1)` to default NULL/empty `source_types` to a count of 1. **This COALESCE may not fire as intended.** In Spark SQL, `SIZE(SPLIT(NULL, ','))` returns **`-1`** (not NULL), so `COALESCE(-1, 1)` returns `-1`, not `1`. If that behavior holds on the warehouse, a NULL/empty `source_types` value yields `LEAST(-1 / 3.0, 1.0) = -0.333` — a **negative** trust weight — rather than the intended `0.333`.

Verify empirically (Open Verification Task V2). If confirmed, apply the recommended fix below.

**Recommended fix (NULL `source_types` → intended `0.333`):**

```sql
LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
```

> Do **not** instead "clamp the result with `GREATEST(..., 0.0)`" unless you intend NULL `source_types` to score **0**, not `0.333`. The two fixes have **different semantics**: the recommended fix restores a NULL/empty facility to the intended single-source score of `0.333`; a `GREATEST(..., 0.0)` floor would leave it at `0`. Pick the semantics you want and document the choice. Until V2 is resolved, treat the "NULL → 0.333" claim as *intended*, not confirmed.

---

## Trust Weight Formula

> **Canonical home:** This is the single canonical definition of trust weight. `architecture.md §7` and `data-pipeline.md §6` defer here; `project-overview.md §5.4` should summarize and point here, not redefine.

The Desert Planner (Track 2) assigns a trust weight to each facility based on the number of distinct data sources contributing to its record, derived from the comma-separated `source_types` column. The same expression appears in the heatmap-points, state-gaps, and capability-summary queries.

**Formula (Databricks SQL):**

```sql
LEAST(
  COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0,
  1.0
) AS trust_weight
```

**Interpretation (intended behavior — see Known Issue Local #4 for the NULL caveat):**

| `source_types` value | Parsed source count | Raw score | Clamped `trust_weight` |
|---|---|---|---|
| NULL or empty/whitespace string | *intended* 1 — but see Known Issue Local #4 (may evaluate to -1 → -0.333) | 0.333 *(intended)* | 0.333 *(intended; possibly -0.333)* |
| Single source (e.g., `"nhsrc"`) | 1 | 0.333 | 0.333 |
| Two sources | 2 | 0.667 | 0.667 |
| Three or more sources | 3+ | ≥ 1.0 | **1.0** (clamped) |

- `NULLIF(TRIM(source_types), '')` converts empty/whitespace-only strings to NULL before splitting.
- `COALESCE(..., 1)` is *intended* to treat NULL `source_types` as a single-source facility — but because `SIZE(SPLIT(NULL, ','))` returns `-1` (non-null) in Spark, this COALESCE does **not** fire for NULL input (Known Issue Local #4).
- Division by `3.0` normalizes the score so that three or more corroborating sources equals full trust.
- `LEAST(..., 1.0)` caps the weight at 1.0 (it does **not** floor at 0, so a negative intermediate value is not clamped up).

---

## Demand Index Formula

> **Canonical home:** This is the single canonical definition of the demand index. Other documents defer here.

The Desert Planner derives a state-level `demand_index` from NFHS-5 access/coverage indicators.

> **Naming:** The **field** is `demand_index` (the name in code and JSON responses); the **concept** is "deprivation-based demand." They are the same number. It is computed as the average of four `(100 − coverage%)` terms — higher = more deprivation = more unmet demand.

**Formula (Databricks SQL, per state):**

```sql
ROUND(
  (
      (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
    + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
    + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
    + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
  ) / 4.0,
  1
) AS demand_index
```

- The four source columns are `hh_electricity_pct`, `hh_improved_water_pct`, `hh_use_improved_sanitation_pct`, and `child_u5_whose_birth_was_civil_reg_pct`, averaged across all districts in a state.
- Each `AVG(...)` is wrapped in `COALESCE(..., 50)`, so a state with a fully-null indicator contributes a neutral 50% coverage (50 deprivation) for that component.
- The result is rounded to one decimal place.

---

## Gap Score Formula

> **Canonical home:** This is the single canonical definition of the gap score. Other documents defer here.

The state-level gap score combines NFHS-5 demand (deprivation-based) with facility supply (count weighted by trust). It is computed over a **`FULL OUTER JOIN`** of NFHS states and facility states on a normalized state key (`LOWER(TRIM(...))`), so a state present in only one source still appears in the output (see Known Issue Local #3).

**Supply score (per state):**

```sql
facility_count * avg_trust_weight / 10.0
```

**Gap score (per state):**

```sql
ROUND(
  COALESCE(ns.demand_index, 50) /
  GREATEST(
    COALESCE(fs.facility_count, 0) * COALESCE(fs.avg_trust_weight, 0.0) / 10.0,
    0.1
  ),
  2
) AS gap_score
```

- **Numerator:** `COALESCE(demand_index, 50)` — a state with no matching NFHS demand row (unmatched in the FULL OUTER JOIN) defaults to a demand of **50**, not NULL.
- **Denominator:** the supply score, floored at `0.1` via `GREATEST(..., 0.1)` to prevent division by zero in states with zero matching facilities.
- A higher `avg_trust_weight` per state increases the effective supply denominator, reducing the gap score. States with many low-trust (single-source) facilities appear more underserved than states with the same raw facility count but higher data corroboration.
- Results are ordered `gap_score DESC NULLS LAST`.

### `/api/desert/state-gaps` Response Fields

Each row returned by the endpoint (response shape: `{ gaps: StateGap[], syncing?: boolean }`) carries the full computed field set, not just the gap score:

| Field | Source |
|---|---|
| `state` | `COALESCE(ns.state_ut, fs.address_stateorregion)` |
| `facility_count` | `COALESCE(fs.facility_count, 0)` |
| `avg_trust_weight` | `ROUND(COALESCE(fs.avg_trust_weight, 0), 3)` |
| `source_type_variants` | `COUNT(DISTINCT source_types)` per state |
| `demand_index` | `ns.demand_index` (nullable) |
| `district_count` | `COUNT(DISTINCT district_name)` per NFHS state (nullable) |
| `supply_score` | `facility_count * avg_trust_weight / 10.0` |
| `gap_score` | formula above |
| `confidence` | computed in TypeScript: `variants >= 3 → 'high'`, `>= 1 → 'medium'`, else `'low'` |

(`client/src/pages/desert/types.ts` is the authoritative interface reference. On the `StateGap` interface, `demand_index` and `district_count` are typed `number | null`, while `confidence` is the required union `'high' | 'medium' | 'low'`.)

---

## Desert Planner Endpoint Behavior (Data-Layer Notes)

These endpoints query the SQL Warehouse and cache results in an in-memory `Map` with a 5-minute TTL. The cache is **not** persistent across application restarts.

**Cache keys (composite, prefixed):**

| Endpoint | Cache key |
|---|---|
| `/api/desert/heatmap-points` | `heatmap-points:<capability>` (empty string when `capability` omitted) |
| `/api/desert/state-gaps` | `state-gaps:<capability>` |
| `/api/desert/capability-summary` | `capability-summary` (fixed) |

The endpoint-specific prefix is what prevents `heatmap-points` and `state-gaps` from colliding on the same `capability` value in the shared cache `Map`.

**Heatmap bounding-box filter:** `/api/desert/heatmap-points` returns `{ points: HeatmapPoint[], syncing?: boolean }`, where each point is `{ facility_id, latitude, longitude, trust_weight, capability, address_stateorregion }`. The query requires non-null `latitude`/`longitude` **and** bounds them to India's bounding box (in the heatmap-points handler — search for `BETWEEN 6.0 AND 37.5`): `CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5`, `CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5`. Facilities with valid-but-out-of-box coordinates (data errors or genuinely outside the box) are **silently dropped** and never rendered. *(Status: ACCEPTED — bounding to India is intentional; the silent-drop of out-of-box points is the accepted tradeoff.)*

**Capability summary grouping:** `/api/desert/capability-summary` returns `{ summary: CapabilitySummaryItem[], syncing?: boolean }`, where each item is `{ capability, facility_count, avg_trust_weight, state_count }`. Grouping is on the **raw** `COALESCE(NULLIF(TRIM(capability), ''), 'Unknown')` column value — it does **not** split comma-separated capability strings. Multi-capability strings therefore form distinct composite buckets. The query is `LIMIT 20`, so the result contains **at most** 20 rows (fewer if there are fewer than 20 distinct capability strings).

> **Filter/summary asymmetry:** The capability dropdown is populated from these raw, un-split capability strings (a composite like `'Emergency,Surgery,ICU'` is its own bucket and its own option). But `heatmap-points` and `state-gaps` filter via `capability ILIKE '%<value>%'` (in their respective handlers — search for `capability ILIKE`). Selecting a composite option therefore filters on that exact comma-joined substring — it does **not** match rows that merely contain `'Emergency'`, and conversely selecting `'Emergency'` will also match composites containing it. Grouping is exact-string; filtering is substring — they are not symmetric, so a composite-bucket selection can return **fewer** facilities than the bucket's `facility_count` implied.

---

## The `syncing` Field — Server-Hardcoded, Client-Load-Bearing

Every Desert/districts/facilities response includes a `syncing: boolean` field, currently **hardcoded `false`** on every server route. The corresponding client interfaces (`StateGapsResponse`, `HeatmapPointsResponse`, `CapabilitySummaryResponse` in `client/src/pages/desert/types.ts`) declare it **optional** (`syncing?: boolean`), even though the server always emits it — a minor contract mismatch worth reconciling (align the type to required `syncing: boolean`, or document the intentional optionality).

`syncing` is **not** purely informational — the client gates behavior on it:

- `FacilitiesPage` only populates the state-filter dropdown when `syncing` is falsy: its states-loader assigns `setStates` under the guard `if (!cancelled && !d.syncing && d.states)`. A truthy `syncing` therefore leaves the dropdown empty.
- `DesertPage` replaces the heatmap with a blocking "Data syncing…" banner when `state-gaps` or `heatmap-points` report `syncing: true`.

Any future change that flips `syncing` to `true` (e.g., to signal Lakebase synced-table lag) will hide the states dropdown and the desert map. The intended `true`-state UX must be designed before this field is wired to real sync status.
