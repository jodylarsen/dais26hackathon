This task is purely a documentation rewrite of `project-overview.md`, incorporating the adversarial review findings relevant to that document. Let me apply the fixes.

The findings relevant to `project-overview.md` are: 1, 2, 3, 7 (formula canonicality), 9, 11, and 14. Let me produce the rewritten document.

# Virtue Health — Project Overview & PRD
## DAIS 2026 Hackathon Submission

---

## 0. How to read this document set

This is one of several project documents. To avoid duplication, **each topic has exactly one authoritative location**, and other documents cross-link to it instead of restating it.

- **New to the project?** Start here (§1–§9).
- **The canonical list of bugs, risks, and open work is [§10 Known Issues](#10-known-issues-canonical).** Every "verification flag" or caveat elsewhere in this doc is a one-line summary that points back to §10. When a bug is fixed, update §10 and the matching backlog item only.
- **Canonical SQL formulas** (trust weight, demand index, gap score) live in **`data-model.md`**. §5.4 below summarizes them for context but is **not** their authoritative home — see Finding-driven note in §5.4.
- **Deploying / working directory / commands:** §14 is authoritative within this doc.
- **Testing:** §15.

### 0.1 Glossary (acronyms used throughout)

| Term | Expansion |
|---|---|
| DABs | **Databricks Asset Bundles** (the IaC bundle format; *not* "Declarative Automation Bundles") |
| CDF | Change Data Feed (Delta) |
| DLT | Delta Live Tables |
| OLTP | Online Transaction Processing |
| SP | Service Principal |
| M2M | Machine-to-machine (auth) |
| NFHS-5 | National Family Health Survey, Round 5 |
| SPA | Single-Page Application |
| UC | Unity Catalog |

### 0.2 Naming conventions (read once)

- **App identifiers.** `virtue-health` is overloaded. Throughout these docs:
  - **bundle** = `virtue-health` (the DABs bundle `name`).
  - **app resource key** = `app` (used in `databricks.yml` and `${resources.apps.app...}` references).
  - **deployed app name** = `virtue-health` (used in `databricks apps <cmd> virtue-health`).
  - When a command takes the deployed name we write `virtue-health`; when DABs config references the resource we write `app`.
- **Synced table = online table.** Databricks calls these **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables ...`). They are the same object; prose uses "synced table," commands use the CLI's `online-tables` noun. Synced-table state vocabulary is canonicalized in `data-pipeline.md` (`ONLINE` / `BLOCKED-quota` / `BLOCKED-dup-pk`); this doc uses those terms.
- **PK column name — `facility_id`, not `unique_id`.** The facilities table is documented upstream with a `unique_id` physical column, but **every shipped API query and TypeScript client interface projects `facility_id` (numeric)**. Whenever this doc discusses an **API response field** it uses `facility_id: number`; "`unique_id`" refers only to the upstream physical column (which has the duplicate-value issue). See [Known Issue #2](#10-known-issues-canonical) and §7.2.
- **Hyphenated catalog must be backtick-quoted.** The Lakebase catalog is `virtue-pg` (hyphen). Because the name contains a hyphen, it **must** be backtick-quoted in all SQL/DDL: `` `virtue-pg` ``. Unquoted `virtue-pg` is a syntax error; `virtue_pg` (underscore) is simply the wrong catalog.
- **Placeholders** use angle brackets: `<capability>`, `<table>`, `<branch-name>`.

---

## 1. Problem Statement

India's healthcare system faces a structural information crisis: facility registries exist but lack standardized quality signals, district-level health burden data (NFHS-5) is not joined to facility supply, and there is no unified tool to identify where care gaps are largest relative to demand.

Three compounding problems motivate this project:

**1.1 Fragmented and unverified facility data**
The source facility registry (`dais27hack.virtue_foundation_dataset_silver.facilities`) contains 10,088 facilities across India, but data provenance varies significantly per record. Some facilities are backed by multiple independent sources; others carry a single, unverified source entry. Without a trust signal, analysts and planners cannot distinguish high-confidence listings from provisional ones. A facility claiming specialized oncology capability but backed by a single source deserves less weight than one corroborated by three independent registries.

**1.2 Disconnected demand signals**
NFHS-5 produced district-level health indicators covering immunization rates, maternal mortality proxies, nutrition, anemia prevalence, blood pressure, water/sanitation access, and ~95 other metrics across 706 districts. This demand-side data has never been spatially joined to the facility supply-side data in a single interactive tool.

**1.3 Medical deserts are invisible**
Without a joined view of demand (NFHS-5 burden indicators) versus supply (facility count weighted by trust), it is impossible to prioritize where infrastructure investment, referral capacity, or policy intervention is most needed. Regions with poor NFHS-5 outcomes and low-trust or sparse facilities are "medical deserts" — and they are currently invisible to decision makers.

---

## 2. Solution Overview

Virtue Health is an India healthcare data explorer deployed as a Databricks App. It joins the facility registry with NFHS-5 district indicators to surface care gaps across four analytical tracks, each targeting a distinct user workflow.

**Platform:** Databricks Apps (AppKit framework)
**Workspace:** `dbc-0a01f518-764a.cloud.databricks.com`
**DABs bundle:** `virtue-health` (app resource key `app`, deployed app name `virtue-health` — see §0.2 and §14)

---

## 3. Primary Users

| User | Goal | Primary Track |
|---|---|---|
| State health planner / policy analyst | Identify districts with highest unmet need for facility investment | Track 2 (Desert Planner) |
| NGO program officer | Find credible facilities in a target region to build referral networks | Track 1 (Facility Trust Desk), Track 3 (Referral Copilot) |
| Data quality auditor | Profile the registry for completeness, contradictions, and duplicate records | Track 4 (Data Readiness Desk) |
| Healthcare researcher | Explore NFHS-5 indicators by district; correlate outcomes with facility density | Track 2 (Desert Planner), /districts page |

---

## 4. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite (**rolldown-vite 7.1.14** via npm `overrides`, not stock Vite), `@databricks/appkit-ui`, React Router v7, Tailwind CSS |
| Maps | `maplibre-gl` ^5.24 + `react-map-gl` ^8.1 — renders the Desert Planner heatmap and choropleth (`DesertMap.tsx`) |
| Other frontend deps | `zod` (request validation in scaffold routes), `lucide-react` (icons), `next-themes`, `react-resizable-panels`, `embla-carousel-react`, `clsx`, `tailwind-merge` |
| Backend | Express.js via `@databricks/appkit` `server` plugin |
| Analytics queries | Databricks SQL Warehouse `5b2b29cce22aa2c4` via `appkit.analytics.query()` |
| OLTP / Lakebase | **Not active.** No Lakebase plugin is registered at runtime; the only Lakebase files are orphaned scaffold code (see §4.1) |
| Pipeline | Delta tables with CDF enabled; synced to Lakebase via TRIGGERED mode |
| Deployment | DABs: `databricks bundle deploy -t default --profile deepak-workspace` (run from `<repo>/virtue-health/`, §14) |

> **Read-path reality check:** Every production API endpoint (`/api/summary`, `/api/facilities*`, `/api/districts*`, `/api/desert/*`) reads from the **SQL Warehouse** via `appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver`. The facilities endpoints read the **plain `facilities` table, not `facilities_live`** (see `data-pipeline.md §2`); this matters for null bytes ([Known Issue #16](#10-known-issues-canonical)) and for Track 4's table choice (§8, Track 4 AC6). There is **no live Lakebase read path** in the app — see §4.1.

### 4.1 Lakebase is not wired in (orphaned scaffold)

**No Lakebase code runs at all.** Verified against source (`server/server.ts`):

- `createApp({ plugins: [ analytics({}), server() ] })` — the **`lakebase` plugin is not registered**, so `appkit.lakebase` does **not** exist at runtime.
- `server/routes/lakebase/todo-routes.ts` exports `setupSampleLakebaseRoutes`, but it is **never imported or called** — `onPluginsReady` only calls `setupVirtueHealthRoutes(appkit)`. So `/api/lakebase/todos` is not served.
- `client/src/pages/lakebase/LakebasePage.tsx` exists but is **never referenced** in `App.tsx`'s router — there is no `/lakebase` route and no nav link.

These are orphaned scaffold files. To make any Lakebase route functional you must (a) add the `lakebase` plugin to `createApp`, (b) call `setupSampleLakebaseRoutes(appkit)` in `onPluginsReady`, and (c) register the route + nav entry. Until then, the `PG*` / `LAKEBASE_ENDPOINT` env vars (§14.3) are unused at runtime. Tracked as [Known Issue #1](#10-known-issues-canonical).

---

## 5. Data Sources and Provenance

### 5.1 Source Catalog

All source data lives in `dais27hack.virtue_foundation_dataset_silver`. Tables were cloned from the original hackathon-provided catalog `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset`.

### 5.2 Tables

**`facilities`** (read-only source) / **`facilities_live`** (CDF-enabled, app-writable)
- 10,088 healthcare facilities across India
- Full column set includes: `unique_id` (upstream physical PK — has known duplicate values, see [Known Issue #2](#10-known-issues-canonical)), `name`, `organization_type`, `capability`, `specialties`, `equipment`, `procedure`, `source_types`, `source_ids`, `address_city`, `address_stateorregion`, `address_country`, `latitude`, `longitude`, `description`, `cluster_id`, `source_urls`
- **API note:** the `/api/facilities` and `/api/desert/heatmap-points` endpoints **project `facility_id` (numeric), not `unique_id`** (see §0.2, §7.2, §7.6). The `/api/facilities` endpoint also returns only a subset of columns (see §7).
- **Read path:** the production read endpoints query the **plain `facilities`** table, not `facilities_live`. Consequently the null-byte remediation (next bullet) does **not** apply to what the API serves — see [Known Issue #16](#10-known-issues-canonical).
- Data quality note: `name` and `description` columns contained null bytes (`0x00`) which were cleaned via `REPLACE(col, CAST(CHAR(0) AS STRING), '')` during pipeline setup — but **only in `facilities_live`**. The plain `facilities` table (the read path) still contains them.
- `latitude`/`longitude` column type is **unverified** — see [Open Verification Task OV-1 (§10.1)](#101-open-verification-tasks). The heatmap query applies `CAST(... AS DOUBLE)` defensively regardless.

**`nfhs_5_district_health_indicators`** (read-only source) / `nfhs_5_district_health_indicators_live` (CDF-enabled)
- 706 records; composite PK: `district_name` + `state_ut`
- Contains approximately 100 health indicator columns (immunization, maternal health, nutrition, anemia, blood pressure, water/sanitation, sex ratio). **Only a small subset is queried by the app** (see §7): `district_name, state_ut, households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct`, plus `sex_ratio_total_f_per_1000_m` for the Overview KPI.
- Because `district_name` repeats across states (unique only in combination with `state_ut`), `COUNT(DISTINCT district_name)` is **strictly less than 706**.
- Lakebase status: synced table is `ONLINE` in Postgres, but the app does **not** read districts from Lakebase — it reads from the SQL Warehouse (and the Lakebase plugin is not even loaded, §4.1).

**`india_post_pincode_directory`** (read-only source) / `india_post_pincode_directory_live` (CDF-enabled)
- 165,627 records; composite PK: `officename` + `pincode` + `statename`
- Columns: `circlename`, `regionname`, `divisionname`, `officename`, `pincode` (BIGINT), `officetype`, `delivery`, `district`, `statename`, `latitude` (STRING), `longitude` (STRING)
- Important: `latitude` and `longitude` are STRING type, not DOUBLE — geographic queries require explicit `CAST`.
- Lakebase sync: `BLOCKED-quota` ([Known Issue #3](#10-known-issues-canonical)). No app endpoint currently reads this table.

### 5.3 Pipeline Architecture

```
Source Delta tables (read-only)
        │
        ▼
_live Delta tables (CDF-enabled, app-writable)
  dais27hack.virtue_foundation_dataset_silver.*_live
        │  (Delta Change Data Feed, TRIGGERED mode)
        ▼
Lakebase Postgres
  catalog: `virtue-pg`  →  database: databricks_postgres  →  schema: virtue_foundation_dataset_silver
```

> The Postgres landing tier above is provisioned, but the **app does not read from it** — see §4.1. This pipeline supports a future OLTP read path, not the current one.

**Canonical seed ordering (clean CDF log).** To seed a `_live` table without recording the bulk insert as CDF change events, CDF must be **disabled across both the TRUNCATE and the INSERT** — a TRUNCATE while CDF is enabled is logged as delete events. The canonical order, used identically in the pipeline and ops docs, is:

```
disable CDF  →  TRUNCATE  →  INSERT INTO ... SELECT FROM ...  →  re-enable CDF
```

For `facilities`, the INSERT must use an explicit column list with `REPLACE(name, CAST(CHAR(0) AS STRING), '')` (and likewise for `description`) — **do not use `SELECT *`**, or null bytes are re-introduced. The pipeline test asserting a zero-event CDF log after this procedure is **`test-plan.md` P-TC-03** (the row-count check is P-TC-01).

### 5.4 Computed Fields (not stored)

> **Canonical home:** these three formulas are defined canonically in **`data-model.md`**. The text below is a **summary for context**; if it ever disagrees with `data-model.md`, `data-model.md` wins. (`architecture.md §7` and `data-pipeline.md §6` also name `data-model.md` as canonical.)

**Trust weight** (computed at query time per facility):
```sql
LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0, 1.0)
```
Rationale: normalizes the number of independent source entries to a 0–1 score, capped at 1.0 when three or more sources are present.

> **Known bug — possible negative `trust_weight` for NULL `source_types`.** `NULLIF(TRIM(source_types), '')` converts empty/whitespace strings to `NULL`, and in Spark SQL `SIZE(SPLIT(NULL, ','))` returns **-1** (not NULL), so the `COALESCE(..., 1)` fallback never fires and the result becomes `LEAST(-1/3.0, 1.0) = -0.333`. See [Known Issue #6](#10-known-issues-canonical) for the canonical fix and the verification task (OV-2).

**Demand index** — canonical name: the **field** is `demand_index`; the **concept** is "deprivation-based demand." They are the **same number** (higher deprivation ⇒ higher demand). Computed per state inside the state-gaps query:
```sql
ROUND((
    (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
  + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
  + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
  + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
) / 4.0, 1) AS demand_index
```
It is the average of four `(100 − coverage%)` deprivation terms (electricity, improved water, improved sanitation, child-under-5 civil birth registration). Per-column nulls fall back to a 50% assumption via `COALESCE(..., 50)`.

**Gap score** (computed at query time per state):
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
Rationale: divides demand (`demand_index`, state-level fallback 50 when NFHS data is missing) by a supply proxy (facility count scaled by average trust weight, divided by 10). The `GREATEST(..., 0.1)` floor prevents division-by-zero. Higher scores indicate larger unmet need.

> **Material correctness risk — state-name join.** The gap-score query performs a `FULL OUTER JOIN` between NFHS-5 states (`state_ut`) and facility states (`address_stateorregion`) on `LOWER(TRIM(state))`. Name mismatches across the two sources (e.g., "NCT of Delhi" vs. "Delhi") fail to join, producing unmatched/defaulted (demand→50, supply→0) or inflated gap scores. This is the single biggest correctness risk in Track 2. The full explanation, the diagnostic, and an example crosswalk fix live in [Known Issue #5](#10-known-issues-canonical).

---

## 6. App Pages and Routes

| Route | Page Name | Heading (`<h1>` / section title) | Description |
|---|---|---|---|
| `/` | Overview | `India Healthcare Overview` (brand `Virtue Health`) | KPI cards: total facilities, states covered, districts covered, avg sex ratio |
| `/facilities` | Facility Browser | `Healthcare Facilities` | Searchable, paginated table (50/page); filter by state, search by name or city |
| `/districts` | District Indicators | `District Health Indicators` | NFHS-5 district health indicators (subset of columns); filterable by state; **no pagination** (renders all returned rows) |
| `/desert` | Desert Planner | `Medical Desert Planner` (nav label `Desert Planner`) | Heatmap + choropleth + gap scoring + state detail panel (see §6.1) |

> Heading strings above are load-bearing for E2E assertions (`tests/smoke.spec.ts`). The smoke test asserts `Total Facilities`, `States Covered`, and `Districts Covered`, but does **not** assert the 4th ("Avg Sex Ratio") card. Confirm the exact 4th-KPI title against `OverviewPage.tsx`.

### 6.1 Desert Planner UI surface (more than a heatmap)

`/desert` (component `DesertPage`) is materially richer than "heatmap + gap table." It includes:
- a KPI bar (`DesertKpiBar`),
- a controls panel (`DesertControls`) toggling **Show Heatmap**, **Show Choropleth** (state-fill by gap score), and **Show Confidence Filter**,
- a MapLibre map (`DesertMap`) rendering both heatmap points **and** a choropleth layer,
- a clickable **state detail panel** (`DesertDetailPanel`),
- a legend (`DesertLegend`) and a data-limitation disclosure banner,
- data fetched via the `useDesertData` hook.

The Track 2 acceptance criteria (§8) cover choropleth, confidence filtering, and the detail panel so "all AC met" cannot be claimed while these features go untested.

---

## 7. Server API Endpoints

All endpoints read from the SQL Warehouse via `appkit.analytics.query()`.

### 7.0 The `syncing` field is load-bearing, not informational

Every endpoint includes a `syncing: boolean`, **currently hardcoded `false` server-side.** It is **not** purely informational — the client gates behavior on it:
- `FacilitiesPage.tsx` refuses to populate the state-filter dropdown when `syncing` is truthy (search for `!d.syncing && d.states`).
- `DesertPage.tsx` replaces the heatmap/choropleth with a blocking amber "Data syncing…" banner whenever `state-gaps` or `heatmap-points` report `syncing: true`.

So if `syncing` ever flips to `true`, the states dropdown silently breaks and the desert map is hidden. The intended `true`-state UX must be designed before wiring it — see [Known Issue #8](#10-known-issues-canonical). Note also that `client/src/pages/desert/types.ts` marks `syncing?: boolean` as **optional** even though the server always emits it.

### 7.1 `GET /api/summary`
```ts
{
  totalFacilities: number;   // COUNT(*) FROM facilities  (plain facilities table, not _live)
  statesCovered:   number;   // COUNT(DISTINCT state_ut) FROM NFHS-5
  districtsCovered: number;  // COUNT(DISTINCT district_name) FROM NFHS-5 (< 706, names repeat across states)
  avgSexRatio:     number | null; // ROUND(AVG(sex_ratio_total_f_per_1000_m), 1); null when unavailable
  syncing:         boolean;
}
```
> **`statesCovered` vs. the Facilities filter draw from different state universes.** `statesCovered` counts NFHS-5 `state_ut`. The Facilities-page state filter (`/api/facilities/states`, §7.3) lists distinct `address_stateorregion` from the **facilities** table — a *different* set. The two do not necessarily match (this is exactly the state-name mismatch behind [Known Issue #5](#10-known-issues-canonical)). A reader who assumes "States Covered" reflects the states the facilities span would be mistaken.

### 7.2 `GET /api/facilities?search=&state=&page=`
Paginated, 50/page. Search matches `name` OR `address_city` (ILIKE); `state` filters on `address_stateorregion`.
```ts
{
  facilities: Array<{
    facility_id: number;   // API projects facility_id (numeric), NOT unique_id (string).
                           // The upstream physical column unique_id has duplicate values (Known Issue #2);
                           // the API returns facility_id.
    name: string;
    organization_type: string;
    address_city: string;
    address_stateorregion: string;
    address_country: string;
  }>;
  total: number;
  page: number;
  pageSize: number;   // 50
  totalPages: number;
  syncing: boolean;
}
```
Note: returns **only** the six columns above — `capability`, `specialties`, `latitude`, `longitude`, `description`, `source_*`, etc. are **not** returned by this endpoint. Verified against `server/routes/virtue-health-routes.ts` and `client/src/pages/facilities/FacilitiesPage.tsx` (`facility_id: number`).

> **`page` over-range behavior (undocumented edge case).** `page` is floored to ≥1 via `Math.max(1, parseInt(...))`, but is **not** clamped to `totalPages`. 10,088 / 50 → 202 pages; page 202 uses `OFFSET 10050` and returns rows 10051–10088 (38 rows). Requesting a page beyond the last (e.g. `page=5000`) issues a large `OFFSET`, returns `facilities: []` with HTTP 200, and still reports the true `total`/`totalPages`. The UI's "Next" button is disabled only by comparing to `data.totalPages` client-side. See [Known Issue #9](#10-known-issues-canonical).

### 7.3 `GET /api/facilities/states`
```ts
{ states: string[]; syncing: boolean }   // distinct address_stateorregion, non-null/non-empty, sorted
```
This is the **facilities** state universe, distinct from the NFHS-5 `state_ut` universe behind `statesCovered` (§7.1).

### 7.4 `GET /api/districts?state=`
Optionally filtered by `state_ut`.
```ts
{
  districts: Array<{
    district_name: string;
    state_ut: string;
    households_surveyed: number;
    hh_electricity_pct: number;
    hh_improved_water_pct: number;
    hh_use_improved_sanitation_pct: number;
    child_u5_whose_birth_was_civil_reg_pct: number;
  }>;
  syncing: boolean;
}
```
Notes:
- Returns **only the seven columns above**, not the full ~100-column NFHS-5 set.
- **No pagination.** No `LIMIT`/`OFFSET`; returns the entire filtered result (up to all 706 rows unfiltered), and the Districts page renders every row into the DOM. Acceptable at 706 rows. See [Known Issue #14](#10-known-issues-canonical).

### 7.5 `GET /api/districts/states`
```ts
{ states: string[]; syncing: boolean }   // distinct state_ut, sorted
```

### 7.6 `GET /api/desert/heatmap-points?capability=`
Cache key: `heatmap-points:<capability>` (5-min in-memory TTL). Optional `capability` filters via `ILIKE`. Coordinates are filtered to India's bounding box (`latitude BETWEEN 6.0 AND 37.5`, `longitude BETWEEN 68.0 AND 97.5`) **and** non-null — facilities with null or out-of-box coordinates are silently excluded ([Known Issue #15](#10-known-issues-canonical)).
```ts
{
  points: Array<{
    facility_id: number;         // API projects facility_id (numeric), NOT unique_id (Known Issue #2)
    latitude: number;            // CAST(latitude AS DOUBLE)
    longitude: number;           // CAST(longitude AS DOUBLE)
    trust_weight: number;        // see §5.4 (negative-value caveat, Known Issue #6)
    capability: string | null;
    address_stateorregion: string | null;
  }>;
  syncing: boolean;
}
```
Verified against `server/routes/virtue-health-routes.ts` and `client/src/pages/desert/types.ts` (`facility_id: number`).

### 7.7 `GET /api/desert/state-gaps?capability=`
Cache key: `state-gaps:<capability>` (5-min TTL).
```ts
{
  gaps: Array<{
    state: string;
    facility_count: number;
    avg_trust_weight: number;
    source_type_variants: number;
    demand_index: number | null;
    district_count: number | null;
    supply_score: number;
    gap_score: number;
    confidence: 'high' | 'medium' | 'low'; // variants>=3 high, >=1 medium, else low
  }>;
  syncing: boolean;
}
```
Sorted by `gap_score DESC NULLS LAST`. (Reference: `client/src/pages/desert/types.ts`.)

### 7.8 `GET /api/desert/capability-summary`
Cache key: `capability-summary` (5-min TTL). Groups facilities by the **raw `capability` string** (`COALESCE(NULLIF(TRIM(capability), ''), 'Unknown')`) — there is **no comma-splitting**, so multi-capability strings form their own composite buckets. Returns up to 20 rows (`LIMIT 20`).
```ts
{
  summary: Array<{
    capability: string;
    facility_count: number;
    avg_trust_weight: number;
    state_count: number;
  }>;
  syncing: boolean;
}
```

> **Filter/summary semantic mismatch.** This endpoint populates the capability dropdown with **raw, un-split** strings; a composite like `'Emergency,Surgery,ICU'` becomes its own option. But `heatmap-points`/`state-gaps` filter via `capability ILIKE '%<value>%'`. Selecting the composite runs `ILIKE '%Emergency,Surgery,ICU%'`, matching only rows whose capability string contains that exact comma-joined substring — fewer than this summary's `facility_count`. Grouping is exact-string; filtering is substring. See [Known Issue #7](#10-known-issues-canonical).

### 7.9 Input handling / SQL safety
The `search`, `state`, and `capability` parameters are interpolated into SQL **after single-quote escaping** (`.replace(/'/g, "''")`), not via parameterized/bound queries. This mitigates basic quote-breakout injection but is **not** equivalent to parameterized queries and is easy to omit on a new route. See [Known Issue #4](#10-known-issues-canonical).

### 7.10 Caching Summary

| Endpoint | Cache Key | TTL |
|---|---|---|
| `/api/desert/heatmap-points` | `heatmap-points:<capability>` | 5 min |
| `/api/desert/state-gaps` | `state-gaps:<capability>` | 5 min |
| `/api/desert/capability-summary` | `capability-summary` (fixed) | 5 min |

The prefix in each key prevents cache collisions between endpoints that share the same `capability` value. Cache is an in-memory `Map`, lost on app restart ([Known Issue #10](#10-known-issues-canonical)).

### 7.11 Same-origin serving and SPA fallback

The Express process (AppKit `server` plugin) serves both the API (`/api/*`) and the built SPA on a **single origin**, which is why the client uses **relative** fetch paths (`fetch('/api/facilities/states')`, etc.). Client-side routes (`/facilities`, `/districts`, `/desert`) rely on the server plugin's **SPA fallback** (serving `index.html` for non-`/api` paths) so deep links and hard refreshes resolve. If a hard refresh on `/desert` returns 404, check the static / SPA-fallback configuration in the `server` plugin.

---

## 8. Hackathon Tracks

### Track 1 — Facility Trust Desk

**Problem:** A user needs to evaluate whether a facility's claimed capabilities are credible before including it in a referral network or policy report.

**Concept:** Display a per-facility trust signal (Strong / Partial / Weak / No Claim) derived from the number and type of corroborating sources in `source_types`/`source_ids`.

**Acceptance Criteria:**
1. A facility detail view displays a trust badge (Strong / Partial / Weak / No Claim) computed from the trust-weight formula.
2. The facility browser (`/facilities`) can be filtered by trust tier.
3. The trust tier breakdown (count per tier) is visible as a KPI on the Overview page or a dedicated Trust Desk panel.
4. Clicking a facility shows which source registries corroborate it (parsed from `source_urls`).
5. Trust tiers are defined and documented: Strong = trust_weight ≥ 0.67 (3+ sources), Partial = 0.34–0.66 (2 sources), Weak = trust_weight > 0 (1 source), No Claim = no source data. (See the negative-trust_weight bug in [Known Issue #6](#10-known-issues-canonical) — tier boundaries must account for the possible -0.333 case for NULL `source_types`.)

**Implementation Status: NOT IMPLEMENTED.** The trust-weight formula exists in the Desert Planner SQL but no facility-level trust UI, filtering, or detail view has been built. `/api/facilities` also does not currently return `source_types`/`source_ids`/`source_urls` (it returns the six columns in §7.2, keyed on `facility_id`), so the browser would need an expanded SELECT before tiers can be displayed there.

---

### Track 2 — Medical Desert Planner

**Problem:** Health planners need a geographic view of where facility supply (adjusted for credibility) falls short of population health burden, so they can prioritize investment and intervention.

**Concept:** A heatmap of facility density weighted by trust signal, a choropleth state-fill by gap score, plus state-level gap scores from NFHS-5 demand vs. facility supply, with a clickable state detail panel and confidence filtering.

**Acceptance Criteria:**
1. The `/desert` page loads a heatmap with intensity proportional to trust_weight. (Caveat: points are bounding-box filtered to India, 6–37.5 lat / 68–97.5 lon; out-of-box facilities are excluded.)
2. A state-level gap score table is displayed alongside the map, sortable by gap score descending.
3. The capability filter restricts heatmap and gap scores to a specific care type.
4. The capability dropdown is populated from up to 20 capabilities by facility count (raw strings, no comma-splitting). (See §7.8 mismatch.)
5. A 5-minute cache prevents redundant SQL Warehouse queries during a demo.
6. The gap score uses the documented `demand_index` deprivation-based formula (§5.4) divided by trust-weighted supply with a 0.1 floor.
7. A **choropleth** layer fills states by gap score and can be toggled via `DesertControls` (`Show Choropleth`).
8. A **confidence filter** (`Show Confidence Filter`) restricts states by the server-computed `confidence` tier.
9. Clicking a state opens a **detail panel** (`DesertDetailPanel`) with that state's gap metrics.

**Implementation Status: DATA/API LAYER FULLY IMPLEMENTED; UI RICHER THAN ORIGINALLY DOCUMENTED.**
- All three `/api/desert/*` endpoints are live and returning data from SQL Warehouse `5b2b29cce22aa2c4`.
- 5-minute in-memory cache is active.
- `demand_index` and the gap-score formula are fully defined in code (summarized §5.4; canonical in `data-model.md`).
- UI includes heatmap, choropleth, confidence filter, KPI bar, legend, and state detail panel (§6.1).
- **Outstanding caveats** (do not claim "all AC met" without UI verification): (a) the heatmap silently drops out-of-bounding-box facilities (Known Issue #15); (b) the `FULL OUTER JOIN` on normalized state names can fail (Known Issue #5); (c) AC 7–9 need explicit test coverage.

---

### Track 3 — Referral Copilot

**Problem:** A clinician or NGO caseworker has a patient at a specific location with a specific care need. They need a ranked shortlist of nearby credible facilities.

**Concept:** Given a location (city, pincode, or lat/lon) and a care need, return a ranked list sorted by a composite of proximity and trust weight.

**Acceptance Criteria:**
1. User can input a location (free-text city, or pincode lookup via `india_post_pincode_directory`) and a care need.
2. System returns up to 10 ranked facilities within a configurable radius.
3. Ranking formula combines proximity (inverse distance in km) and trust weight; coefficients documented.
4. Each result card shows: name, organization type, distance, trust badge, source URLs.
5. Pincode-to-coordinate lookup uses `india_post_pincode_directory_live` (latitude/longitude are STRING — cast required).
6. Results load within the §11 timing target on SQL Warehouse `5b2b29cce22aa2c4`.

**Implementation Status: NOT IMPLEMENTED.** No API endpoint or UI. Pincode data is available but its Lakebase sync is `BLOCKED-quota` (Known Issue #3).

---

### Track 4 — Data Readiness Desk

**Problem:** The facility registry has known quality issues (duplicate `unique_id`, null bytes, unverified claims). A data steward needs a profiling dashboard.

**Concept:** A data quality profiling view surfacing completeness scores, contradictions, duplicate records, and field-level anomalies across the facilities table.

**Acceptance Criteria:**
1. A `/data-quality` route (or panel) shows completeness % per column (facilities table, min 15 columns).
2. Duplicate `unique_id` detection: count of upstream physical-PK values appearing more than once, with a drilldown table. (Note: this profiles the upstream `unique_id` column; the API itself projects `facility_id` — §7.2.)
3. Null-byte detection report: count of records where `name`/`description` contains `0x00`.
4. Contradiction detection: at minimum, flag facilities where `latitude`/`longitude` is null but `address_city` is populated.
5. Source corroboration anomaly: flag facilities where `source_types` count disagrees with `source_ids` count.
6. **Table choice — deliberate divergence.** Track 4 profiles **`facilities_live`** (the remediated table) even though **every current read endpoint queries the plain `facilities` table** (§4 read-path note; `data-pipeline.md §2`). This is an intentional design choice, not an inconsistency: completeness, duplicate-`unique_id`, and especially null-byte counts **will differ** between `facilities` and `facilities_live` (the plain table still contains null bytes — [Known Issue #16](#10-known-issues-canonical)). A Track 4 implementer must state which table each metric reflects. If the goal is to characterize the data the app actually serves, profile the plain `facilities` table instead. All profiling queries run on SQL Warehouse `5b2b29cce22aa2c4`.

**Implementation Status: NOT IMPLEMENTED.** No API or UI. The known quality issues have been identified and partially remediated in the pipeline (`_live` only) but are not surfaced in the app.

---

## 9. Current Implementation Status Summary

| Component | Status | Notes |
|---|---|---|
| Data pipeline (clone, CDF, seed) | Complete | All _live tables seeded; CDF enabled |
| Lakebase plugin / read path | **Not active** | Plugin not registered in `server.ts`; todo routes + `LakebasePage` orphaned (§4.1) |
| Lakebase — nfhs_5 synced table | `ONLINE` | Synced to Postgres; **app reads NFHS from SQL Warehouse, not Lakebase** |
| Lakebase — india_post synced table | `BLOCKED-quota` | Quota limit on concurrent sync pipelines |
| Lakebase — facilities_live synced table | `BLOCKED-dup-pk` | Duplicate `unique_id` blocks synced table creation |
| Overview page (`/`) | Implemented | KPI cards from `/api/summary`; heading `India Healthcare Overview` |
| Facility browser (`/facilities`) | Implemented | Search, state filter, pagination (50/page); returns 6 columns keyed on `facility_id` |
| District indicators (`/districts`) | Implemented | NFHS-5 7-column subset, state filter; **no pagination** |
| Desert Planner (`/desert`) | Data/API + rich UI implemented | Heatmap + choropleth + confidence filter + detail panel + caching (§6.1) |
| Track 1 — Facility Trust Desk | Not implemented | Formula exists in SQL; no UI; `/api/facilities` lacks source columns |
| Track 2 — Medical Desert Planner | Data/API + UI implemented | See outstanding caveats |
| Track 3 — Referral Copilot | Not implemented | No API or UI |
| Track 4 — Data Readiness Desk | Not implemented | No API or UI |
| Error / empty / loading UI | **Implemented** | Top-level `ErrorBoundary` + per-route `errorElement`; page-level error/skeleton/empty states |
| SQL parameterization | Partial | Single-quote escaping applied; not bound/parameterized queries |
| Persistent caching | Not done | In-memory Map, lost on app restart |
| Automated tests | Smoke only | `tests/smoke.spec.ts` (Playwright); **zero** vitest tests (§15) |

---

## 10. Known Issues (canonical)

This is **the** authoritative list of bugs, risks, and open work. Every caveat elsewhere in the doc set points here. Each row uses exactly one status from the legend. Other docs that maintain local issue numbers (`data-model.md`, `test-plan.md` GAP-IDs) must cite **these** numbers; see the cross-reference note below the table.

**Status legend:** **OPEN** = needs work, no decision made · **ACCEPTED** = known and intentionally not fixing now (rationale given) · **BLOCKED** = needs an external/upstream fix · **RESOLVED** = fixed.

| # | Issue | Severity | Impact | Status |
|---|---|---|---|---|
| 1 | Lakebase plugin not registered; todo routes + `LakebasePage` orphaned | High | `appkit.lakebase` unavailable at runtime; `/api/lakebase/todos` not served; docs could imply a working Lakebase path | OPEN — clarify intent or wire it in (§4.1) |
| 2 | `facilities.unique_id` (upstream physical PK) has duplicate values | High | Blocks Lakebase synced-table creation for facilities. (The API itself projects `facility_id`, §7.2, so this is a pipeline/physical-column issue.) | BLOCKED — awaiting upstream fix |
| 3 | `DATABASE_TABLE_SYNC` workspace quota: 1 concurrent pipeline | High | `india_post` and `facilities_live` syncs must be sequential; currently `BLOCKED-quota` | BLOCKED — quota |
| 4 | SQL params use quote-escaping, not bound parameters | High | `search`/`state`/`capability` interpolated after `.replace(/'/g, "''")`; mitigates basic injection but not robust; easy to forget on new routes | OPEN — migrate to parameterized queries |
| 5 | `gap_score` `FULL OUTER JOIN` on `LOWER(TRIM(state))` (state-name mismatch) | High | "NCT of Delhi" vs "Delhi" etc. fail to join → unmatched/defaulted (demand=50, supply=0) or inflated scores. Biggest Track 2 correctness risk. Also why §7.1 `statesCovered` ≠ Facilities-filter universe. | OPEN — needs a state-name crosswalk (see §10.2) |
| 6 | Possible negative `trust_weight` for NULL `source_types` | High | `SIZE(SPLIT(NULL,','))=-1` in Spark, so `COALESCE(...,1)` never fires → `LEAST(-0.333,1.0)=-0.333` | OPEN — verify (OV-2) then apply fix in §10.3 |
| 7 | `capability-summary` exact-string grouping vs. `ILIKE` substring filter | Medium | Composite dropdown options filter on the exact comma-joined substring, returning fewer facilities than the bucket implies | OPEN — normalize both sides (split on comma) or document |
| 8 | `syncing: true` would break UI silently | Medium | Server hardcodes `false`; if flipped true, states dropdown and desert map are hidden with no documented UX | OPEN — design true-state UX; align `types.ts` to required `syncing: boolean` |
| 9 | `/api/facilities` `page` not clamped to `totalPages` | Low | Over-range page returns empty list + HTTP 200 with no over-range signal | OPEN — clamp or document |
| 10 | Desert Planner cache is in-memory, not persistent | Medium | Cache lost on app restart; first request after restart hits SQL Warehouse | ACCEPTED — fine for a demo; revisit for prod |
| 11 | `india_post` latitude/longitude columns are STRING, not DOUBLE | Medium | Geographic distance calculations require explicit `CAST` | ACCEPTED — no query uses these columns today; cast when Track 3 lands |
| 12 | Heatmap silently drops out-of-bounding-box / null-coord facilities | Low | Facilities outside 6–37.5 lat / 68–97.5 lon are excluded with no UI note | ACCEPTED — intended India-only scope; surface a count in UI (backlog #18) |
| 13 | `syncing?` optional in client TS types | Low | `types.ts` marks `syncing?: boolean` though server always emits it | OPEN — align type or document |
| 14 | `/districts` returns full filtered set unbounded (no pagination) | Low | Up to 706 rows loaded and rendered into the DOM per request | ACCEPTED — fine at 706 rows; paginate if NFHS grows (backlog #19) |
| 15 | Lakebase project deleted and recreated during troubleshooting | Low | Historical context only; current project `virtue-health` is active | RESOLVED |
| 16 | Null bytes (`0x00`) in `facilities.name`/`description` not fixed on the read path | High | Stripped in `facilities_live` only; the **plain `facilities` table — which every read endpoint queries** (§4, §5.2) — still contains null bytes, so API responses can carry corrupt strings | OPEN — remediate the plain table or repoint reads to `_live` |

> **Cross-doc numbering.** These numbers are canonical. `data-model.md`, `architecture.md`, and `test-plan.md` (GAP-IDs) maintain local references and must map to the numbers here rather than coining a conflicting scheme. In particular, the null-byte issue is **#16** here (it was previously tracked only in `data-model.md`/`data-pipeline.md` and was missing from this canonical list), and `data-model.md`'s local "#1/#2/#3/#4" do **not** correspond to this list's #1/#2/#3 — relabel those references to cite these numbers.

### 10.1 Open Verification Tasks

Each question below is answerable in ~30 seconds against warehouse `5b2b29cce22aa2c4`. Run the query, record the result here, then delete the corresponding conditional hedging across the doc set.

| ID | Task | Query | Expected / record result |
|---|---|---|---|
| OV-1 | Confirm `facilities.latitude`/`longitude` column type (opened 2026-06-15, owner: TBD) | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | DOUBLE vs STRING. If DOUBLE, the heatmap `CAST(... AS DOUBLE)` is redundant. Also confirms whether the physical PK column is named `unique_id` or `facility_id` (the **API response field** is already confirmed `facility_id: number` via client interfaces — this only resolves the physical-column name). Result: `____` |
| OV-2 | Confirm negative `trust_weight` for NULL `source_types` (opened 2026-06-15, owner: TBD) | `SELECT LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(CAST(NULL AS STRING)), ''), ',')), 1)/3.0, 1.0);` | Confirm `-0.333`. If confirmed, apply the §10.3 fix and update any test asserting `0.0 ≤ trust_weight ≤ 1.0`. Result: `____` |
| OV-3 | Confirm null bytes remain in the **plain** `facilities` table (Known Issue #16) | `SELECT COUNT(*) FROM dais27hack.virtue_foundation_dataset_silver.facilities WHERE name LIKE CONCAT('%', CAST(CHAR(0) AS STRING), '%') OR description LIKE CONCAT('%', CAST(CHAR(0) AS STRING), '%');` | >0 confirms the read path serves corrupt strings. Result: `____` |

### 10.2 State-name join — diagnostic and example crosswalk fix (Known Issue #5)

First enumerate the actual mismatches in this dataset:
```sql
-- states present in NFHS but not matched in facilities (and vice versa)
SELECT DISTINCT LOWER(TRIM(state_ut)) AS nfhs_state
FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators
EXCEPT
SELECT DISTINCT LOWER(TRIM(address_stateorregion))
FROM dais27hack.virtue_foundation_dataset_silver.facilities;
```
Then normalize both sides with a crosswalk before joining. **The values below are illustrative and must be verified against the EXCEPT output** before use:
```sql
CASE LOWER(TRIM(state))
  WHEN 'nct of delhi' THEN 'delhi'
  WHEN 'orissa'       THEN 'odisha'
  WHEN 'pondicherry'  THEN 'puducherry'
  ELSE LOWER(TRIM(state))
END AS state_key
```

### 10.3 Trust-weight fix (Known Issue #6)

**Recommended fix — NULL `source_types` resolves to the intended 0.333:**
```sql
LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
```
Do **not** instead clamp with `GREATEST(..., 0.0)` unless you intend NULL `source_types` to score **0**, not 0.333 — the two fixes have **different semantics**. Decide which you want and document it; the `COALESCE(NULLIF(..., -1), 1)` form above is canonical for this project.

---

## 11. Key Demo Metrics

**Timing definitions (used everywhere):**
- **warm** = warehouse RUNNING *and* the 5-minute cache populated.
- **cache-cold** = warehouse RUNNING but cache empty.
- **warehouse-cold** = warehouse stopped; adds a 2–5 min serverless cold-start, **excluded from all SLAs below.**

All targets below assume a RUNNING warehouse.

| Metric | Source | Expected |
|---|---|---|
| Total facilities indexed | `/api/summary` → `totalFacilities` | ~10,088 |
| States covered | `/api/summary` → `statesCovered` | Distinct `state_ut` from NFHS-5 (≠ facilities state universe, §7.1) — confirm at demo |
| Districts covered | `/api/summary` → `districtsCovered` | **< 706** (distinct `district_name`, repeats across states) — confirm at demo |
| Average sex ratio | `/api/summary` → `avgSexRatio` | From `sex_ratio_total_f_per_1000_m`; may be `null` |
| Heatmap load, cache-cold | `/api/desert/heatmap-points` | < 10 s |
| Heatmap load, warm | `/api/desert/heatmap-points` | < 1 s |
| Gap score query, cache-cold | `/api/desert/state-gaps` | < 10 s |
| Top capability (by facility count) | `/api/desert/capability-summary` | Confirm at demo |

---

## 12. Prioritized Backlog

Priority is ordered by hackathon submission impact: completeness of track coverage first, then data integrity, then production hardening.

### P0 — Required for Submission Completeness

| # | Item | Track | Effort |
|---|---|---|---|
| 1 | Add a state-name crosswalk so the gap-score `FULL OUTER JOIN` matches `address_stateorregion` to `state_ut` reliably (§10.2) | Track 2 | S |
| 2 | Apply the negative-`trust_weight` fix (§10.3) after OV-2 | Track 1/2 | XS |
| 3 | Reconcile `capability-summary` grouping vs. `ILIKE` filter (split on comma both sides) | Track 2 | S |
| 4 | Scaffold Track 1 Facility Trust Desk: expand `/api/facilities` SELECT (source columns), add trust badge to table + detail panel | Track 1 | M |
| 5 | Add trust tier filter to facility browser | Track 1 | S |
| 6 | Scaffold Track 3 Referral Copilot: basic `/api/referral?city=&capability=` endpoint + UI | Track 3 | L |
| 7 | Scaffold Track 4 Data Readiness Desk: `/api/data-quality` completeness + duplicate report endpoint + UI; state which table (plain `facilities` vs `facilities_live`) each metric reflects (§8 Track 4 AC6) | Track 4 | L |

### P1 — Data Integrity (Blocks Lakebase Completeness)

| # | Item | Effort |
|---|---|---|
| 8 | Resolve `facilities.unique_id` duplicates (dedup or synthetic PK) to unblock Lakebase synced table | M |
| 9 | Complete `india_post_pincode_directory_live` Lakebase sync after quota slot available | S |
| 10 | Complete `facilities_live` Lakebase sync after duplicate resolution | S |
| 10a | Remediate null bytes on the **read path** (plain `facilities`) or repoint read endpoints to `_live` (Known Issue #16) | S |

### P2 — Security and Reliability

| # | Item | Effort |
|---|---|---|
| 11 | Replace single-quote escaping with true parameterized/bound queries across all server routes | M |
| 12 | Replace in-memory desert cache with persistent cache (Redis, or Databricks-backed key store) | M |
| 13 | Decide the Lakebase read path: either wire in the plugin + sample route (§4.1) and implement OLTP reads, or delete the orphaned scaffold (`todo-routes.ts`, `LakebasePage.tsx`) | M |
| 14 | Design and document the `syncing: true` UX before any route emits it; align `types.ts` to required `syncing: boolean` | S |
| 15 | Clamp `/api/facilities` `page` to `totalPages` (or return an over-range signal) | XS |

### P3 — Polish and Production Hardening

| # | Item | Effort |
|---|---|---|
| 16 | Add `CAST(latitude AS DOUBLE)` / `CAST(longitude AS DOUBLE)` to all `india_post` geographic queries | S |
| 17 | ~~Add error boundary and empty-state UI~~ — **Already implemented.** `App.tsx` uses a top-level `<ErrorBoundary>` plus per-route `errorElement` (`RouteErrorPage` → `ErrorDisplay`); `FacilitiesPage`/`DesertPage` have error banners, loading skeletons, and empty states. `client/src/ErrorBoundary.tsx` is canonical. **Remaining gap:** a dedicated cold-warehouse message vs. generic `HTTP <status>` error text | XS |
| 18 | Surface the heatmap bounding-box exclusion in the UI (e.g., "N facilities outside India bounds excluded") | XS |
| 19 | Add pagination to `/districts` (currently the full filtered set — up to 706 rows — is returned unbounded and rendered into the DOM) | S |

---

## 13. Out of Scope

The following are explicitly out of scope for the DAIS 2026 hackathon submission:

- Managed AI/BI (Lakeview) dashboards — all analytics are served via AppKit and SQL Warehouse queries.
- User authentication or access control — the app runs under App SP client ID `5ccf106a-7211-489d-a075-5ca82e07b0ae` with no per-user auth.
- Write-back to source (read-only) Delta tables — all writes target `_live` variants only.
- Mobile-responsive layout — a mobile nav sheet exists in `App.tsx`, but full responsive layout is not a stated requirement.
- Multi-workspace or cross-region deployment.

---

## 14. Deployment Reference

> **Working directory for all `databricks bundle`, `databricks apps`, and `npm` commands is `<repo>/virtue-health/`.** This is where `databricks.yml`, `app.yaml`, and `package.json` live, and what `source_code_path: ./` resolves against. When these docs say "bundle root," they mean `<repo>/virtue-health/`, **not** the git repository top level (`/Users/hz317604/Developer/dais27`).

### 14.1 DABs configuration (`databricks.yml`)

The actual bundle structure (the warehouse ID is supplied via a DABs variable, not a literal in the app block; the `sync.include` block contains **both** `dist/` and `client/dist/`):

```yaml
bundle:
  name: virtue-health

sync:
  include:
    - dist/
    - client/dist/

variables:
  warehouse_id:
    description: SQL Warehouse ID for analytics queries. Obtain from the workspace SQL Warehouses page.

resources:
  apps:
    app:                       # resource key is `app`, not `virtue-health`
      name: "virtue-health"    # only the display name is virtue-health
      description: "Healthcare data explorer for DAIS 2026 …"
      source_code_path: ./     # relative to <repo>/virtue-health/
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: ${var.warehouse_id}
            permission: CAN_USE

targets:
  default:
    default: true
    workspace:
      host: https://dbc-0a01f518-764a.cloud.databricks.com
    variables:
      warehouse_id: 5b2b29cce22aa2c4
```

> **`sync.include` ships two paths.** Both `dist/` (the built server bundle) **and** `client/dist/` (the built client assets) must be listed. Omitting `client/dist/` ships a bundle that serves the API but has no SPA to serve — the original single-entry (`dist/` only) form was incorrect.

### 14.2 App runtime (`app.yaml`)

The warehouse is injected from the bound resource via `valueFrom`, not a literal value:

```yaml
command: ['npm', 'run', 'start']
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse
```

> The `start` command runs the **pre-built** `./dist/server.js` — see §14.5. Lakebase env vars (§14.3) are declared but unused at runtime because the Lakebase plugin is not loaded (§4.1).

**Warehouse ID resolution chain** (where `DATABRICKS_WAREHOUSE_ID` actually comes from at runtime — useful when debugging "DATABRICKS_WAREHOUSE_ID not set"):
```
databricks.yml: targets.default.variables.warehouse_id = 5b2b29cce22aa2c4
       │  (substituted into)
       ▼
databricks.yml: resources.apps.app.resources[name=sql-warehouse].sql_warehouse.id = ${var.warehouse_id}
       │  (bound resource named "sql-warehouse")
       ▼
app.yaml: env DATABRICKS_WAREHOUSE_ID  valueFrom: sql-warehouse
       │
       ▼
server runtime: process.env.DATABRICKS_WAREHOUSE_ID === "5b2b29cce22aa2c4"
```

### 14.3 Local environment (`.env.example`)

The shipped `.env.example` contains **generic placeholders, not resolved values** (verified):

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

To populate these for local dev:
- Set `DATABRICKS_HOST` to the workspace URL (`https://dbc-0a01f518-764a.cloud.databricks.com`).
- Obtain the Postgres host/endpoint by first finding the Lakebase **branch**, then listing that branch's endpoints. A "branch" is a Lakebase Postgres branch within the project; you cannot supply a `<branch-name>` until you list them:
  ```bash
  # 1) list branches for the project
  databricks postgres list-branches --project virtue-health --profile deepak-workspace
  # 2) list endpoints for a chosen branch
  databricks postgres list-endpoints <branch-name> --profile deepak-workspace
  ```
  Confirm the exact subcommands against `databricks postgres --help` for your CLI version — if the branch-listing subcommand differs, use whatever `--help` reports rather than guessing `<branch-name>`.
- Since the Lakebase plugin is not currently loaded (§4.1), the `PG*` / `LAKEBASE_ENDPOINT` values are **unused at runtime today** — they only matter once Lakebase is wired in.
- `FLASK_RUN_HOST` is a leftover from a template and is unused (this is a Node/Express app, not Flask).
- **Port precedence:** Playwright's `baseURL` resolves to `http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`. Set `DATABRICKS_APP_PORT` (not `PORT`) for local dev so the server bind port and test base URL stay aligned.

### 14.4 Deploy commands

Run from `<repo>/virtue-health/`:

```bash
# Deploy DABs bundle
databricks bundle deploy -t default --profile deepak-workspace

# Deploy app (positional arg is the deployed app name)
databricks apps deploy virtue-health --profile deepak-workspace
```

> Log streaming: whether a dedicated `databricks apps logs virtue-health --follow` subcommand exists depends on the installed CLI version. **Discover it with `databricks apps --help`** (consistent across all docs); if `logs` is unavailable, retrieve logs from the app's compute/output in the workspace UI.

### 14.5 Build vs. run commands (mandatory build step)

The `npm run start` and `npm run dev` scripts are **not** interchangeable (verified against `package.json`):

- **Local development:** use **`npm run dev`** — `NODE_ENV=development tsx watch ... ./server/server.ts`. This is also what Playwright's `webServer.command` launches. A `predev` hook first runs `appkit plugin sync` + `appkit generate-types`.
- **Production / deploy:** `npm run start` is `NODE_ENV=production node ... ./dist/server.js` — it runs the **already-built** server and performs **no build**. It will **error if `dist/` does not exist**. Build first with **`npm run build`** (`build:server` then `build:client`; a `prebuild` hook runs `appkit plugin sync` + `appkit generate-types`).
- **Install side effect:** `npm install` triggers `postinstall: npm run typegen` (`appkit generate-types`).
- **Build tooling note:** the client build uses **`rolldown-vite@7.1.14`** (an npm `overrides` entry mapping `vite` → `npm:rolldown-vite`), not stock Vite. Server bundling uses `tsdown`.

### 14.6 Key resource IDs

- Workspace: `dbc-0a01f518-764a.cloud.databricks.com`
- SQL Warehouse: `5b2b29cce22aa2c4` (provided via `var.warehouse_id`)
- App SP Client ID: `5ccf106a-7211-489d-a075-5ca82e07b0ae`
- Lakebase endpoint: `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` (provisioned; not consumed at runtime — §4.1)
- Lakebase catalog: `` `virtue-pg` `` (hierarchy: catalog `` `virtue-pg` `` → database `databricks_postgres` → schema `virtue_foundation_dataset_silver`; backtick-quote the hyphenated catalog in SQL, §0.2)
- Databricks profile: `deepak-workspace`

---

## 15. Testing Reference

This section reflects the **actual** test configuration (verified against `vitest.config.ts`, `playwright.config.ts`, `tests/smoke.spec.ts`, and `package.json`).

- **vitest:** config sets `passWithNoTests: true`, `environment: 'node'`, `globals: true`, and excludes `**/*.spec.ts` plus `dist`/`node_modules`/`.databricks`. There is **no** coverage threshold and **no** `testMatch`. Today there are **zero** vitest test files — `vitest run` passes vacuously. Place new unit/integration tests in `server/__tests__/` or co-located `*.test.ts` (**not** `*.spec.ts`, which is excluded and reserved for Playwright). The assumed `server/__tests__` directory does not yet exist.
- **Playwright:** `testDir: './tests'`, single chromium project, `webServer.command: 'npm run dev'`, `baseURL = http://localhost:${DATABRICKS_APP_PORT||PORT||8000}`, `expect.timeout` 15s, CI retries 2. The only existing E2E file is **`tests/smoke.spec.ts`** (overview/facilities/districts load checks + console/page-error capture into `.smoke-test/`).
- **npm scripts:** `test` = `vitest run && npm run test:smoke`; `test:smoke` = `playwright install chromium && playwright test tests/smoke.spec.ts`; `test:e2e` = `playwright test`.
- **Test-assertion note (`facility_id`, not `unique_id`):** any unit test asserting facility row keys must assert **`facility_id`** (numeric), matching the API and client interfaces (§7.2) — a test expecting `unique_id` would be wrong. (Corresponds to `test-plan.md` U-FAC-02.)
- **Seed-test ID:** the zero-event CDF-log assertion after seeding is **`test-plan.md` P-TC-03**, not P-TC-01 (P-TC-01 is the row-count check) — cite the correct ID in any cross-reference (§5.3).
- **Load-bearing heading strings** for any E2E assertion: Overview `India Healthcare Overview` (brand `Virtue Health`), Facilities `Healthcare Facilities`, Districts `District Health Indicators` (columns include `Electricity`), Desert `Medical Desert Planner` (nav label `Desert Planner`). Confirm the exact KPI card titles by reading `OverviewPage.tsx`; the smoke test asserts `Total Facilities` / `States Covered` / `Districts Covered` but does **not** assert the 4th ("Avg Sex Ratio") card.
