# Virtue Health — Test Plan

**Project:** Virtue Health (DAIS 2026 Hackathon)
**Branch:** develop
**Date:** 2026-06-15
**Author:** Jody Larsen

---

## 0. How to read this document

**Working directory.** Every `databricks bundle`, `databricks apps`, `databricks postgres`, `npm`, `npx`, and `curl`-against-local command in this plan runs from **`<repo>/virtue-health/`** — the directory that contains `databricks.yml`, `app.yaml`, `package.json`, `vitest.config.ts`, and `playwright.config.ts`. The git repository top level is `<repo>/` (one level up); when this plan says "bundle root" it means `<repo>/virtue-health/`, **not** the repo top level.

**App naming convention (used throughout).** "virtue-health" denotes three different things; this plan disambiguates as follows:
- **bundle** = `virtue-health` (the DABs bundle name)
- **app resource key** = `app` (used in `databricks.yml` / `${resources.apps.app.*}` references)
- **deployed app name** = `virtue-health` (used in `databricks apps <cmd> virtue-health`)

**Canonical Known Issues.** The full rationale for each cross-cutting bug/risk (negative trust_weight, state-name join, Lakebase-not-wired, `syncing` client gating, capability filter/summary asymmetry, seed ordering) lives once in the project's canonical **Known Issues** location (`project-overview.md §10 Known Issues`). This document summarizes each in one line at the point of use and references the canonical entry; it does **not** restate the full rationale. The GAP-* IDs in §9 are this document's test-specific tracking of those issues.

**PK column-name note (load-bearing).** The API's facility identifier field is **`facility_id` (numeric)**, not `unique_id`. Every shipped query and client interface uses `facility_id`: `server/routes/virtue-health-routes.ts` selects `facility_id` in both the facilities and heatmap handlers, and the client interfaces (`client/src/pages/facilities/FacilitiesPage.tsx`, `client/src/pages/desert/types.ts`) declare `facility_id: number`. Some upstream/data-model documents describe the *physical* PK column as `unique_id` (with a known duplicate-value issue); regardless of the physical column name, the **API response field is `facility_id: number`** and this plan asserts on that. Any test that asserts a `unique_id` key on an API response row is **wrong** — assert `facility_id`. (Whether the physical column is also literally named `facility_id` is an open `DESCRIBE` task; it does not change the response-field assertions here.)

**Source-code references** use stable anchors (handler name + a short searchable snippet), not absolute line numbers, because line numbers rot on the next edit to the routes file. To locate a claim, open `server/routes/virtue-health-routes.ts` and search for the quoted snippet.

**Timing definitions** (used by all SLA targets below; see B4-derived §8 note):
- **warm** = SQL Warehouse `RUNNING` and the 5-minute in-memory cache populated for the endpoint under test.
- **cache-cold** = warehouse `RUNNING` but the in-memory cache empty (e.g., just after a server restart).
- **warehouse-cold** = warehouse stopped. A serverless cold start adds ~2–5 minutes and is **excluded** from every SLA in this plan.

All targets below assume a `RUNNING` warehouse (warm or cache-cold). Where a single target previously read "< 30s (cold)," it now means cache-cold with a running warehouse.

---

## 1. Scope and Objectives

This test plan covers all testable layers of the Virtue Health application:

- **Unit tests** — server route handler logic in isolation (mocked SQL)
- **Integration tests** — API endpoints against the real Databricks SQL Warehouse (`5b2b29cce22aa2c4`)
- **E2E tests** — browser-level page flows (Playwright)
- **Data pipeline tests** — CDF seeding verification, row counts, column sanitation
- **Lakebase sync verification** — TRIGGERED synced table checks via `psql`
- **Performance tests** — Desert Planner heatmap under load

Out of scope: Tracks 1, 3, and 4 (not yet implemented). Authentication and deployment infrastructure testing are out of scope for this iteration.

> **Current test reality (read first).** Today there are **zero** Vitest test files in the repo. `vitest.config.ts` sets `passWithNoTests: true`, so `vitest run` passes **vacuously** — every U-* (unit) and I-* (integration) case in this plan is **unwritten** and must be authored. The **only** existing automated test is `tests/smoke.spec.ts` (3 Playwright tests: overview / facilities / districts load checks). The U-*/I-*/E-* tables below are the target spec to build toward, not a description of existing coverage.

> **Important — all endpoints read from the SQL Warehouse.** Every production API route in `server/routes/virtue-health-routes.ts` issues `appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver` (the SQL Warehouse). None of them read from Lakebase Postgres. The facilities and summary reads target the **plain** `facilities` table (not `facilities_live`). Tests should mock/exercise the warehouse path for all real endpoints.

> **No Lakebase code is active.** The `lakebase` plugin is **not** registered in `server/server.ts` — `createApp` loads only `analytics({})` and `server()`, so `appkit.lakebase` does not exist at runtime. The sample `server/routes/lakebase/todo-routes.ts` exports `setupSampleLakebaseRoutes`, but it is **never imported or called** (`onPluginsReady` calls only `setupVirtueHealthRoutes`), and `client/src/pages/lakebase/LakebasePage.tsx` is **not** added to the router (no `/lakebase` route, no nav link). These are **orphaned scaffold files** — `/api/lakebase/todos` is not served at all. Do **not** write tests against a Lakebase application read path; none exists. The Lakebase sync tests in §7 verify the **sync pipeline**, not an app code path. (Canonical entry: Known Issues — Lakebase not wired.)

> **Response-shape convention.** Every endpoint returns a **JSON object** (not a bare array). The server always emits a `syncing: boolean` field (currently hardcoded `false` on all routes). Collection endpoints nest their rows under a named key (`facilities`, `states`, `districts`, `points`, `gaps`, `summary`). Tests must assert on the nested key, never on `Array.isArray(body)`.

> **`syncing` is load-bearing, not informational.** Although the server always sends `false` today, the client **gates behavior** on it: in `FacilitiesPage.tsx` the states dropdown is only populated when `syncing` is falsy (search for `!d.syncing && d.states`), and in `DesertPage.tsx` a blocking amber "Data syncing… map will appear once the sync is complete" banner renders instead of the map whenever `state-gaps` or `heatmap-points` report `syncing: true` (search for `isSyncing = gapsSyncing`). Tests that flip `syncing` to `true` (E2E mocks) **must** assert these consequences: states dropdown suppressed, desert map replaced by banner. Note the client TS interfaces in `client/src/pages/desert/types.ts` declare `syncing?: boolean` (**optional**) even though the server always includes it — do not assume the field is type-guaranteed present. (Canonical entry: Known Issues — `syncing` client contract.)

---

## 2. Test Infrastructure

### 2.1 Unit / Integration — Vitest

Config file (verified): `virtue-health/vitest.config.ts`. Real contents:

- `passWithNoTests: true`
- `globals: true`
- `environment: 'node'`
- `exclude: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts', '**/.smoke-test/**', '**/.databricks/**']`
- Path alias `@` → `client/src`
- **No** coverage config / thresholds. **No** `testMatch` / `testRoot`.

Consequences for authoring tests:

- `**/*.spec.ts` is **excluded** from Vitest and reserved for Playwright. Name new Vitest files `*.test.ts` (not `*.spec.ts`).
- The directories `src/__tests__/` and `server/__tests__/` do **not** exist yet. Place new server unit tests in `server/__tests__/` or co-locate as `*.test.ts` next to the handler.
- Coverage is **not** gated. If you want coverage gating, add a `coverage` block to `vitest.config.ts` first; do not assume thresholds exist.

Run commands (verified against `package.json`; run from `<repo>/virtue-health/`):

```bash
# All Vitest tests (none today → passes vacuously)
npx vitest run

# The repo's combined test script: Vitest then the Playwright smoke suite
npm test            # = "vitest run && npm run test:smoke"

# Coverage is NOT configured by default; add a coverage block to vitest.config.ts
# before relying on this:
# npx vitest run --coverage
```

Required environment variables for integration tests. **Use the variable names from the actual `virtue-health/.env.example`.** The real file ships **placeholders**, not real values:

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

> **Notes:**
> - The file ships **generic placeholders** (`your_postgres_host`, `your_postgres_endpointPath`, `https://...`), not concrete values. Copying `.env.example` to `.env` yields placeholders. To source the real Lakebase values you need the Lakebase **branch name** (see below), then run `databricks postgres list-endpoints <branch-name> --profile deepak-workspace` (per `appkit.plugins.json`). Set `DATABRICKS_HOST` to the workspace URL `https://dbc-0a01f518-764a.cloud.databricks.com`.
> - **Finding the `<branch-name>` for `list-endpoints`.** A Lakebase project has one or more *branches*; the endpoint command takes a branch name, which is not the same as the project name (`virtue-health`). List branches first, then pass the chosen branch:
>   ```bash
>   # List branches for the project (confirm exact subcommand against `databricks postgres --help`)
>   databricks postgres list-branches --project virtue-health --profile deepak-workspace
>   # Then list that branch's endpoints
>   databricks postgres list-endpoints <branch-name> --profile deepak-workspace
>   ```
>   If your CLI version names the branch-listing subcommand differently, run `databricks postgres --help` to find it — do not guess. (`<branch-name>` uses angle brackets to match this plan's other placeholders, e.g. `<capability>`.)
> - There is **no** `DATABRICKS_TOKEN`, `SQL_WAREHOUSE_ID`, or `LAKEBASE_PASSWORD` in `.env.example`. (Earlier drafts invented `SQL_WAREHOUSE_ID`, `LAKEBASE_DB`, `LAKEBASE_USER`, `LAKEBASE_PASSWORD` — these do not exist.) The SQL Warehouse is supplied to the deployed app via the DABs resource binding `sql-warehouse` (`app.yaml` uses `valueFrom: sql-warehouse`). For **local** integration tests you still need workspace auth (a Databricks CLI profile or a PAT) configured for `appkit.analytics.query()` to reach the warehouse; document the exact auth method your local harness uses.
> - Since the **Lakebase plugin is not loaded** (see §1), the `PG*` / `LAKEBASE_ENDPOINT` values are **unused at runtime today**. They matter only for §7 sync verification via `psql`, not for the app.
> - `FLASK_RUN_HOST` appears in `.env.example` even though the server is Node/Express; it is a leftover and unused by the app. Do not rely on it.
> - **Port resolution:** Playwright resolves `baseURL`/`webServer.url` as `http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`. Set `DATABRICKS_APP_PORT` (not `PORT`) for local dev so the server bind port and the test base URL stay aligned.

### 2.2 E2E — Playwright

Config file (verified): `virtue-health/playwright.config.ts`. Real contents:

- `testDir: './tests'`
- Single **chromium** project (`Desktop Chrome`)
- `webServer.command: 'npm run dev'`, `webServer.url: http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`, `reuseExistingServer: !CI`, `timeout: 120s`
- `expect.timeout: 15_000` (15s)
- `retries: 2` on CI, `0` locally; `workers: 1` on CI
- `fullyParallel: true`, `reporter: 'html'`, `trace: 'on-first-retry'`

The only existing E2E file is **`tests/smoke.spec.ts`** (3 tests). It asserts the verified heading strings (see §5) and captures console logs, page errors, and failed requests into `.smoke-test/` with a full-page screenshot per test.

Run commands (verified; from `<repo>/virtue-health/`):

```bash
npm run test:e2e        # = "playwright test" (all of ./tests)
npm run test:smoke      # = "playwright install chromium && playwright test tests/smoke.spec.ts"
npm run test:e2e:ui     # = "playwright test --ui"
```

> The `webServer` block runs **`npm run dev`** (tsx watch against `server/server.ts`), not a production build. Tests reuse an already-running dev server locally (`reuseExistingServer: !CI`).

---

## 3. Unit Tests — Server Route Logic

All unit tests mock `appkit.analytics.query()`. No real warehouse calls are made. (No Lakebase mock is needed — no production route touches Lakebase, and the plugin is not even loaded.) New files go in `server/__tests__/` or co-located `*.test.ts` (never `*.spec.ts`).

References below point to the relevant handler in `server/routes/virtue-health-routes.ts` by name and a searchable snippet, not by line number.

### 3.1 `/api/summary` — `GET /api/summary`

Handler (`/api/summary` — search for `total_facilities`) runs two queries in parallel:
- `SELECT COUNT(*) AS total_facilities FROM …facilities`
- `SELECT COUNT(DISTINCT state_ut) AS states_covered, COUNT(DISTINCT district_name) AS districts_covered, ROUND(AVG(sex_ratio_total_f_per_1000_m), 1) AS avg_sex_ratio FROM …nfhs_5_district_health_indicators`

Response: `{ totalFacilities, statesCovered, districtsCovered, avgSexRatio, syncing }`. **`avgSexRatio` is `number | null`** — it is set to `null` when the underlying average is null (search for `avg_sex_ratio` in the handler).

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-SUM-01 | Returns all KPI fields when warehouse returns valid data | Body contains `totalFacilities`, `statesCovered`, `districtsCovered`, `avgSexRatio`, `syncing` |
| U-SUM-02 | Returns HTTP 200 on success | `status === 200` |
| U-SUM-03 | Returns HTTP 500 when `appkit.analytics.query()` throws | `status === 500`, body `{ error: 'Failed to load summary' }` |
| U-SUM-04 | `avgSexRatio` is a number when source value is non-null | When mock returns a numeric `avg_sex_ratio`, `typeof body.avgSexRatio === 'number'` |
| U-SUM-05 | `avgSexRatio` is `null` when source value is null | When mock returns `avg_sex_ratio: null`, `body.avgSexRatio === null` |
| U-SUM-06 | `statesCovered`/`districtsCovered` derive from NFHS, not facilities | Mock NFHS query controls these counts; facilities mock does not affect them |
| U-SUM-07 | `syncing` is present and `false` | `body.syncing === false` |

### 3.2 `/api/facilities` — `GET /api/facilities`

Handler (`/api/facilities` — search for `Failed to load facilities`) returns `{ facilities, total, page, pageSize, totalPages, syncing }`. There is **no** `data` key. Each facility row contains **only** `facility_id, name, organization_type, address_city, address_stateorregion, address_country` (the SELECT — search for `facility_id, name, organization_type` in the facilities handler). It does **not** return `latitude`, `longitude`, `description`, `capability`, `source_types`, etc. **The identifier field is `facility_id` (numeric), not `unique_id`.**

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-FAC-01 | Returns paginated object with `page=1` (default) | `Array.isArray(body.facilities)`, `body.page === 1`, `body.pageSize === 50`, `typeof body.totalPages === 'number'`, `body.syncing === false` |
| U-FAC-02 | Each facility row has exactly the 6 selected columns | Row keys are `facility_id, name, organization_type, address_city, address_stateorregion, address_country`; `typeof row.facility_id === 'number'`; no `unique_id`, no `latitude/longitude/description` |
| U-FAC-03 | `search` param is forwarded to SQL (mocked) | SQL string contains an `ILIKE` clause on `name` and `address_city` with the search term |
| U-FAC-04 | `state` param is forwarded to SQL (mocked) | SQL string contains `address_stateorregion = '<state>'` |
| U-FAC-05 | `page=2` offsets by 50 rows | SQL string contains `OFFSET 50` |
| U-FAC-06 | Missing `search` and `state` returns unfiltered query | SQL string contains no `WHERE` clause |
| U-FAC-07 | Empty result set returns `{ facilities: [], total: 0, … }` | `body.facilities.length === 0`, `body.total === 0`, `body.totalPages === 0` |
| U-FAC-08 | **Single-quote escaping is applied** to `search` and `state` | With `search="O'Brien"`, SQL contains the doubled-quote form `O''Brien` (handler uses `.replace(/'/g, "''")` — search for `replace(/'/g`); with `state="X'); DROP TABLE facilities--"`, the embedded `'` is doubled |
| U-FAC-09 | `page` is floored at 1 but **not** clamped to `totalPages` | With `page=5000`, SQL issues a large `OFFSET` (e.g. `OFFSET 249950`), handler returns `facilities: []` with HTTP 200 and the real `total`/`totalPages` — no over-range error |
| U-FAC-10 | HTTP 500 on warehouse error | `status === 500`, body `{ error: 'Failed to load facilities' }` |

> **Security note (U-FAC-08):** The server does **not** use parameterized/bound queries, but it **does** escape single quotes via `.replace(/'/g, "''")` on `search`, `state`, and `capability` before interpolation. This mitigates basic quote-breakout injection. It is **not** equivalent to parameterized queries (easy to forget on a new route; does not defend against every edge case), so migration to bound parameters remains recommended (Known Issues — SQL string interpolation). Any test asserting the raw string is passed through verbatim is **wrong** — the value is escaped.

> **Over-range note (U-FAC-09):** `page` is floored to ≥1 via `Math.max(1, parseInt(...))` but is **not** clamped to `totalPages`. A direct API caller requesting a page beyond the last gets an empty `facilities` array with HTTP 200 and the true `total`/`totalPages`, with no over-range signal. The client's "Next" button is disabled only by comparing to `data.totalPages` client-side. Tracked as **GAP-16**.

### 3.3 `/api/facilities/states` — `GET /api/facilities/states`

Handler (`/api/facilities/states` — search for `Failed to load states`) returns `{ states: string[], syncing: false }` — **an object, not a bare array.** Deduplication is via `SELECT DISTINCT … ORDER BY` in SQL; `NULL`/empty states are filtered out.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-FST-01 | Returns `{ states: string[], syncing }` | `Array.isArray(body.states)`, each element is a string, `body.syncing === false` |
| U-FST-02 | Query uses `DISTINCT` and excludes null/empty | SQL string contains `DISTINCT` and `address_stateorregion IS NOT NULL AND address_stateorregion <> ''` |
| U-FST-03 | HTTP 500 on warehouse error | `status === 500`, body `{ error: 'Failed to load states' }` |

### 3.4 `/api/districts` — `GET /api/districts`

Handler (`/api/districts` — search for `Failed to load districts`) returns `{ districts: DistrictIndicator[], syncing: false }` — **an object, not a bare array.** The SELECT returns **only** these columns: `district_name, state_ut, households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct`. It does **not** return immunization, maternal-health, anemia, or blood-pressure columns. There is **no** `LIMIT`/`OFFSET` — the full filtered set is returned (see GAP-17).

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-DST-01 | Returns `{ districts: [...], syncing }` with `state` param | `Array.isArray(body.districts)`, `body.syncing === false` |
| U-DST-02 | Without `state` param the SQL has no state filter | SQL string contains no `WHERE state_ut = …` clause |
| U-DST-03 | With `state` param the SQL filters (escaped) | SQL string contains `state_ut = '<escaped-state>'` |
| U-DST-04 | Each row exposes exactly the 7 selected columns | Row keys are `district_name, state_ut, households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct` |
| U-DST-05 | SQL has no `LIMIT`/`OFFSET` (no pagination) | SQL string contains no `LIMIT` and no `OFFSET` |
| U-DST-06 | HTTP 500 on warehouse error | `status === 500`, body `{ error: 'Failed to load districts' }` |

### 3.5 `/api/districts/states` — `GET /api/districts/states`

Handler (`/api/districts/states` — search for `Failed to load district states`) returns `{ states: string[], syncing: false }` from `SELECT DISTINCT state_ut`.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-DSS-01 | Returns `{ states: string[], syncing }` | `Array.isArray(body.states)`, each element a string |
| U-DSS-02 | Query uses `DISTINCT state_ut` | SQL string contains `DISTINCT state_ut` |
| U-DSS-03 | HTTP 500 on warehouse error | `status === 500`, body `{ error: 'Failed to load district states' }` |

### 3.6 `/api/desert/heatmap-points`

Handler (`/api/desert/heatmap-points` — search for `heatmap-points:`) returns `{ points, syncing }`. Each point has fields `facility_id, latitude, longitude, trust_weight, capability, address_stateorregion` — matching the `HeatmapPoint` interface in `client/src/pages/desert/types.ts` (note `facility_id` is `number`, and `capability` / `address_stateorregion` are `string | null` there). **The identifier field is `facility_id` (numeric), not `unique_id`.** The WHERE clause requires non-null lat/lon **and** bounds them to India's bounding box: `latitude BETWEEN 6.0 AND 37.5`, `longitude BETWEEN 68.0 AND 97.5` (search for `BETWEEN 6.0 AND 37.5`). Points outside the box are **silently dropped**. Cache key is `heatmap-points:<capability>`, TTL 5 minutes.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-HM-01 | Returns `{ points: [...], syncing }` with the documented fields | Each point has `facility_id, latitude, longitude, trust_weight, capability, address_stateorregion`; `typeof point.facility_id === 'number'` |
| U-HM-02 | SQL applies the India bounding box | SQL contains `BETWEEN 6.0 AND 37.5` and `BETWEEN 68.0 AND 97.5` |
| U-HM-03 | Cache hit — second call within 5 minutes does not invoke `appkit.analytics.query()` | Mock called exactly once across two requests with the same `capability` |
| U-HM-04 | Cache miss after 5 minutes (mock `Date.now`) re-queries | Mock called twice |
| U-HM-05 | Cache key is scoped per `capability` with the `heatmap-points:` prefix | Two different `capability` values produce two cache entries; key collision with `state-gaps` is impossible due to the prefix |
| U-HM-06 | `capability` param filters SQL, escaped | SQL contains `capability ILIKE '%<escaped-capability>%'` |
| U-HM-07 | Trust weight formula `LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types),''),',')),1)/3.0, 1.0)` | With `source_types='a,b,c'`, `trust_weight === 1.0`; with `source_types='a'`, `trust_weight ≈ 0.333` |
| U-HM-08 | **Null/empty `source_types` edge case — VERIFY** | See warning below: in Spark, `SIZE(SPLIT(NULL,','))` returns `-1`, so `COALESCE(-1,1)` keeps `-1` and `trust_weight = LEAST(-1/3.0, 1.0) = -0.333` (negative). Assert the **actual** observed value against the warehouse; do **not** assume `0.333` |

> **Open defect to verify (U-HM-08, GAP-13).** `NULLIF(TRIM(source_types), '')` converts empty/whitespace to `NULL`, and `SIZE(SPLIT(NULL, ','))` evaluates to `-1` in Spark SQL (not `NULL`), so the `COALESCE(…, 1)` fallback never fires and the result is `LEAST(-1/3.0, 1.0) = -0.333` (negative). Confirm empirically against warehouse `5b2b29cce22aa2c4`; if reproduced, file a code defect and update the heatmap / state-gaps / capability-summary assertions. **Canonical recommended fix** (use this exact form, do **not** substitute a `GREATEST(..., 0.0)` clamp — see D2 note below):
> ```sql
> LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
> ```
> This makes NULL `source_types` resolve to the intended `0.333`. A `GREATEST(..., 0.0)` clamp would instead make a genuinely empty-source facility score **0.0**, not `0.333` — different semantics; do not mix the two. Full rationale: Known Issues — Negative trust_weight.

### 3.7 `/api/desert/state-gaps`

Handler (`/api/desert/state-gaps` — search for `Failed to load state gaps`) returns `{ gaps, syncing }`. Each gap row has: `state, facility_count, avg_trust_weight, source_type_variants, demand_index, district_count, supply_score, gap_score, confidence`. The handler computes `confidence` in JS (search for `'high'` / `'medium'`): `variants >= 3 ? 'high' : variants >= 1 ? 'medium' : 'low'`. Reference interface: `client/src/pages/desert/types.ts` (`StateGap`; note `demand_index` and `district_count` are `number | null`).

Key SQL facts:
- `demand_index` is a **deprivation-based demand proxy** computed from NFHS: `ROUND(((100 - AVG(hh_electricity_pct)) + (100 - AVG(hh_improved_water_pct)) + (100 - AVG(hh_use_improved_sanitation_pct)) + (100 - AVG(child_u5_whose_birth_was_civil_reg_pct))) / 4.0, 1)`, with each `AVG(...)` wrapped in `COALESCE(..., 50)`. The **field** is named `demand_index`; the **concept** is "deprivation-based demand" — they are the same number (higher deprivation ⇒ higher unmet demand). This plan uses `demand_index` for the field and "deprivation-based demand" for the concept.
- The numerator of `gap_score` uses `COALESCE(ns.demand_index, 50)` — states missing NFHS demand still get a default demand of `50`.
- The join is a **`FULL OUTER JOIN`** between NFHS states and facility states on a normalized key `LOWER(TRIM(state))`. States present in only one source still appear. `demand_index` and `district_count` are nullable.
- `gap_score = ROUND(COALESCE(demand_index, 50) / GREATEST(facility_count * avg_trust_weight / 10.0, 0.1), 2)`.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-SG-01 | Returns `{ gaps: [...], syncing }` with the full field set | Each gap has `state, facility_count, avg_trust_weight, source_type_variants, demand_index, district_count, supply_score, gap_score, confidence` |
| U-SG-02 | `confidence` derives from `source_type_variants` | `variants >= 3 → 'high'`, `1–2 → 'medium'`, `0 → 'low'` (assert all three boundaries) |
| U-SG-03 | Gap-score denominator is floored at 0.1 | With `facility_count=0`, `avg_trust_weight=0`, `demand_index=1`, `gap_score = round(1/0.1) = 10.0` |
| U-SG-04 | Missing NFHS demand defaults to 50 | When mocked SQL row has `demand_index = null`, downstream consumers must tolerate it; the SQL numerator already substitutes `50` (document, since the substitution happens in SQL not JS) |
| U-SG-05 | Cache key is `state-gaps:<capability>` | Two different `capability` values populate two separate cache entries |
| U-SG-06 | HTTP 500 on warehouse error | `status === 500`, body `{ error: 'Failed to load state gaps' }` |

> **Correctness caveat — state-name join (GAP-14).** The `FULL OUTER JOIN` matches facilities (`address_stateorregion`) to NFHS (`state_ut`) on `LOWER(TRIM(...))`. State-name mismatches (e.g., "NCT of Delhi" vs "Delhi", "Orissa" vs "Odisha", abbreviations) will **not** match — producing duplicate/unmatched rows, `null` demand or supply on one side, and inflated or default-50 gap scores. This is the single largest correctness risk in Track 2. The canonical remediation (run the `EXCEPT` diagnostic to enumerate actual mismatches in this dataset, then normalize both sides with a verified `CASE` crosswalk before joining) lives in Known Issues — State-name join mismatch; do not hand-author a crosswalk from the illustrative examples here without first running the diagnostic.

### 3.8 `/api/desert/capability-summary`

Handler (`/api/desert/capability-summary` — search for `capability-summary`) returns `{ summary, syncing }`. Each row has `capability, facility_count, avg_trust_weight, state_count`. Grouping is on the **raw `capability` string** via `COALESCE(NULLIF(TRIM(capability),''),'Unknown')` — it does **not** comma-split multi-capability values, so composite strings form distinct buckets. The query is `ORDER BY facility_count DESC LIMIT 20`, so it returns **at most** 20 rows.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| U-CS-01 | Returns `{ summary: [...], syncing }`, at most 20 entries | `Array.isArray(body.summary)`, `body.summary.length <= 20` |
| U-CS-02 | Each entry has `capability, facility_count, avg_trust_weight, state_count` | Fields present |
| U-CS-03 | Grouping is on the raw capability string (no comma split) | Mock data with `capability='A,B'` yields a single `'A,B'` bucket, not separate `A` and `B` |
| U-CS-04 | Cache key is the fixed string `capability-summary` | Mock called once across two requests |

> **Filter/summary mismatch (GAP-18):** the dropdown is populated with raw, un-split capability strings (composites like `'Emergency,Surgery,ICU'` are their own option), but `heatmap-points`/`state-gaps` filter via `capability ILIKE '%value%'`. Selecting a composite option filters on that exact comma-joined substring, which can return **fewer** facilities than the summary's `facility_count` for that bucket; selecting `'Emergency'` will also match composites containing it. Grouping is exact-string; filtering is substring — they are not symmetric. Tests exercising the dropdown→heatmap flow should assert this asymmetry rather than expecting `facility_count` to match the returned point count. (Canonical entry: Known Issues — Capability filter/summary asymmetry.)

---

## 4. Integration Tests — API Endpoints Against Real Warehouse

These tests run against the live Databricks SQL Warehouse (`5b2b29cce22aa2c4`). They are tagged `@integration` and excluded from the default CI run. They require valid workspace auth for the local harness (CLI profile or PAT, per §2.1). **None of these exist yet** — they must be authored as `*.test.ts` (not `*.spec.ts`). Timing targets use the definitions in §0 (warm / cache-cold; warehouse-cold excluded).

Source catalog/schema: `dais27hack.virtue_foundation_dataset_silver`

### 4.1 `GET /api/summary`

| Test ID | Assertion |
|---------|-----------|
| I-SUM-01 | `body.totalFacilities` is between 1 and 10,088 |
| I-SUM-02 | `body.statesCovered` is a positive integer (distinct `state_ut` from NFHS) |
| I-SUM-03 | `body.districtsCovered` is a positive integer (distinct `district_name` from NFHS). **Expect `< 706`**, since district names repeat across states (NFHS PK is `district_name + state_ut`), so distinct `district_name` is fewer than the 706 total rows |
| I-SUM-04 | `body.avgSexRatio` is either a positive number or `null` (nullable; from `sex_ratio_total_f_per_1000_m`) |
| I-SUM-05 | `body.syncing === false` |
| I-SUM-06 | Response time < 10s, cache-cold, running warehouse |

### 4.2 `GET /api/facilities`

| Test ID | Assertion |
|---------|-----------|
| I-FAC-01 | `body.facilities.length === 50` on the default page (when ≥ 50 rows match) |
| I-FAC-02 | `search=Apollo` returns only rows where `name` or `address_city` contains "Apollo" (case-insensitive `ILIKE`) |
| I-FAC-03 | `state=Maharashtra` returns only rows with `address_stateorregion = 'Maharashtra'` |
| I-FAC-04 | `page=2` returns a different set of 50 rows than `page=1` |
| I-FAC-05 | Each row contains exactly `facility_id, name, organization_type, address_city, address_stateorregion, address_country` (with `facility_id` numeric) and **no** `unique_id`, `latitude`, `longitude`, or `description` (those are not selected) |
| I-FAC-06 | No `name` value contains a null byte (` `) — validates the REPLACE fix. Note: this endpoint reads the **plain** `facilities` table, which (per the data-pipeline docs) may still contain null bytes; if a null byte surfaces, that is a confirmed read-path defect, not a test bug. (`description` is **not** returned by this endpoint, so it cannot be checked here; verify `description` sanitation in the data-pipeline tests §6.4 against `facilities_live`.) |
| I-FAC-07 | `body.total`, `body.page`, `body.pageSize` (===50), `body.totalPages`, `body.syncing` are all present |
| I-FAC-08 | `search="O'Brien"` does not error (single-quote escaping holds at the warehouse) |
| I-FAC-09 | `page` beyond `totalPages` (e.g. `page=5000`) returns HTTP 200 with `facilities: []` and the true `total`/`totalPages` (no over-range clamp — GAP-16) |

### 4.3 `GET /api/facilities/states`

| Test ID | Assertion |
|---------|-----------|
| I-FST-01 | `body.states` is a non-empty array of strings |
| I-FST-02 | No duplicate values in `body.states` |
| I-FST-03 | `"Maharashtra"` is present in `body.states` (sanity check) |

### 4.4 `GET /api/districts`

| Test ID | Assertion |
|---------|-----------|
| I-DST-01 | Without `state` filter, `body.districts` returns up to 706 rows (no `LIMIT` — entire filtered set in one response) |
| I-DST-02 | `state=Kerala` returns only rows with `state_ut = 'Kerala'` |
| I-DST-03 | Each row contains `district_name` and `state_ut` (composite-key fields) |
| I-DST-04 | Each row contains the access/coverage columns actually selected: `households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct`. **Do not** assert immunization/maternal/anemia columns — the endpoint does **not** return them |
| I-DST-05 | `body.syncing === false` |

### 4.5 `GET /api/districts/states`

| Test ID | Assertion |
|---------|-----------|
| I-DSS-01 | `body.states` is a non-empty array of strings |
| I-DSS-02 | No duplicate values |
| I-DSS-03 | `"Kerala"` (or another known NFHS state) is present |

### 4.6 `GET /api/desert/heatmap-points`

| Test ID | Assertion |
|---------|-----------|
| I-HM-01 | `body.points.length` ≥ some empirically-determined floor for all capabilities. Note this count is **bounded by the India bounding-box filter** (6–37.5 lat, 68–97.5 lon) — facilities with null or out-of-box coordinates are excluded. Establish the actual in-box count first, then assert against it, rather than assuming "≥ 1,000" |
| I-HM-02 | `latitude` and `longitude` are numeric (handler casts `CAST(latitude AS DOUBLE)`) |
| I-HM-03 | All returned `latitude` ∈ [6.0, 37.5] and `longitude` ∈ [68.0, 97.5] (bounding box enforced in SQL) |
| I-HM-04 | `trust_weight` is between 0.0 and 1.0 inclusive — **CONDITIONAL on GAP-13.** If the `SIZE(SPLIT(NULL,','))=-1` bug is confirmed, negative weights are possible for null `source_types` and this assertion will fail; apply the canonical fix in §3.6 first or weaken the assertion to match observed behavior |
| I-HM-05 | Each point also contains `facility_id` (numeric), `capability`, `address_stateorregion` |
| I-HM-06 | `capability=Primary Care` (example) returns a subset smaller than the full list |
| I-HM-07 | Response time, cache-cold, running warehouse < 30s |
| I-HM-08 | Response time, warm (cached within 5 minutes) < 1s |

### 4.7 `GET /api/desert/state-gaps`

| Test ID | Assertion |
|---------|-----------|
| I-SG-01 | `body.gaps` is a non-empty array |
| I-SG-02 | Each row has `state, facility_count, avg_trust_weight, source_type_variants, demand_index, district_count, supply_score, gap_score, confidence` |
| I-SG-03 | No `gap_score` is `NaN` or `Infinity` (division guard `GREATEST(..., 0.1)`) |
| I-SG-04 | `confidence` ∈ {`'high'`, `'medium'`, `'low'`} for every row |
| I-SG-05 | Because of the `FULL OUTER JOIN`, some rows may have `demand_index = null` (facility-only states) or `facility_count = 0` (NFHS-only states). Assert the join produces both kinds of rows where applicable, and document any `state` values that fail name normalization (GAP-14) |

### 4.8 `GET /api/desert/capability-summary`

| Test ID | Assertion |
|---------|-----------|
| I-CS-01 | `body.summary.length <= 20` (query is `LIMIT 20`; fewer distinct capability strings yield fewer rows) |
| I-CS-02 | `facility_count` values are in descending order |
| I-CS-03 | All `capability` values are non-null and non-empty (the SQL filters `TRIM(capability) <> ''`; `'Unknown'` fallback is present in the COALESCE but unreachable given the WHERE filter) |
| I-CS-04 | Each row has `avg_trust_weight` and `state_count` |

---

## 5. E2E Tests — Playwright

Config (verified): `virtue-health/playwright.config.ts` — `testDir: './tests'`, chromium-only, `webServer.command: 'npm run dev'`, `baseURL = http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`, `expect.timeout` 15s, CI retries 2.

The only existing E2E file is `tests/smoke.spec.ts` (3 tests covering overview/facilities/districts load + console/page-error capture into `.smoke-test/`). The E-* cases below extend it and must be authored as `*.spec.ts` under `./tests`.

**Verified heading / label strings** (use these exact strings — they are load-bearing and the smoke test already asserts most of them):

- Brand `<h1>`: **"Virtue Health"**
- Overview page heading: **"India Healthcare Overview"**
- Facilities page heading: **"Healthcare Facilities"** (table headers include **"Name"**, **"City"**)
- Districts page heading: **"District Health Indicators"** (column headers include **"District"**, **"Electricity"**)
- Desert page heading: **"Medical Desert Planner"**; nav label **"Desert Planner"**
- Nav links: **"Overview"**, **"Facilities"**, **"Districts"**, **"Desert Planner"**
- KPI card titles: **"Total Facilities"**, **"States Covered"**, **"Districts Covered"**, and a 4th card (intended "Avg Sex Ratio"). The smoke test asserts the first three but **not** the 4th — confirm the exact 4th-card title by reading `OverviewPage.tsx` before asserting it.

> **Mock the real response shapes.** When mocking API responses with `page.route`, use: `{ facilities, total, page, pageSize, totalPages, syncing }` (with each facility row keyed by `facility_id`, numeric), `{ states, syncing }`, `{ districts, syncing }`, `{ points, syncing }` (each point keyed by `facility_id`, numeric), `{ gaps, syncing }`, `{ summary, syncing }`. Mocking bare arrays will not match what the client expects, and mocking `unique_id` instead of `facility_id` will not match the client interfaces.

> **Same-origin / SPA-fallback dependency.** The Express process (AppKit `server` plugin) serves both the API (`/api/*`) and the built SPA from a single origin, so the client uses **relative** fetch paths. Client-side routes (`/facilities`, `/districts`, `/desert`) rely on the server plugin's SPA fallback (serving `index.html` for non-`/api` paths) so deep links and hard refreshes resolve. E-NAV-02 (direct URL to `/desert`) depends on this fallback; if a hard refresh 404s, the static/SPA-fallback config in the `server` plugin is where to look.

### 5.1 Overview Page (`/`)

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| E-OV-01 | Page loads without console errors | No `console.error` events (smoke test captures these into `.smoke-test/`) |
| E-OV-02 | Four KPI cards are visible | Four card elements render |
| E-OV-03 | KPI card "Total Facilities" shows a number close to 10,088 | Value is numeric and > 0 |
| E-OV-04 | KPI handles `avgSexRatio: null` gracefully | When `/api/summary` returns `avgSexRatio: null`, the 4th card shows a fallback (e.g., "—") and does not render "NaN" or crash |
| E-OV-05 | Loading state renders before data arrives | Skeleton or spinner visible briefly (mock slow network with `page.route`) |
| E-OV-06 | Error state renders when `/api/summary` returns 500 (`{ error: 'Failed to load summary' }`) | Error UI visible (the app uses `ErrorBoundary`/`ErrorDisplay`); page does not crash |
| E-OV-07 | Page headings are exact | Brand `<h1>` is **"Virtue Health"** and the page heading is **"India Healthcare Overview"** (not a substring match) |

### 5.2 Facilities Page (`/facilities`)

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| E-FAC-01 | Page loads and renders a table with rows; heading is "Healthcare Facilities" | Heading exact; table has at least one visible row; headers "Name"/"City" present |
| E-FAC-02 | Search input exists and is focusable | Input element present |
| E-FAC-03 | Typing "Apollo" triggers a filtered request | Network request to `/api/facilities?search=Apollo` observed |
| E-FAC-04 | State dropdown populates from `/api/facilities/states` | Mock returns `{ states: ["Maharashtra", …], syncing: false }`; dropdown options include "Maharashtra" |
| E-FAC-05 | **`syncing: true` suppresses the state dropdown** | Mock `/api/facilities/states` → `{ states: [...], syncing: true }`; dropdown is **not** populated (client gates on `!d.syncing` in FacilitiesPage — search for `!d.syncing && d.states`) |
| E-FAC-06 | Selecting a state filters the table | Table rows change after state selection |
| E-FAC-07 | Pagination "Next" loads page 2 | URL or data changes; first-row content differs from page 1 |
| E-FAC-08 | Table shows up to 50 rows per page | Row count ≤ 50 |
| E-FAC-09 | Empty result (`{ facilities: [], total: 0, … }`) shows empty state | "No facilities found" empty-state indicator visible |
| E-FAC-10 | Error state when `/api/facilities` returns 500 | Error message visible; no uncaught exception |

### 5.3 Districts Page (`/districts`)

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| E-DST-01 | Page loads; heading is "District Health Indicators" | Heading exact; table/list has at least one row |
| E-DST-02 | State filter dropdown is present and populated (from `/api/districts/states`, shape `{ states, syncing }`) | Options list non-empty |
| E-DST-03 | Filtering by a state reduces displayed records | Row count changes after selection |
| E-DST-04 | District and indicator columns are visible | Headers "District" and "Electricity" present (the access/coverage columns actually returned: electricity, water, sanitation, birth registration — not immunization/maternal/anemia) |
| E-DST-05 | All returned rows render (no pagination) | When unfiltered returns up to 706 rows, the page renders the full set (GAP-17) |
| E-DST-06 | Error state when `/api/districts` returns 500 | Error UI visible |

### 5.4 Desert Planner Page (`/desert`) — Track 2

The actual page (`DesertPage.tsx`) has materially more UI than "heatmap + gap table": a `DesertKpiBar`, a `DesertControls` panel with **Show Heatmap** / **Show Choropleth** / **Show Confidence Filter** toggles, a MapLibre map rendering both a heatmap layer and a choropleth state-fill layer, a clickable **state detail panel** (`DesertDetailPanel`), and a data-limitation disclosure banner. E2E coverage must include the choropleth, confidence filter, and detail panel.

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| E-DES-01 | Page loads without errors; heading is exact | No `console.error`; page heading is **"Medical Desert Planner"** |
| E-DES-02 | Heatmap map element renders | MapLibre map container element is visible |
| E-DES-03 | Capability selector is present (populated from `/api/desert/capability-summary`, shape `{ summary, syncing }`) | Dropdown element exists |
| E-DES-04 | Changing capability triggers new request | Request to `/api/desert/heatmap-points?capability=<value>` observed |
| E-DES-05 | State gap data renders (from `{ gaps, syncing }`) | At least one state row present; gap rows expose `gap_score`, `confidence` |
| E-DES-06 | Capability summary lists up to 20 capabilities | Up to 20 items rendered (`<= 20`) |
| E-DES-07 | Controls panel toggles work | `DesertControls` exposes Show Heatmap / Show Choropleth / Show Confidence Filter; toggling each changes the corresponding map layer / filter visibility |
| E-DES-08 | Choropleth layer renders when enabled | With Show Choropleth on, the state-fill layer is present (map-library-dependent — see GAP-07) |
| E-DES-09 | Clicking a state opens the detail panel | `DesertDetailPanel` opens with the selected state's gap data |
| E-DES-10 | **`syncing: true` shows the blocking banner instead of the map** | Mock `state-gaps` or `heatmap-points` → `syncing: true`; the amber "Data syncing… map will appear once the sync is complete." banner is visible and the map is suppressed (`isSyncing = gapsSyncing \|\| pointsSyncing`) |
| E-DES-11 | Loading state shown while heatmap data loads | Spinner/skeleton visible during mocked slow response |
| E-DES-12 | Error state when `/api/desert/state-gaps` returns 500 | `gapsError` message visible; map does not crash the page |
| E-DES-13 | Heatmap points render after data loads | Map layer / markers present. Note: only in-box points (6–37.5 lat, 68–97.5 lon) are returned, so off-box facilities never appear. Exact assertion is map-library-dependent (MapLibre / react-map-gl — see GAP-07) |

### 5.5 Navigation

| Test ID | Description | Assertion |
|---------|-------------|-----------|
| E-NAV-01 | Nav links navigate to all four routes | Clicking each nav item ("Overview", "Facilities", "Districts", "Desert Planner") loads the correct route without 404 |
| E-NAV-02 | Direct URL access to `/desert` works | Page loads without redirect (relies on SPA fallback — see §5 note) |
| E-NAV-03 | Unknown route shows 404 or redirect | No blank white page (per-route `errorElement`/`RouteErrorPage` exists) |

---

## 6. Data Pipeline Tests

These tests verify the CDF seeding pipeline and the integrity of the `_live` Delta tables in `dais27hack.virtue_foundation_dataset_silver`.

Run via Databricks notebook or `databricks-connect` with Spark access, or via Databricks SQL using the REST API.

> **Seed ordering — canonical (reconciled).** The seed/reload procedure used throughout this project is, in this exact order: **disable CDF → TRUNCATE → INSERT INTO … SELECT … → re-enable CDF.** TRUNCATE happens **while CDF is disabled**, so it is **not** logged as `delete` events, and the bulk INSERT also happens while CDF is disabled, so it is **not** logged as `insert` events. The result is a **clean CDF log** containing no seed events. This ordering is canonical in the runbook, `data-pipeline.md`, and `data-model.md`; if any of those still shows "TRUNCATE → disable CDF," it is stale and must be reconciled to this order. The CDF tests in §6.3 below are written to expect a clean log under this ordering.

### 6.1 Row Count Parity

```sql
-- Run in Databricks SQL against dais27hack.virtue_foundation_dataset_silver

-- Facilities
SELECT
  (SELECT COUNT(*) FROM facilities) AS src_count,
  (SELECT COUNT(*) FROM facilities_live) AS live_count;
-- Expected: live_count = src_count = 10,088

-- NFHS
SELECT
  (SELECT COUNT(*) FROM nfhs_5_district_health_indicators) AS src_count,
  (SELECT COUNT(*) FROM nfhs_5_district_health_indicators_live) AS live_count;
-- Expected: live_count = src_count = 706

-- India Post
SELECT
  (SELECT COUNT(*) FROM india_post_pincode_directory) AS src_count,
  (SELECT COUNT(*) FROM india_post_pincode_directory_live) AS live_count;
-- Expected: live_count = src_count = 165,627
```

| Test ID | Assertion |
|---------|-----------|
| P-RC-01 | `facilities_live` row count = 10,088 |
| P-RC-02 | `nfhs_5_district_health_indicators_live` row count = 706 |
| P-RC-03 | `india_post_pincode_directory_live` row count = 165,627 |

### 6.2 CDF Enablement Verification

```sql
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.facilities_live;
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live;
-- Expected: delta.enableChangeDataFeed = true
```

| Test ID | Assertion |
|---------|-----------|
| P-CDF-01 | `facilities_live` has `delta.enableChangeDataFeed = true` |
| P-CDF-02 | `nfhs_5_district_health_indicators_live` has `delta.enableChangeDataFeed = true` |
| P-CDF-03 | `india_post_pincode_directory_live` has `delta.enableChangeDataFeed = true` |

### 6.3 CDF Seed Integrity via `table_changes`

Under the canonical ordering (§6 note: CDF disabled across **both** TRUNCATE and INSERT, re-enabled only after), the seed produces a **clean CDF log** — no `insert` and no `delete` events for the seed version. CDF tracking begins only with subsequent app-driven writes. Row-count correctness is therefore asserted via `SELECT COUNT(*)` (§6.1), not via CDF events.

```sql
-- Determine the version at which CDF was (re-)enabled, then read changes AFTER it.
DESCRIBE HISTORY dais27hack.virtue_foundation_dataset_silver.facilities_live;

-- For any version v at/after re-enable with no app writes yet, this returns no seed rows:
SELECT _change_type, COUNT(*) AS cnt
FROM table_changes('dais27hack.virtue_foundation_dataset_silver.facilities_live', <reenable_version>)
GROUP BY _change_type;
-- Expected under canonical order: no 'insert'/'delete'/'update_*' rows attributable to the seed
```

| Test ID | Assertion |
|---------|-----------|
| P-TC-01 | Row count of `facilities_live` = 10,088 via `SELECT COUNT(*)` (the authoritative seed check; not CDF events) |
| P-TC-02 | Row count of `nfhs_5_district_health_indicators_live` = 706 via `SELECT COUNT(*)` |
| P-TC-03 | `table_changes` from the CDF re-enable version shows **no** seed-attributable `insert`/`delete`/`update_preimage`/`update_postimage` events (clean log under canonical ordering) |

> **Cross-reference note.** Any other document that cites "the zero-CDF-events expectation" should reference **P-TC-03** (the `table_changes` clean-log check), **not** P-TC-01. P-TC-01 is the row-count check; P-TC-03 is the zero-event check.

> **If the actual reload deviated from canonical order** (e.g., CDF was enabled during TRUNCATE or INSERT), the log will instead contain `delete` and/or `insert` events for the seed, and P-TC-03 will fail. That is a signal the seed did **not** follow the canonical order — fix the procedure and re-seed rather than weakening the assertion. There is no remaining cross-document conflict to reconcile: the canonical order is fixed in §6 and the assertions above match it.

### 6.4 Null Byte Sanitization

```sql
SELECT COUNT(*) AS null_byte_count
FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
WHERE name LIKE '% %' OR description LIKE '% %';
-- Expected: 0
```

| Test ID | Assertion |
|---------|-----------|
| P-NB-01 | Zero rows in `facilities_live` contain a null byte in `name` |
| P-NB-02 | Zero rows in `facilities_live` contain a null byte in `description` |

> **Read-path caveat.** This test verifies `facilities_live`, where null bytes were stripped. The production API reads the **plain** `facilities` table, which may still contain null bytes in `name`/`description` (Known Issues — Null bytes, status OPEN on the read path). Sanitation is therefore confirmed only for `_live`; integration test I-FAC-06 checks the read path separately.

### 6.5 Schema Spot-Check

```sql
DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities_live;
-- Verify the ACTUAL types of latitude/longitude (see Open Verification Tasks §6.7)

DESCRIBE dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live;
-- Verify: latitude STRING, longitude STRING (known issue — not DOUBLE); pincode BIGINT
```

| Test ID | Assertion |
|---------|-----------|
| P-SCH-01 | Record the **actual** type of `facilities_live.latitude` (see §6.7 OVT-1) |
| P-SCH-02 | Record the **actual** type of `facilities_live.longitude` (see §6.7 OVT-1) |
| P-SCH-03 | `india_post_pincode_directory_live.latitude` is `STRING` (known issue, not a failure) |
| P-SCH-04 | `india_post_pincode_directory_live.pincode` is `BIGINT` |

### 6.6 Unique ID Duplicate Check

> **Column-name note.** The API projects `facility_id` (numeric), but the *physical* PK column documented upstream is `unique_id`, which carries the duplicate-value defect. The query below targets the physical column as documented; if `DESCRIBE` (OVT-1) shows the physical column is actually named `facility_id`, run the same `GROUP BY … HAVING COUNT(*) > 1` check against `facility_id` instead.

```sql
SELECT unique_id, COUNT(*) AS cnt
FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
GROUP BY unique_id
HAVING COUNT(*) > 1;
-- Expected: 0 rows (known issue — currently fails; track as open defect)
```

| Test ID | Assertion |
|---------|-----------|
| P-UID-01 | Zero duplicate PK values in `facilities_live` — **KNOWN FAILING** (upstream issue, blocks Lakebase sync; Known Issues — Duplicate PK). Check the physical PK column (`unique_id` per upstream docs; confirm the real name via OVT-1) |

### 6.7 Open Verification Tasks

These questions are empirically answerable in seconds against warehouse `5b2b29cce22aa2c4`. They are tracked as open tasks with a place to record the result, not as permanent conditional prose. **When resolved, record the answer here and delete the conditional hedging in this and other docs.**

| Task ID | Open question | Exact command to run | Expected / record result |
|---------|---------------|----------------------|--------------------------|
| OVT-1 (GAP-15) | Are `facilities.latitude/longitude` actually `DOUBLE` or `STRING`? And is the physical PK column named `facility_id` or `unique_id`? | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | If lat/lon are `DOUBLE`: the heatmap `CAST(... AS DOUBLE)` is redundant/defensive; assert `DOUBLE` in P-SCH-01/02. If `STRING`: docs claiming `DOUBLE` are wrong and must be corrected. Also record whether the physical identifier column is `facility_id` or `unique_id` (the API response field is `facility_id` regardless). **Result:** `____` (owner: TBD, opened 2026-06-15) |
| OVT-2 (GAP-13) | Does null/empty `source_types` actually yield a negative `trust_weight` (`-0.333`)? | `SELECT trust_weight_expr FROM …` using the §3.6 formula against a known-null-`source_types` facility, or directly `SELECT SIZE(SPLIT(NULL, ','));` | If `SIZE(SPLIT(NULL,','))` returns `-1` (expected in Spark), confirm `-0.333` reproduces, apply the canonical fix in §3.6, and update U-HM-08 / I-HM-04 / state-gaps & capability-summary trust assertions. **Result:** `____` (owner: TBD, opened 2026-06-15) |

---

## 7. Lakebase Sync Verification

> **Reminder:** No production API endpoint reads from Lakebase, and the **Lakebase plugin is not even loaded** in `server/server.ts` (`appkit.lakebase` is unavailable at runtime). The sample todo routes (`server/routes/lakebase/todo-routes.ts`) and `LakebasePage.tsx` are orphaned, never wired in (Known Issues — Lakebase not wired). These tests verify the *sync pipeline* itself, not an application read path. The application read path through Lakebase for facilities/districts is aspirational and not yet implemented.

> **Terminology.** Databricks calls these objects **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables …`). They are the same object; this section uses "synced table" in prose and the CLI's `online-tables` noun in commands.

Lakebase project: `virtue-health`
UC catalog: `virtue-pg` — **note the hyphen; in any SQL/DDL it must be backtick-quoted: `` `virtue-pg` ``.** Unquoted `virtue-pg` is a syntax error, and `virtue_pg` (underscore) is simply the wrong catalog name.
Postgres endpoint: `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`
Database: `databricks_postgres`
Schema: `virtue_foundation_dataset_silver`

Connect using `psql`:

```bash
psql "host=ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com \
      dbname=databricks_postgres \
      sslmode=require"
```

> **Synced-table DDL is Lakebase-version-specific and is NOT verified against this workspace.** Before running any `CREATE … TABLE` here, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version). The form below is a **template**, not a known-good command. Use the four-level, backtick-quoted catalog path (`` `virtue-pg` ``.`databricks_postgres`.schema.table) consistently — note the `databricks_postgres` database level between the catalog and the schema:
> ```sql
> -- TEMPLATE — verify syntax before use
> CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table>
>   PRIMARY KEY (...)
>   FROM dais27hack.virtue_foundation_dataset_silver.<table>_live
>   WITH SCHEDULING POLICY = TRIGGERED;
> ```

### 7.1 NFHS Table Sync (ONLINE)

```sql
SELECT COUNT(*) FROM virtue_foundation_dataset_silver.nfhs_5_district_health_indicators;
-- Expected: 706

SELECT district_name, state_ut
FROM virtue_foundation_dataset_silver.nfhs_5_district_health_indicators
LIMIT 5;
```

| Test ID | Assertion |
|---------|-----------|
| L-NHS-01 | `nfhs_5_district_health_indicators` in Lakebase has 706 rows |
| L-NHS-02 | `district_name` and `state_ut` columns are populated (non-null spot check) |
| L-NHS-03 | Table is accessible from the app service principal (client ID `5ccf106a-7211-489d-a075-5ca82e07b0ae`) |

### 7.2 Facilities Sync (Pending — blocked by duplicate PK)

```sql
SELECT COUNT(*) FROM virtue_foundation_dataset_silver.facilities_live;
-- Expected: 10,088 — WILL FAIL until the duplicate PK issue is resolved upstream
```

| Test ID | Assertion |
|---------|-----------|
| L-FAC-01 | `facilities_live` in Lakebase has 10,088 rows — **BLOCKED** pending upstream duplicate-PK fix |

### 7.3 India Post Sync (Pending — quota limit)

```sql
SELECT COUNT(*) FROM virtue_foundation_dataset_silver.india_post_pincode_directory_live;
-- Expected: 165,627 — PENDING (quota: 1 concurrent pipeline)
```

| Test ID | Assertion |
|---------|-----------|
| L-IND-01 | `india_post_pincode_directory_live` in Lakebase has 165,627 rows — **PENDING** |

### 7.4 Sync Staleness Check

Lakebase synced tables are in TRIGGERED mode. Verify data is not stale after a known write.

```sql
-- In Databricks SQL: insert a canary row into nfhs_5_district_health_indicators_live
INSERT INTO dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  (district_name, state_ut)
VALUES ('TEST_DISTRICT_CANARY', 'TEST_STATE_CANARY');

-- Trigger sync (mechanism unknown — see note)

-- In psql: verify canary row arrived
SELECT * FROM virtue_foundation_dataset_silver.nfhs_5_district_health_indicators
WHERE district_name = 'TEST_DISTRICT_CANARY';

-- Cleanup
DELETE FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
WHERE district_name = 'TEST_DISTRICT_CANARY';
```

> **Note:** The manual trigger mechanism for a TRIGGERED-mode synced table is not documented in the project context. This test is partially specified; confirm the CLI/API trigger step (`databricks online-tables --help`) before execution.

| Test ID | Assertion |
|---------|-----------|
| L-SYNC-01 | Canary row written to `_live` Delta table appears in Lakebase after trigger |
| L-SYNC-02 | Canary row deletion propagates to Lakebase after next trigger |

---

## 8. Performance Tests

> **Local run note:** start the app with `npm run dev` from `<repo>/virtue-health/` (not `npm run start`, which runs the pre-built `dist/server.js` and errors if `dist/` is absent). The default port is `DATABRICKS_APP_PORT || PORT || 8000`.

> **Timing definitions (per §0):** "warm" = warehouse `RUNNING` + cache populated; "cache-cold" = warehouse `RUNNING`, cache empty; "warehouse-cold" = warehouse stopped (adds ~2–5 min serverless cold-start, **excluded** from all SLAs). All targets below assume a `RUNNING` warehouse.

### 8.1 Desert Planner Heatmap

**Objective:** Verify `/api/desert/heatmap-points` handles the in-box facilities set and returns within an acceptable SLA.

**Setup:** Clear the in-memory cache before a cache-cold run (restart the app server; there is no cache-clear endpoint).

```bash
# Cache-cold: warehouse RUNNING, cache empty, no capability filter. Response is { points: [...], syncing }.
time curl -s "http://localhost:8000/api/desert/heatmap-points" | jq '.points | length'
# Returns the in-box facility count (≤ 10,088; bounding-box filtered to 6–37.5 lat, 68–97.5 lon)
# Target: < 10s cache-cold

# Warm call (within 5-minute window, cache populated)
time curl -s "http://localhost:8000/api/desert/heatmap-points" | jq '.points | length'
# Target: < 1s (in-memory Map hit, cache key prefix 'heatmap-points:')
```

| Test ID | Metric | Target |
|---------|--------|--------|
| PERF-HM-01 | TTFB, cache-cold, no capability filter | < 10s (cache-cold, running warehouse) |
| PERF-HM-02 | Response size for the in-box point set (6 fields/row) | Monitor; document baseline (includes `facility_id`, `capability`, `address_stateorregion`, so larger than a lat/lon/trust-only payload) |
| PERF-HM-03 | TTFB, warm (cache hit) | < 1s |
| PERF-HM-04 | Node heap per cache key | Monitor; document baseline (keys are `heatmap-points:<capability>`) |
| PERF-HM-05 | 5 simultaneous cache-cold calls | No OOM; all return 200 |

### 8.2 State Gap Scoring Performance

```bash
time curl -s "http://localhost:8000/api/desert/state-gaps" | jq '.gaps | length'
# Target: < 10s cache-cold (running warehouse), < 1s warm
```

| Test ID | Metric | Target |
|---------|--------|--------|
| PERF-SG-01 | Cache-cold state-gaps response time | < 10s (cache-cold, running warehouse) |
| PERF-SG-02 | Warm state-gaps response time | < 1s |

### 8.3 Facilities Pagination at Scale

```bash
# Last real page (worst case offset). Response is { facilities: [...], total, page, pageSize, totalPages, syncing }.
time curl -s "http://localhost:8000/api/facilities?page=202" | jq '.facilities | length'
# 10,088 / 50 = ~202 pages; OFFSET 10050 → returns rows 10051–10088 (38 rows)
# Target: < 15s
```

| Test ID | Metric | Target |
|---------|--------|--------|
| PERF-FAC-01 | Response time for last page (`page=202`, OFFSET 10050) | < 15s |
| PERF-FAC-02 | Over-range page (`page=5000`, OFFSET 249950) returns empty quickly | HTTP 200, `facilities: []`, no error (GAP-16); document response time |

### 8.4 Districts Full-Payload (no pagination)

```bash
time curl -s "http://localhost:8000/api/districts" | jq '.districts | length'
# No LIMIT/OFFSET — returns the entire filtered set (up to 706 rows) in one response (GAP-17)
```

| Test ID | Metric | Target |
|---------|--------|--------|
| PERF-DST-01 | Unfiltered `/api/districts` returns full set in one payload | Up to 706 rows; document payload size and response time |

---

## 9. Known Test Gaps and Risks

> **Status legend** (applies to the Status framing of each row): **OPEN** = needs work, no decision made; **ACCEPTED** = known and intentionally not fixed for this iteration (rationale stated); **BLOCKED** = needs an external/upstream fix before it can proceed; **RESOLVED** = fixed. The Risk Level column is severity, independent of status.

The full rationale for the cross-cutting items lives in the canonical Known Issues location; the entries below are this plan's test-specific tracking.

| Gap ID | Status | Area | Description | Risk Level |
|--------|--------|------|-------------|------------|
| GAP-01 | OPEN | Security | Server uses string interpolation with single-quote escaping (`.replace(/'/g, "''")`), not parameterized queries. Mitigates basic quote-breakout but is fragile (easy to omit on new routes). Migrate to bound parameters | **Medium** |
| GAP-02 | ACCEPTED | Cache | In-memory `Map` cache for Desert endpoints is not shared across app instances; not persistent across restarts; no cache-clear endpoint; no explicit TTL-eviction edge-case test | **Medium** |
| GAP-03 | BLOCKED | Lakebase sync | `facilities_live` and `india_post_pincode_directory_live` sync tests are blocked (duplicate PK / quota limit) | **High** |
| GAP-04 | ACCEPTED | `india_post` lat/lon | `latitude`/`longitude` in `india_post_pincode_directory` are `STRING`, not `DOUBLE`; no API endpoint currently uses this table | **Low** now, **High** when Track 3 (Referral Copilot) is implemented |
| GAP-05 | OPEN | Tracks 1, 3, 4 | Not implemented — no tests possible (deferred) | **N/A** |
| GAP-06 | OPEN | Auth / SP | No tests verify the app service principal (`5ccf106a-7211-489d-a075-5ca82e07b0ae`) has correct permissions on `dais27hack…` and Lakebase | **Medium** |
| GAP-07 | ACCEPTED | E2E heatmap/choropleth rendering | Map is **MapLibre GL** (`maplibre-gl` ^5.24) + `react-map-gl` ^8.1 (`DesertMap.tsx`); marker/layer assertions for heatmap and choropleth are library-specific. Pixel/marker-count assertions need page inspection to finalize | **Low** |
| GAP-08 | OPEN | Lakebase TRIGGERED trigger | Manual trigger mechanism for TRIGGERED synced tables is undocumented; L-SYNC-01 is partially specified (confirm via `databricks online-tables --help`) | **Medium** |
| GAP-09 | OPEN | Test coverage baseline | **Zero** Vitest tests exist; `passWithNoTests: true` means `vitest run` passes vacuously. No coverage config / thresholds. All U-*/I-* cases are unwritten | **High** |
| GAP-10 | ACCEPTED | `playwright.config.ts` | Single chromium project only (no Firefox/WebKit); `webServer` runs `npm run dev`; only `tests/smoke.spec.ts` (3 tests) exists today. Cross-browser coverage absent | **Low** |
| GAP-11 | ACCEPTED | `/api/districts` columns | Endpoint returns only 7 access/coverage columns (electricity, water, sanitation, birth registration, households surveyed). Immunization/maternal/anemia indicators exist in the source table but are **not** exposed by the API, so no API test can assert them | **Low** |
| GAP-12 | BLOCKED | Duplicate PK | Source table has duplicate values in the physical PK column (`unique_id` per upstream docs); blocks `facilities_live` Lakebase sync; all Lakebase facility read paths blocked. (The API itself projects `facility_id`, a different field.) | **High** |
| GAP-13 | OPEN | Trust-weight NULL edge case | `SIZE(SPLIT(NULL, ','))` returns `-1` in Spark, so `COALESCE(…, 1)` never fires and null `source_types` may yield a **negative** trust_weight (`-0.333`). Affects U-HM-08, I-HM-04, and trust-weight rows in state-gaps/capability-summary. Canonical fix and the verify task are in §3.6 and §6.7 (OVT-2) | **Medium** |
| GAP-14 | OPEN | State-name join mismatch | `state-gaps` joins facilities (`address_stateorregion`) to NFHS (`state_ut`) on `LOWER(TRIM(...))`. Name variants (Delhi/NCT of Delhi, Orissa/Odisha, abbreviations) won't match → unmatched/duplicate rows, null demand/supply, and default-50 or inflated gap scores. Largest Track 2 correctness risk; canonical crosswalk remediation in Known Issues | **High** |
| GAP-15 | OPEN | facilities lat/lon type & PK column name | Heatmap query `CAST(... AS DOUBLE)` on `facilities.latitude/longitude`. Docs claim `DOUBLE` (cast would be redundant); if `DESCRIBE` shows `STRING`, docs and P-SCH-01/02 are wrong. Also resolve whether the physical PK column is `facility_id` or `unique_id` (OVT-1). The API response field is confirmed `facility_id: number` regardless | **Low** |
| GAP-16 | ACCEPTED | Facilities over-range page | `page` floored at 1 but **not** clamped to `totalPages`. Requesting a page beyond the last returns HTTP 200 with `facilities: []` and the true `total`/`totalPages` — no over-range signal. Direct API callers must compare `page` to `totalPages` themselves | **Low** |
| GAP-17 | ACCEPTED | `/districts` no pagination | `/api/districts` applies no `LIMIT`/`OFFSET`; returns the entire filtered set (up to 706 rows) in one response and the page renders every row into the DOM. Acceptable at 706 rows; a scaling note for future growth | **Low** |
| GAP-18 | OPEN | Capability filter/summary asymmetry | `capability-summary` groups on the raw (un-split) capability string, but `heatmap-points`/`state-gaps` filter via `capability ILIKE '%value%'`. Selecting a composite dropdown option can return fewer facilities than its summary `facility_count`; `'Emergency'` also matches composites. Grouping is exact-string, filtering is substring — not symmetric | **Medium** |
| GAP-19 | OPEN | `syncing` client contract | `syncing` is hardcoded `false` server-side but is **load-bearing** client-side: `true` suppresses the Facilities state dropdown and replaces the Desert map with a banner. Client TS types mark `syncing?` optional though the server always sends it. No test currently exercises the `syncing: true` UX | **Medium** |
| GAP-20 | RESOLVED (doc) | API identifier field name | Several upstream docs described the facility API identifier as `unique_id: string`; the shipped API (handlers + client interfaces) uses **`facility_id: number`**. Test assertions (U-FAC-02, U-HM-01, I-FAC-05, I-HM-05, E2E mocks) now assert `facility_id`. Open sub-item: whether the *physical* column is also named `facility_id` (OVT-1) | **Low** |

---

## 10. Test Execution Order

For a full regression run (all commands from `<repo>/virtue-health/`):

1. **Unit tests** (`npx vitest run`) — no external dependencies. **Note:** none exist yet; this passes vacuously until authored
2. **Integration tests** (`*.test.ts`, tagged `@integration`) — requires warehouse availability and local workspace auth
3. **Data pipeline tests** — run via Databricks SQL notebook or REST API (resolve §6.7 Open Verification Tasks here)
4. **Lakebase sync verification** — requires `psql` access and resolved blocking issues
5. **E2E tests** (`npm run test:e2e`, or `npm run test:smoke` for the existing suite) — Playwright starts the app via `npm run dev`
6. **Performance tests** — run in isolation, after E2E, on a warm warehouse, against an `npm run dev` server

The repo's combined `npm test` runs step 1 and the smoke subset of step 5 (`vitest run && npm run test:smoke`).

---

## 11. References

- Working directory for all commands: `<repo>/virtue-health/` (contains `databricks.yml`, `app.yaml`, `package.json`)
- Workspace: `https://dbc-0a01f518-764a.cloud.databricks.com`
- SQL Warehouse ID: `5b2b29cce22aa2c4` (supplied to the app via DABs variable `warehouse_id` / resource binding `sql-warehouse`)
- Lakebase endpoint: `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`
- Lakebase catalog: `` `virtue-pg` `` (backtick-required in SQL), database: `databricks_postgres`, schema: `virtue_foundation_dataset_silver`
- Source catalog/schema: `dais27hack.virtue_foundation_dataset_silver`
- App service principal client ID: `5ccf106a-7211-489d-a075-5ca82e07b0ae`
- App naming: **bundle** `virtue-health`; **app resource key** `app`; **deployed app name** `virtue-health` (see §0)
- Deploy profile: `deepak-workspace`
- Canonical Known Issues: `project-overview.md §10`
- API identifier field is `facility_id: number` (NOT `unique_id`): `virtue-health/server/routes/virtue-health-routes.ts` (facilities + heatmap SELECTs), `virtue-health/client/src/pages/facilities/FacilitiesPage.tsx`, `virtue-health/client/src/pages/desert/types.ts`
- Server bootstrap / plugin registration (lakebase NOT loaded): `virtue-health/server/server.ts`
- Server route source of truth: `virtue-health/server/routes/virtue-health-routes.ts`
- Orphaned Lakebase scaffold (never imported): `virtue-health/server/routes/lakebase/todo-routes.ts`, `virtue-health/client/src/pages/lakebase/LakebasePage.tsx`
- Client router (no `/lakebase` route): `virtue-health/client/src/App.tsx`
- Facilities `syncing` gate (search `!d.syncing && d.states`): `virtue-health/client/src/pages/facilities/FacilitiesPage.tsx`
- Desert `syncing` banner + choropleth/confidence controls (search `isSyncing = gapsSyncing`): `virtue-health/client/src/pages/desert/DesertPage.tsx`
- Desert types (`syncing?` optional; `facility_id: number`): `virtue-health/client/src/pages/desert/types.ts`
- Env var reference (placeholders only): `virtue-health/.env.example`
- Lakebase env-var origins / `databricks postgres list-endpoints` (needs `<branch-name>`, see §2.1): `virtue-health/appkit.plugins.json`
- Unit/integration test config (passWithNoTests, no coverage): `virtue-health/vitest.config.ts`
- E2E test config (chromium-only, `webServer: npm run dev`): `virtue-health/playwright.config.ts`
- Existing E2E suite (verified heading strings): `virtue-health/tests/smoke.spec.ts`
- Frontend deps incl. maps: `virtue-health/package.json` (`maplibre-gl` ^5.24, `react-map-gl` ^8.1, `rolldown-vite` 7.1.14 override; `start` runs `dist/server.js`, `dev` is tsx watch)
