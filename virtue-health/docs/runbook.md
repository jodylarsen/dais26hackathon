All findings confirmed against source. Now I'll produce the rewritten runbook.

Confirmed: `databricks.yml`, `app.yaml`, `package.json` all live under `virtue-health/` (finding F4 applies — working directory is the subdirectory, not the repo top level).

# Virtue Health — Operations Runbook

**App (deployed name):** `virtue-health`
**Workspace:** https://dbc-0a01f518-764a.cloud.databricks.com
**Profile:** deepak-workspace
**Last updated:** 2026-06-15

---

## 0. Read This First — Conventions, Working Directory, Glossary

### 0.1 Working directory (applies to every command in this runbook)

**Run all `databricks bundle`, `databricks apps`, and `npm` commands from `<repo>/virtue-health/`.** This is the directory that contains `databricks.yml`, `app.yaml`, and `package.json`, and is what `source_code_path: ./` in the bundle resolves against (verified: these files live under `virtue-health/`, a subdirectory of the git repo root `/Users/hz317604/Developer/dais27`). Where this runbook says "bundle root," it means `<repo>/virtue-health/`, **not** the git repository top level.

### 0.2 The three meanings of "virtue-health"

`virtue-health` is overloaded. To disambiguate, this runbook uses the following convention consistently:

| Term | Value | Where it appears |
|---|---|---|
| **bundle** | `virtue-health` | `databricks.yml` `bundle.name` |
| **app resource key** | `app` | DABs config and `${resources.apps.app...}` references |
| **deployed app name** | `virtue-health` | `databricks apps <cmd> <name>` commands |

When a CLI command takes the **deployed app name**, we write `virtue-health`. When DABs config references the **resource**, we write `app`. They are not interchangeable.

### 0.3 "Synced table" = "online table"

Databricks calls these objects **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables ...`). They are the same object. This runbook uses "synced table" in prose and the CLI's `online-tables` noun in commands.

### 0.4 SQL identifier rules for the Lakebase catalog

The UC catalog name is **`virtue-pg`** (hyphen). Because it contains a hyphen, it **must be backtick-quoted in all SQL/DDL**: `` `virtue-pg` ``. Unquoted `virtue-pg` is a syntax error. `virtue_pg` (underscore) is simply the wrong catalog — do not use it. Full Lakebase addressing is four levels: `` `virtue-pg` `` (UC catalog) → `databricks_postgres` (Postgres database) → `virtue_foundation_dataset_silver` (schema) → `<table>`.

### 0.5 Glossary

| Acronym | Expansion |
|---|---|
| DABs | Databricks Asset Bundles |
| CDF | Change Data Feed |
| DLT | Delta Live Tables |
| OLTP | Online Transaction Processing |
| SP | Service Principal |
| NFHS-5 | National Family Health Survey, Round 5 |

### 0.6 Placeholder convention

Substitutable placeholders use angle brackets: `<deployment-id>`, `<capability>`, `<branch-name>`, `<table>`. Replace the entire bracketed token (brackets included) with your value.

### 0.7 Facility identifier: the API returns `facility_id` (numeric), not `unique_id`

**The API response field for a facility is `facility_id: number`, not `unique_id: string`.** Verified in source:

- `server/routes/virtue-health-routes.ts:72` selects `facility_id, name, organization_type, ...` (facilities list)
- `server/routes/virtue-health-routes.ts:167` selects `facility_id` (heatmap)
- `client/src/pages/desert/types.ts:14` → `facility_id: number;`
- `client/src/pages/facilities/FacilitiesPage.tsx:20` → `facility_id: number;`

The data model documents the upstream physical PK as `unique_id` (with a known duplicate-value issue), but **no shipped query or client interface projects `unique_id`** — every API response uses `facility_id`. Throughout this runbook (and in any companion doc), API-response facility shapes use `facility_id: number`. Whether the underlying physical column is also literally named `facility_id` is a separate, lower-stakes question; the response contract is settled.

---

## Table of Contents

1. [Deployment](#1-deployment)
2. [Checking App Status](#2-checking-app-status)
3. [Connecting to Lakebase Postgres](#3-connecting-to-lakebase-postgres)
4. [Synced Table Lifecycle](#4-synced-table-lifecycle)
5. [DATABASE_TABLE_SYNC Quota Issue](#5-database_table_sync-quota-issue)
6. [CDF Verification](#6-cdf-verification)
7. [Truncating and Reloading _live Tables](#7-truncating-and-reloading-_live-tables)
8. [Null Byte Data Cleaning](#8-null-byte-data-cleaning)
9. [Checking DLT Pipeline Events](#9-checking-dlt-pipeline-events)
10. [Common Errors and Fixes](#10-common-errors-and-fixes)
11. [API Response Shapes (for smoke tests)](#11-api-response-shapes-for-smoke-tests)
12. [Open Verification Tasks](#12-open-verification-tasks)

---

> **Important — Lakebase is NOT active in this app.** The `lakebase` plugin is **not** registered in `server/server.ts` — `createApp` loads only `analytics({})` and `server()` (verified). Therefore `appkit.lakebase` does not exist at runtime. The sample Lakebase route module (`server/routes/lakebase/todo-routes.ts`, exporting `setupSampleLakebaseRoutes`) is **never imported or called** (`onPluginsReady` only calls `setupVirtueHealthRoutes`), and the Lakebase client page (`client/src/pages/lakebase/LakebasePage.tsx`) is **not** added to the router in `App.tsx` — there is no `/lakebase` route. These are **orphaned scaffold files**: `/api/lakebase/todos` is not served, and no production route reads from Lakebase. Every API endpoint reads from the **SQL Warehouse** via `appkit.analytics.query()`. Sections 3–9 below (psql, synced tables, CDF) document an OLTP replication path being **stood up for future use**, not a live read path for the app. To make any Lakebase route functional you must (a) add the `lakebase` plugin to `createApp`, (b) call `setupSampleLakebaseRoutes(appkit)` in `onPluginsReady`, and (c) add the route/nav entry in the client router.

---

## 1. Deployment

### Prerequisites

- Databricks CLI installed and authenticated under the `deepak-workspace` profile, with **DABs (Databricks Asset Bundles)** support.
- Node.js and npm available for the frontend/server build.
- **Working directory: `<repo>/virtue-health/`** (see §0.1) — this is where `databricks.yml` lives.

### 1.1 Build and deploy the DABs bundle

```bash
# Validate the bundle before deploying
databricks bundle validate -t default --profile deepak-workspace

# Deploy bundle resources (app definition, SQL warehouse binding, etc.)
databricks bundle deploy -t default --profile deepak-workspace
```

> The deploy syncs the **pre-built** artifacts declared in `databricks.yml` `sync.include` — which is **both** `dist/` **and** `client/dist/` (see §1.5). Build the app first (`npm run build`) or a stale/missing build directory will ship old assets — see §10.11.

### 1.2 Deploy the app

```bash
# Deploy the virtue-health app to Databricks Apps
databricks apps deploy virtue-health --profile deepak-workspace
```

This pushes the compiled frontend and the Express backend to the Databricks Apps runtime. The app service principal client ID is `5ccf106a-7211-489d-a075-5ca82e07b0ae`.

### 1.3 Full redeploy sequence (safe order)

```bash
npm run build && \
databricks bundle validate -t default --profile deepak-workspace && \
databricks bundle deploy -t default --profile deepak-workspace && \
databricks apps deploy virtue-health --profile deepak-workspace
```

### 1.4 Local development vs. production start

The npm scripts (verified in `package.json`) behave as follows — they are **not** interchangeable:

| Script | What it actually does |
|---|---|
| `npm run dev` | **Local dev command.** `tsx watch` against `server/server.ts` (`NODE_ENV=development`). This is also what Playwright's `webServer` launches. `predev` first runs `npm run sync && npm run typegen`. |
| `npm run build` | `build:server` (`tsc -b` + `tsdown`) then `build:client` (`tsc -b` + `vite build`). `prebuild` first runs `npm run sync && npm run typegen` (AppKit plugin sync + type generation). |
| `npm run start` | **Production command.** `NODE_ENV=production node ./dist/server.js` — runs the **already-built** server and does **no build**. It will **error if `dist/` does not exist**. |
| `npm install` | Triggers `postinstall: npm run typegen`. |

**For local development use `npm run dev`, not `npm run start`.** Only use `npm run start` after a successful `npm run build`.

**Port resolution:** Playwright's `baseURL` resolves to `http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`. Set `DATABRICKS_APP_PORT` (not `PORT`) for local dev to keep the server bind port and the test base URL aligned. `FLASK_RUN_HOST` in `.env.example` is unused by this Node app.

### 1.5 Bundle and runtime configuration (as actually defined)

The deployment is driven by `databricks.yml` and `app.yaml` in the bundle root (`<repo>/virtue-health/`). The real structure is:

**`databricks.yml`** — the app resource key is `app` (the `name:` field is `"virtue-health"`; see §0.2). The SQL Warehouse is supplied through a DABs variable, not a literal in the app block, and bound to the app as a resource. **`sync.include` lists TWO directories — both `dist/` and `client/dist/`** (verified in the actual file); a doc or memory showing only `dist/` is stale:

```yaml
bundle:
  name: virtue-health

sync:
  include:
    - dist/                       # compiled server bundle
    - client/dist/                # compiled client assets (BOTH are synced)

variables:
  warehouse_id:
    description: SQL Warehouse ID for analytics queries.

resources:
  apps:
    app:                          # <-- resource key is "app", NOT "virtue-health"
      name: "virtue-health"
      source_code_path: ./        # <-- resolves against <repo>/virtue-health/
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
      warehouse_id: 5b2b29cce22aa2c4   # default value for the default target
```

> **Both `dist/` and `client/dist/` must exist at deploy time.** `npm run build` produces both (`build:server` → `dist/`, `build:client` → `client/dist/`). If either is stale or missing, the deploy ships stale/incomplete assets or the app fails to start — see §10.11.

**`app.yaml`** — the start command is `npm run start`. The warehouse env var is sourced from the bound `sql-warehouse` resource via `valueFrom`, not a hardcoded ID literal:

```yaml
command: ['npm', 'run', 'start']
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse        # <-- resource reference, NOT value: 5b2b29cce22aa2c4
```

**Warehouse-ID resolution chain** (where the warehouse ID actually comes from at runtime — follow this when debugging "DATABRICKS_WAREHOUSE_ID not set"):

```
databricks.yml: targets.default.variables.warehouse_id = 5b2b29cce22aa2c4
       │  (substituted into)
       ▼
databricks.yml: resources.apps.app.resources[name=sql-warehouse]
                .sql_warehouse.id = ${var.warehouse_id}
       │  (bound resource named "sql-warehouse")
       ▼
app.yaml: env DATABRICKS_WAREHOUSE_ID  valueFrom: sql-warehouse
       │
       ▼
server runtime: process.env.DATABRICKS_WAREHOUSE_ID === "5b2b29cce22aa2c4"
```

To change the warehouse, update `targets.default.variables.warehouse_id` in `databricks.yml` (or pass `--var warehouse_id=...` at deploy time). Do not edit `app.yaml` to a literal ID.

**Lakebase connectivity** is configured through Postgres-standard environment variables, but the plugin that would consume them is **not loaded** (see the boxed note at the top of this runbook), so these values are **unused at runtime today**.

> **`.env.example` ships placeholders, not real values.** The actual file (verified) is:
> ```
> DATABRICKS_HOST=https://...
> PGDATABASE=your_postgres_databaseName
> LAKEBASE_ENDPOINT=your_postgres_endpointPath
> PGHOST=your_postgres_host
> PGPORT=5432
> PGSSLMODE=require
> DATABRICKS_APP_PORT=8000
> DATABRICKS_APP_NAME=virtue-health
> FLASK_RUN_HOST=0.0.0.0
> ```
> Copying `.env.example` to `.env` yields generic placeholders, **not** the concrete `databricks_postgres` / `ep-solitary-poetry-...` values quoted in the Quick Reference. To populate the Lakebase values for local inspection, obtain the host/endpoint via the CLI (see §3.0 for how to find the branch name), and set `DATABRICKS_HOST` to the workspace URL. Again: because the Lakebase plugin is not loaded, these `PG*`/`LAKEBASE_ENDPOINT` values do not affect the running app.

---

## 2. Checking App Status

### 2.1 List apps

```bash
databricks apps list --profile deepak-workspace
```

### 2.2 Get virtue-health app details

```bash
databricks apps get virtue-health --profile deepak-workspace
```

Look for `state.status` in the output. Expected healthy value is `RUNNING`.

### 2.3 Get app URL

```bash
databricks apps get virtue-health --profile deepak-workspace --output json | jq -r '.url'
```

### 2.4 View app logs

```bash
# List recent deployments to get a deployment ID
databricks apps list-deployments virtue-health --profile deepak-workspace

# Inspect a specific deployment (includes log URIs)
databricks apps get-deployment virtue-health <deployment-id> --profile deepak-workspace
```

> The availability of a dedicated `databricks apps logs virtue-health --follow` streaming command depends on the installed CLI version. **To discover whether the `logs` subcommand exists at all, run `databricks apps --help`** (the same help command is used in the companion deployment doc — standardize on `databricks apps --help`). If `logs` is not present in your build, inspect deployment details for log URIs via the commands above.

### 2.5 Smoke-test the API

Replace `<APP_URL>` with the URL from §2.3. **Note the response shapes** — every endpoint returns a JSON object (with a `syncing` flag), not a bare array. See §11 for the full shapes.

```bash
# KPI summary — object with totalFacilities/statesCovered/districtsCovered/avgSexRatio/syncing
curl -s "<APP_URL>/api/summary" | jq .

# Facilities page 1 — total is a top-level field; the rows are under .facilities
curl -s "<APP_URL>/api/facilities?page=1" | jq '{total, count: (.facilities | length)}'

# States list — under .states (NOT a bare array)
curl -s "<APP_URL>/api/facilities/states" | jq '.states'

# Districts — rows under .districts
curl -s "<APP_URL>/api/districts" | jq '.districts | length'

# Desert heatmap — points under .points
curl -s "<APP_URL>/api/desert/heatmap-points" | jq '.points | length'

# State gap scores — gaps under .gaps
curl -s "<APP_URL>/api/desert/state-gaps" | jq '.gaps'

# Capability summary — under .summary (at most 20 rows)
curl -s "<APP_URL>/api/desert/capability-summary" | jq '.summary | length'
```

> **`syncing` is load-bearing in the client.** Every response carries `syncing: boolean`, currently hardcoded `false` server-side. It is **not** purely informational: the client gates behavior on it. The facilities page suppresses the state-filter dropdown when `syncing` is truthy, and the desert page replaces the heatmap with a blocking "Data syncing…" banner when `state-gaps` or `heatmap-points` report `syncing: true`. If any future change flips `syncing` to `true`, the states dropdown silently disappears and the desert map is hidden. Smoke tests asserting on those UI elements must account for this. (The client TS interfaces in `client/src/pages/desert/types.ts` mark `syncing?: boolean` as **optional**, even though the server always emits it.)

---

## 3. Connecting to Lakebase Postgres

> **Context:** This section is for **direct inspection** of the Lakebase replication target being stood up for future use. The app does **not** read from Lakebase (see top-of-runbook note and §11), so psql here is **not** a diagnostic path for the live API.

### 3.0 Find the Lakebase endpoint and branch

The Lakebase endpoint can change (the project was deleted and recreated during troubleshooting). To find the current endpoint, first list the project's branches, then list the chosen branch's endpoints:

```bash
# 1. List branches for the project
databricks postgres list-branches --project virtue-health --profile deepak-workspace

# 2. List endpoints for a chosen branch (substitute the branch from step 1)
databricks postgres list-endpoints <branch-name> --profile deepak-workspace
```

> The exact `postgres` subcommands are CLI-version-specific. Confirm against `databricks postgres --help` for your CLI version (tracked as OV-4 in §12). A "branch" is a Lakebase Postgres branch under the project; if your CLI does not expose `list-branches`, check `databricks postgres --help` for the equivalent listing command. The endpoint as of 2026-06-15 is `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`.

### 3.1 Generate a short-lived database credential

```bash
databricks lakebase generate-database-credential \
  --profile deepak-workspace \
  --project virtue-health
```

The command returns a temporary username and password. These credentials expire; regenerate them if the psql session drops.

### 3.2 Connect with psql

```bash
psql "host=ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com \
      port=5432 \
      dbname=databricks_postgres \
      user=<generated-user> \
      password=<generated-password> \
      sslmode=require"
```

Once connected, set the search path:

```sql
SET search_path TO virtue_foundation_dataset_silver;

-- Verify tables are present
\dt

-- Check row counts (only tables that are ONLINE in Lakebase will be present)
SELECT COUNT(*) FROM nfhs_5_district_health_indicators;
-- facilities and india_post_pincode_directory may not yet exist in Postgres
-- (facilities is blocked on a duplicate-PK issue; india_post is pending quota)
```

### 3.3 Verify synced table replication freshness

```sql
-- nfhs_5 should be ONLINE; facilities and india_post may still be pending
SELECT COUNT(*) FROM nfhs_5_district_health_indicators;
```

---

## 4. Synced Table Lifecycle

All synced tables target the Lakebase project `virtue-health`, four-level address `` `virtue-pg` ``.`databricks_postgres`.`virtue_foundation_dataset_silver`.`<table>` (see §0.4 for the backtick/hyphen rule).

Source Delta tables live in: `dais27hack.virtue_foundation_dataset_silver`

> **Synced-table DDL is Lakebase-version-specific and has NOT been verified against this workspace.** Before running any `CREATE ... TABLE` here, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version). The forms below are **templates**, not known-good commands. The DDL keyword is standardized on `CREATE ONLINE TABLE` everywhere in this doc set until one is verified — the keyword-verification task is tracked canonically as **OV-3 in §12**; any companion doc's "TEMPLATE — verify syntax" callout should cross-link to §12 OV-3 rather than re-coining the question. Do not introduce `CREATE SYNCED TABLE` in one place and `CREATE ONLINE TABLE` in another.

### 4.1 Create a synced table (TEMPLATE — verify syntax before use; see §12 OV-3)

All examples use the **backticked, four-level path** (`` `virtue-pg` ``.`databricks_postgres`.`schema`.`table`) consistently.

```sql
-- NFHS-5 district health indicators (already ONLINE as of 2026-06-15)
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators
  PRIMARY KEY (district_name, state_ut)
  FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  WITH SCHEDULING POLICY = TRIGGERED;

-- India Post pincode directory (BLOCKED-quota as of 2026-06-15)
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.india_post_pincode_directory
  PRIMARY KEY (officename, pincode, statename)
  FROM dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live
  WITH SCHEDULING POLICY = TRIGGERED;

-- Facilities (BLOCKED-dup-pk: duplicate unique_id issue as of 2026-06-15)
-- Do NOT attempt until upstream duplicate key issue is resolved.
-- When resolved:
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.facilities
  PRIMARY KEY (unique_id)
  FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

> **Synced-table status vocabulary (canonical).** This runbook uses a single status vocabulary for synced tables — `ONLINE`, `BLOCKED-quota`, `BLOCKED-dup-pk` — matching the pipeline doc's authoritative set. Avoid re-coining "PENDING" vs "BLOCKED" in prose; map any such wording onto these three. (The CLI's own `detailed_state` values — `ONLINE`, `PROVISIONING`, `OFFLINE`, `FAILED`, etc. — are a separate runtime enum, listed in §4.2.)

> **`PRIMARY KEY` on facilities is the physical column.** The facilities synced table's `PRIMARY KEY (unique_id)` refers to the **physical Delta column** documented upstream as `unique_id` (the one with the duplicate-value problem). This is unrelated to the **API response field** `facility_id` (§0.7) — the API projects `facility_id`; the synced-table PK targets the physical column. Do not "fix" one to match the other.

> **`TIMESERIES KEY`:** A previous version of this DDL included `TIMESERIES KEY (updated_at)` on the NFHS table. There is no confirmed `updated_at` (or any timestamp) column on `nfhs_5_district_health_indicators` — the data model lists none. Do not add a `TIMESERIES KEY` unless you have verified the column exists via `DESCRIBE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators`. For TRIGGERED snapshot syncs a timeseries key is not required.

### 4.2 Monitor synced table status

```bash
# List all online tables in the catalog
databricks online-tables list --catalog virtue-pg --schema virtue_foundation_dataset_silver \
  --profile deepak-workspace

# Get status of a specific synced table
databricks online-tables get \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace
```

> Note: CLI arguments (`--catalog virtue-pg`, and the table identifier) are not SQL, so the hyphen does not require backticks here — only SQL/DDL (§0.4) does.

Look for `status.detailed_state`. Values:

| State | Meaning |
|---|---|
| `ONLINE` | Healthy, in sync |
| `ONLINE_TRIGGERED_INITIAL_PIPELINE_RUNNING` | Initial sync in progress |
| `OFFLINE` | Not syncing; investigate pipeline |
| `PROVISIONING` | Being created |
| `FAILED` | Pipeline error; check pipeline events |

### 4.3 Manually trigger a sync (TRIGGERED mode)

```bash
databricks online-tables sync \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace
```

Repeat for other tables once they reach ONLINE state.

### 4.4 Delete a synced table

```bash
databricks online-tables delete \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace
```

Deletion frees the `DATABASE_TABLE_SYNC` pipeline slot. Wait for deletion to complete before creating a replacement.

### 4.5 Recreate a synced table after deletion

1. Confirm the slot is free (see §5).
2. Confirm the source `_live` Delta table is correctly seeded (see §7).
3. Confirm CDF is enabled (see §6).
4. Run the `CREATE ONLINE TABLE` template from §4.1 (verify syntax first — §12 OV-3).
5. Monitor status until `ONLINE`.

---

## 5. DATABASE_TABLE_SYNC Quota Issue

### 5.1 Background

The workspace `dbc-0a01f518-764a.cloud.databricks.com` is subject to a quota of **1 concurrent `DATABASE_TABLE_SYNC` pipeline**. Attempting to create a second synced table while one is already initialising will fail.

### 5.2 Detecting the quota error

When creating an online table, the error will surface as something similar to:

```
Error: DATABASE_TABLE_SYNC quota exceeded. Maximum concurrent pipelines: 1.
```

Or the table will be created but immediately enter `FAILED` state. Check the pipeline events (§9) for a quota message.

### 5.3 How to detect current usage

```bash
# List all online tables and check which ones are in a running/provisioning state
databricks online-tables list --catalog virtue-pg --schema virtue_foundation_dataset_silver \
  --profile deepak-workspace --output json \
  | jq '.[] | {name: .name, state: .status.detailed_state}'
```

If any table shows `ONLINE_TRIGGERED_INITIAL_PIPELINE_RUNNING` or `PROVISIONING`, the slot is occupied.

### 5.4 Workaround: sequential creation

**Do not create multiple synced tables in parallel.** Follow this sequence:

```
1. Create table A → wait for ONLINE → proceed
2. Create table B → wait for ONLINE → proceed
3. Create table C → wait for ONLINE
```

```bash
# Poll until a table is ONLINE (run in a loop manually or script it)
watch -n 30 "databricks online-tables get \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace --output json | jq '.status.detailed_state'"
```

### 5.5 Workaround: free the slot before creating a new table

If a table is stuck in `FAILED` or `OFFLINE` and blocking the quota:

```bash
# Delete the stuck table to free the slot
databricks online-tables delete \
  virtue-pg.virtue_foundation_dataset_silver.<stuck-table-name> \
  --profile deepak-workspace

# Wait ~60 seconds for the pipeline to fully deregister, then create the next table
```

---

## 6. CDF Verification

Change Data Feed (CDF) must be enabled on all `_live` Delta tables for Lakebase synced tables to receive incremental updates.

### 6.1 Check CDF status

Run in Databricks SQL editor or via `databricks sql` CLI:

```sql
DESCRIBE DETAIL dais27hack.virtue_foundation_dataset_silver.facilities_live;
-- Look for delta.enableChangeDataFeed = true in the properties column

-- Or more directly:
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.facilities_live;
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live;
SHOW TBLPROPERTIES dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
```

The property `delta.enableChangeDataFeed` should be `true` for all three.

### 6.2 Enable CDF if missing

```sql
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
  SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);

ALTER TABLE dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live
  SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);

ALTER TABLE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

### 6.3 Verify CDF log entries exist

```sql
-- Confirm change log is being written
SELECT * FROM table_changes('dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live', 1)
LIMIT 10;
```

If this returns rows, CDF is active. If it throws an error about no change log, re-enable CDF and reload (§7).

---

## 7. Truncating and Reloading _live Tables

Use this procedure when a `_live` table needs to be fully reseeded — for example after fixing source data, resolving schema issues, or recovering from a corrupt CDF log.

**Source (read-only):** `dais27hack.virtue_foundation_dataset_silver.<table>`
**Target (_live):** `dais27hack.virtue_foundation_dataset_silver.<table>_live`

### 7.1 Full reload procedure (canonical order)

**Canonical order (clean CDF log): disable CDF → TRUNCATE → INSERT → re-enable CDF.**

Both the TRUNCATE **and** the INSERT must occur while CDF is **disabled**. This is deliberate: a `TRUNCATE` executed while CDF is enabled is recorded as delete events, and a bulk INSERT while CDF is enabled is recorded as a flood of insert events — either defeats the goal of a clean change log. Disable first, do all data movement, then re-enable.

> This ordering is authoritative for this project. Under it, `table_changes(..., <seed_version>)` shows **zero** seed insert/delete events. The corresponding pipeline test is **P-TC-03** in `test-plan.md` (the zero-CDF-events assertion — "`table_changes` from the CDF re-enable version shows no seed-attributable events"). Do **not** cite P-TC-01 for the zero-event expectation: in the current test plan **P-TC-01 is the row-count check** (`SELECT COUNT(*)` of `facilities_live` = 10,088), not the CDF assertion. Any companion doc still pointing at "P-TC-01 ... zero CDF events" should be corrected to P-TC-03.

```sql
-- Step 1: Disable CDF so neither the truncate nor the reload generates change records
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
  UNSET TBLPROPERTIES ('delta.enableChangeDataFeed');

-- Step 2: Truncate the _live table (CDF already disabled — no delete events recorded)
TRUNCATE TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live;

-- Step 3: Insert clean data from the source table.
--         For facilities you MUST strip null bytes (do NOT use SELECT *) — see §8.3.
INSERT INTO dais27hack.virtue_foundation_dataset_silver.facilities_live
SELECT
  unique_id,
  REPLACE(name, CAST(CHAR(0) AS STRING), '')        AS name,
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
  REPLACE(description, CAST(CHAR(0) AS STRING), '') AS description,
  cluster_id,
  source_urls
FROM dais27hack.virtue_foundation_dataset_silver.facilities;

-- Step 4: Re-enable CDF on the now-seeded table
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.facilities_live
  SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

> **Note:** The `_live` seed `INSERT` lists the **physical** column `unique_id` (the source Delta schema). This is the storage-layer column name and is independent of the **API response field** `facility_id` (§0.7) — the API projects `facility_id` from this table at query time; the reload does not rename anything.

For the other two tables, which have no null-byte issue, a plain `SELECT *` insert is acceptable in Step 3:

- `india_post_pincode_directory_live` ← `india_post_pincode_directory`
- `nfhs_5_district_health_indicators_live` ← `nfhs_5_district_health_indicators`

```sql
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  UNSET TBLPROPERTIES ('delta.enableChangeDataFeed');
TRUNCATE TABLE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
INSERT INTO dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  SELECT * FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators;
ALTER TABLE dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

### 7.2 Verify row counts after reload

```sql
SELECT
  'facilities'                  AS tbl, COUNT(*) AS rows FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
UNION ALL
SELECT
  'india_post_pincode_directory' AS tbl, COUNT(*) AS rows FROM dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory_live
UNION ALL
SELECT
  'nfhs_5_district_health_indicators' AS tbl, COUNT(*) AS rows FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live;
```

Expected counts (from source tables):

| Table | Expected rows |
|---|---|
| facilities | 10,088 |
| india_post_pincode_directory | 165,627 |
| nfhs_5_district_health_indicators | 706 |

### 7.3 After reload: trigger synced table sync

```bash
databricks online-tables sync \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace
```

---

## 8. Null Byte Data Cleaning

### 8.1 Background

The `facilities` source table contains null byte characters (`0x00`, `CHAR(0)`) in the `name` and `description` columns. These cause failures when Postgres attempts to ingest the data via the synced table pipeline, as Postgres does not accept null bytes in text fields.

> **Status: PARTIALLY RESOLVED — not resolved on the live read path.** Null bytes are stripped only when loading into `facilities_live` (§8.3). The production API reads from the **plain** `facilities` table (verified: `server/routes/virtue-health-routes.ts` queries `${SRC}.facilities`, not `facilities_live`), which **still contains null bytes**. So `/api/facilities` responses can still carry null bytes in `name`/`description`. Do not treat this issue as fully closed; it is remediated in `_live` (the future replication source) but **open on the read path**.

### 8.2 Detection

```sql
-- Check for null bytes in name column
SELECT COUNT(*) AS name_with_nullbytes
FROM dais27hack.virtue_foundation_dataset_silver.facilities
WHERE name LIKE CONCAT('%', CHAR(0), '%');

-- Check description column
SELECT COUNT(*) AS desc_with_nullbytes
FROM dais27hack.virtue_foundation_dataset_silver.facilities
WHERE description LIKE CONCAT('%', CHAR(0), '%');
```

### 8.3 Cleaning procedure

Null bytes are stripped during the INSERT step when loading into the `facilities_live` table, using the explicit column list with `REPLACE(...)` shown in §7.1 Step 3. **Never use `SELECT *` for the facilities reload** — null-byte cleaning requires the column-aliased insert, and `SELECT *` would re-introduce the corrupt bytes into `facilities_live`.

> **Note:** If the column list in the source table changes, update the INSERT in §7.1 accordingly.

### 8.4 Verify cleaning

```sql
-- Should return 0 after clean load (facilities_live only — the plain
-- facilities table is NOT cleaned and the API reads from it; see §8.1)
SELECT COUNT(*) AS remaining_nullbytes
FROM dais27hack.virtue_foundation_dataset_silver.facilities_live
WHERE name LIKE CONCAT('%', CHAR(0), '%')
   OR description LIKE CONCAT('%', CHAR(0), '%');
```

---

## 9. Checking DLT Pipeline Events

Synced tables run as internal Delta Live Tables (DLT) pipelines. When a synced table is in `FAILED` or `OFFLINE` state, inspect pipeline events to diagnose the root cause.

### 9.1 Find the pipeline ID for a synced table

```bash
databricks online-tables get \
  virtue-pg.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators \
  --profile deepak-workspace --output json \
  | jq '.status.continuous_update_status.initial_pipeline_sync_progress // .status'
```

The pipeline ID will appear in the status block. Alternatively:

```bash
databricks pipelines list --profile deepak-workspace --output json \
  | jq '.[] | select(.name | test("virtue|DATABASE_TABLE_SYNC"; "i")) | {id: .pipeline_id, name: .name, state: .state}'
```

### 9.2 Get pipeline events

```bash
# Replace <pipeline-id> with the ID found above
databricks pipelines get-events <pipeline-id> --profile deepak-workspace
```

### 9.3 Get the latest pipeline update details

```bash
databricks pipelines get <pipeline-id> --profile deepak-workspace --output json \
  | jq '{state: .state, cause: .cause, cluster_id: .cluster_id}'
```

### 9.4 Common pipeline event messages and meanings

| Event message fragment | Likely cause |
|---|---|
| `quota exceeded` | DATABASE_TABLE_SYNC concurrent limit hit (BLOCKED-quota; see §5) |
| `PRIMARY KEY constraint violation` | Duplicate PKs in source table (BLOCKED-dup-pk — duplicate `unique_id` in facilities) |
| `invalid byte sequence` or `null value` | Null bytes in string columns (see §8) |
| `CDF not enabled` | Change Data Feed not set on `_live` table (see §6) |
| `table not found` | Source `_live` table dropped or schema mismatch |

---

## 10. Common Errors and Fixes

### 10.1 App returns 500 on `/api/summary`

**Symptom:** `curl /api/summary` returns HTTP 500.

**Likely causes and fixes:**

1. SQL Warehouse `5b2b29cce22aa2c4` is stopped. (All API endpoints read from the SQL Warehouse via `appkit.analytics.query()` — see §11 — so a stopped warehouse breaks every endpoint, not just summary.)
   - Fix: Start the warehouse in the Databricks UI under SQL Warehouses, or via:
     ```bash
     databricks sql warehouses start 5b2b29cce22aa2c4 --profile deepak-workspace
     ```

2. App service principal (`5ccf106a-7211-489d-a075-5ca82e07b0ae`) lacks permissions on `dais27hack.virtue_foundation_dataset_silver`.
   - Fix: Grant SELECT on the schema to the service principal in Unity Catalog.

3. Warehouse ID is misconfigured. The app gets the warehouse via the bound `sql-warehouse` resource (`valueFrom: sql-warehouse` in `app.yaml`), which resolves from `${var.warehouse_id}` in `databricks.yml` (full chain in §1.5).
   - Fix: Verify `targets.default.variables.warehouse_id` is `5b2b29cce22aa2c4` and redeploy the bundle. Do not hardcode the ID into `app.yaml`.

### 10.2 `databricks bundle deploy` fails with validation error

**Symptom:** Bundle validation returns schema or resource reference errors.

**Fix:**
```bash
# Validate first to see exact errors
databricks bundle validate -t default --profile deepak-workspace

# Ensure you are in the bundle root (<repo>/virtue-health/) where databricks.yml is present
ls databricks.yml
```

Common cause: referencing the app by the wrong key. The resource key is `app` (with `name: "virtue-health"`); `${resources.apps.app...}` references must use `app`, not `virtue-health` (see §0.2).

### 10.3 Lakebase psql connection refused

> Reminder: this is for direct Lakebase inspection only; the app does not read from Lakebase, so this is not a path for diagnosing live API errors.

**Symptom:** `psql` connection to `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` times out or is refused.

**Likely causes and fixes:**

1. Credential has expired.
   - Fix: Regenerate with `databricks lakebase generate-database-credential --project virtue-health --profile deepak-workspace`.

2. Lakebase project was deleted and recreated (this happened during troubleshooting; the endpoint URL may change).
   - Fix: Re-discover the current endpoint via §3.0 (`list-branches` then `list-endpoints`), or:
     ```bash
     databricks lakebase get-project virtue-health --profile deepak-workspace --output json | jq '.endpoint'
     ```
   - Update the `PGHOST` / `LAKEBASE_ENDPOINT` env values if the endpoint changed.

3. `sslmode=require` missing.
   - Fix: Always include `sslmode=require` in the connection string (matches `PGSSLMODE=require` in `.env.example`).

### 10.4 Synced table stuck in PROVISIONING

**Symptom:** `databricks online-tables get` returns `detailed_state: PROVISIONING` for more than 15 minutes.

**Fix:**
1. Check quota (§5.3). Another table may be holding the slot.
2. Delete the stuck table and recreate it after the slot is free.
3. If the slot appears free but the table still won't provision, file a support ticket referencing workspace `dbc-0a01f518-764a.cloud.databricks.com` and the `DATABASE_TABLE_SYNC` quota.

### 10.5 facilities synced table creation fails with PRIMARY KEY violation

**Symptom:** Pipeline events show a constraint violation on `unique_id`.

**Root cause:** The source `facilities` table contains duplicate `unique_id` values (BLOCKED-dup-pk, as of 2026-06-15, awaiting upstream fix). Note this is the **physical** PK column; it is distinct from the API response field `facility_id` (§0.7).

**Fix:**
- Do not create the `facilities` online table until the upstream duplicate is resolved.
- As a workaround (if acceptable), create the online table using a surrogate PK derived in the `_live` table. This requires schema changes and is not yet designed — escalate to the data team.

### 10.6 Desert heatmap returns empty results

**Symptom:** `GET /api/desert/heatmap-points` returns `{ "points": [] }`.

**Likely causes:**

1. `latitude`/`longitude` columns in `facilities` are NULL for most records.
   - Investigate: `SELECT COUNT(*) FROM dais27hack.virtue_foundation_dataset_silver.facilities WHERE latitude IS NOT NULL AND longitude IS NOT NULL`

2. **Bounding-box filter excluded the points.** The heatmap query keeps only coordinates inside India's bounding box: `CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5` and `CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5` (in the `/api/desert/heatmap-points` handler — search for `BETWEEN 6.0 AND 37.5`). Facilities with valid-but-out-of-box coordinates (data errors, or genuinely outside the box) are silently dropped.
   - Investigate: count how many in-box rows exist using the same bounds.

3. The 5-minute in-memory cache served a stale empty result after a server restart. Cache keys are prefixed: `heatmap-points:<capability>`.
   - Fix: Restart the app or wait 5 minutes for cache expiry. (The cache is an in-memory `Map`; it does not persist across restarts.)

4. SQL Warehouse is stopped (see §10.1).

5. **Client shows a "Data syncing…" banner instead of the map.** The desert page blocks rendering and shows an amber banner whenever `heatmap-points` or `state-gaps` return `syncing: true`. Server-side `syncing` is hardcoded `false` today, so this should not occur — but if a future change emits `true`, the map is hidden by design (see §2.5).

### 10.7 `india_post_pincode_directory` geographic queries return type errors

**Symptom:** Queries casting `latitude`/`longitude` fail.

**Root cause:** `india_post_pincode_directory` has `latitude` and `longitude` as `STRING` type, not `DOUBLE`. (`facilities.latitude/longitude` are documented as `DOUBLE` but the heatmap query still applies an explicit `CAST(... AS DOUBLE)` — type unverified, see §12 OV-1. When writing geo queries, do not assume a numeric type; cast defensively.)

**Fix:** Always cast in queries:
```sql
SELECT
  CAST(latitude AS DOUBLE)  AS latitude,
  CAST(longitude AS DOUBLE) AS longitude
FROM dais27hack.virtue_foundation_dataset_silver.india_post_pincode_directory
WHERE latitude IS NOT NULL AND latitude != '';
```

### 10.8 SQL injection risk in API

**Symptom:** Not an error — a known security posture to understand.

**Actual behavior (verified in `server/routes/virtue-health-routes.ts`):** The `/api/facilities`, `/api/districts`, and desert endpoints interpolate user-supplied `search`, `state`, and `capability` values into SQL **after single-quote escaping** — every value passes through `.replace(/'/g, "''")` before being embedded (e.g. in the state-filter clause — search for `address_stateorregion = '`). This is a real mitigation against basic quote-breakout injection. It is **not** the "no sanitization / values embedded directly" situation described in some earlier docs.

**Caveat:** Quote-doubling is not equivalent to parameterized/bound queries. It defends the common case but is easy to forget on a newly added route, and does not cover every edge case. There is no separate validation of `page` beyond `parseInt` + `Math.max(1, ...)`, which is safe because it is coerced to an integer.

**Recommended permanent fix:** Migrate these route handlers to bound parameters. Note that the only file demonstrating bound-parameter usage (`server/routes/lakebase/todo-routes.ts`, `query(text, params[])`) is **orphaned dead code** — it is never imported and the `lakebase` plugin is not loaded (see top-of-runbook note), so it is a reference pattern only, not a working in-app example. Until a parameterized path exists, keep the app behind Databricks Apps authentication.

### 10.9 State gap scores look wrong or a state is missing/duplicated

**Symptom:** A state appears with a null `gap_score`, an unexpectedly high score, or is missing entirely from `/api/desert/state-gaps`.

**Root cause:** `state-gaps` joins facilities (`address_stateorregion`) to NFHS (`state_ut`) via a `FULL OUTER JOIN` on a normalized key `LOWER(TRIM(state))`. State-name mismatches between the two sources (e.g. "NCT of Delhi" vs "Delhi", abbreviations, spelling variants) do not match and produce one-sided rows. Additionally, the numerator uses `COALESCE(demand_index, 50)`, so a facility-only state with no NFHS demand data is assigned a **default demand of 50** rather than being excluded — which can inflate or distort its gap score. This state-name join is the single biggest correctness risk in Track 2.

**Fix / investigate:**

Step 1 — enumerate the actual mismatches in *this* dataset:
```sql
-- Find facility states that do not match any NFHS state key
SELECT DISTINCT LOWER(TRIM(address_stateorregion)) AS fac_key
FROM dais27hack.virtue_foundation_dataset_silver.facilities
WHERE address_stateorregion IS NOT NULL AND address_stateorregion <> ''
EXCEPT
SELECT DISTINCT LOWER(TRIM(state_ut))
FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators;
```

Step 2 — normalize both sides with a crosswalk before joining. The values below are **illustrative**; populate them from the actual EXCEPT output above before relying on them:
```sql
-- minimal crosswalk; extend after running the EXCEPT diagnostic above
CASE LOWER(TRIM(state))
  WHEN 'nct of delhi' THEN 'delhi'
  WHEN 'orissa'       THEN 'odisha'
  WHEN 'pondicherry'  THEN 'puducherry'
  ELSE LOWER(TRIM(state))
END AS state_key
```
Reconcile mismatched names at the data layer if accurate per-state gaps are required.

### 10.10 Negative or out-of-range `trust_weight` (data-quality flag)

**Symptom:** A facility shows a `trust_weight` outside the expected `[0, 1]` range — in particular a negative value.

**Root cause to verify:** Trust weight is `LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0, 1.0)`. When `source_types` is NULL or whitespace-only, `NULLIF(TRIM(...), '')` yields NULL, and **Spark's `SIZE(SPLIT(NULL, ','))` returns `-1`, not NULL**. Because `-1` is non-null, the `COALESCE(..., 1)` fallback never fires, giving `LEAST(-1/3.0, 1.0) = -0.333`. So NULL/empty `source_types` can produce a negative trust weight, contradicting the assumption that it defaults to ~0.333. See §12 OV-2 for the open verification of how many rows are affected.

**Verify on the warehouse:**
```sql
SELECT
  SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')) AS split_size,
  LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0, 1.0) AS trust_weight,
  COUNT(*) AS n
FROM dais27hack.virtue_foundation_dataset_silver.facilities
GROUP BY 1, 2
ORDER BY trust_weight;
```

**Recommended fix (NULL `source_types` → intended 0.333):** guard the `-1` case so it falls back to `1` before dividing:
```sql
LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
```
Do **not** instead clamp with `GREATEST(..., 0.0)` unless you intend NULL `source_types` to score **0**, not 0.333 — the two fixes have **different semantics** and the `GREATEST` form leaves a genuine empty-source facility at 0. Decide which you want and document it. Apply the chosen fix in all three queries that reuse this expression (heatmap, state-gaps, capability-summary). Until fixed, treat negative `trust_weight` as "no trust signal."

### 10.11 App deployment succeeds but shows old version

**Symptom:** The deployed URL still shows stale frontend after `databricks apps deploy`.

**Root cause:** `databricks.yml` declares `sync.include: [dist/, client/dist/]`, and `npm run start` (the production command in `app.yaml`) runs the **pre-built** `dist/server.js` without building. So the deploy ships whatever is in `dist/` and `client/dist/` — a stale or missing build directory deploys old assets (or, if `dist/` is absent, the app fails to start; if `client/dist/` is stale, the frontend is stale).

**Fix:**
```bash
# Rebuild BOTH dist/ and client/dist/, then hard-redeploy
npm run build && \
databricks bundle deploy -t default --profile deepak-workspace && \
databricks apps deploy virtue-health --profile deepak-workspace
```

Also clear browser cache or test with `curl` to rule out client-side caching.

### 10.12 `npm run start` errors locally with "Cannot find module ./dist/server.js"

**Symptom:** Running `npm run start` for local dev fails because `dist/` does not exist.

**Root cause:** `npm run start` is the **production** command and performs **no build** (§1.4). For local development, use `npm run dev` (tsx watch), which is also what Playwright's `webServer` launches. Only run `npm run start` after `npm run build`.

---

## 11. API Response Shapes (for smoke tests)

All endpoints query the **SQL Warehouse** (`appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver`). **No production endpoint reads from Lakebase Postgres**, and the `lakebase` plugin is not even loaded in `server/server.ts` (see top-of-runbook note). The facilities read path queries the **plain `facilities` table, not `facilities_live`** (verified `FROM ${SRC}.facilities`), so responses can still contain null bytes (§8.1). Every response is a JSON **object** and includes a `syncing` boolean (currently always `false` server-side; note the client TS types mark it optional, `syncing?: boolean`). Use these shapes when writing `curl`/`jq` smoke tests so assertions match reality.

| Endpoint | Response shape |
|---|---|
| `GET /api/summary` | `{ totalFacilities, statesCovered, districtsCovered, avgSexRatio, syncing }` — `totalFacilities` is `COUNT(*)` from the plain `facilities` table; `statesCovered`/`districtsCovered` are distinct `state_ut`/`district_name` from NFHS; `avgSexRatio` (from `sex_ratio_total_f_per_1000_m`) is **nullable** (`number \| null`). Because `district_name` repeats across states, `districtsCovered` is **< 706**. Note: `statesCovered` counts NFHS `state_ut`, a **different universe** from the facilities `address_stateorregion` values behind `/api/facilities/states` — the two state sets need not match (same root cause as the state-name mismatch in §10.9). |
| `GET /api/facilities?search=&state=&page=` | `{ facilities, total, page, pageSize, totalPages, syncing }`. Each facility has **only** `facility_id, name, organization_type, address_city, address_stateorregion, address_country` — `facility_id` is **numeric** (`number`), **not** `unique_id`/string (see §0.7). No lat/lon, capability, description, etc. |
| `GET /api/facilities/states` | `{ states: string[], syncing }` — not a bare array. Distinct `address_stateorregion` from **facilities** (a different set from the NFHS `state_ut` universe behind `statesCovered`). The client only populates the state dropdown when `syncing` is falsy. |
| `GET /api/districts?state=` | `{ districts, syncing }`. **No pagination** — applies no `LIMIT`/`OFFSET`, returns the entire filtered set (up to all 706 NFHS rows when unfiltered) in one payload. Each district row has **only** `district_name, state_ut, households_surveyed, hh_electricity_pct, hh_improved_water_pct, hh_use_improved_sanitation_pct, child_u5_whose_birth_was_civil_reg_pct` — **not** the full ~100 NFHS indicators. |
| `GET /api/districts/states` | `{ states: string[], syncing }`. |
| `GET /api/desert/heatmap-points?capability=` | `{ points, syncing }`. Each point: `facility_id, latitude, longitude, trust_weight, capability, address_stateorregion` — `facility_id` is **numeric** (see §0.7). Filtered to India's bounding box (lat 6.0–37.5, lon 68.0–97.5). Cache key `heatmap-points:<capability>`. |
| `GET /api/desert/state-gaps?capability=` | `{ gaps, syncing }`. Each gap: `state, facility_count, avg_trust_weight, source_type_variants, demand_index, district_count, supply_score, gap_score, confidence` (`confidence` = high/medium/low from `source_type_variants`). Cache key `state-gaps:<capability>`. |
| `GET /api/desert/capability-summary` | `{ summary, syncing }`. Each item: `capability, facility_count, avg_trust_weight, state_count`. Grouped on the **raw** `capability` string (no comma-splitting — composite strings are distinct buckets). `LIMIT 20`, so **at most** 20 rows. Cache key `capability-summary`. |

> **Example bodies are illustrative.** Any example JSON values used in companion docs are for shape demonstration only and are not guaranteed to match live data or each other.

> **`avgSexRatio` can be `null`.** Smoke tests and client code must handle the null case, not just the happy path:
> ```json
> { "totalFacilities": 10088, "statesCovered": 28, "districtsCovered": 640, "avgSexRatio": null, "syncing": false }
> ```

> **Pagination caveat (`/api/facilities`):** `page` is floored to ≥1 via `Math.max(1, parseInt(...))`, but is **not** clamped to `totalPages`. Requesting a page beyond the last (e.g. `page=5000`) issues a large `OFFSET`, returns `facilities: []` with HTTP 200, and still reports the true `total`/`totalPages`. Callers hitting the API directly must compare `page` to `totalPages` themselves; the API gives no over-range signal. (The client "Next" button is disabled by comparing to `data.totalPages`, so the UI does not overrun.)

> **Capability filter/summary mismatch:** the desert dropdown is populated with raw, un-split capability strings (composites like `'Emergency,Surgery,ICU'` are their own option), but `heatmap-points`/`state-gaps` filter via `capability ILIKE '%value%'`. Selecting a composite option filters on that exact comma-joined substring, which can return **fewer** facilities than the summary's `facility_count` for that bucket; conversely selecting `'Emergency'` also matches composites containing it. Grouping is exact-string; filtering is substring — they are not symmetric. Document or normalize (split on comma) on both sides if this matters for a demo.

**Reference formulas (as implemented).** These are summarized here for smoke-test convenience; the **canonical formula definitions live in `data-model.md`** (also referenced as canonical by `architecture.md §7` and `data-pipeline.md §6`). If a number here ever disagrees with `data-model.md`, `data-model.md` wins.

- **Trust weight** (heatmap / state-gaps / capability-summary):
  `LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0, 1.0)` — see the negative-weight caveat and recommended fix in §10.10.
- **Demand index** — i.e. `demand_index` (per NFHS state, in state-gaps):
  `ROUND(((100 - COALESCE(AVG(hh_electricity_pct),50)) + (100 - COALESCE(AVG(hh_improved_water_pct),50)) + (100 - COALESCE(AVG(hh_use_improved_sanitation_pct),50)) + (100 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct),50))) / 4.0, 1)`. This is a **deprivation-based demand proxy**: the average of four `(100 − coverage%)` terms, each missing average defaulting to 50. Higher = more deprivation = more unmet demand. The **field** is `demand_index`; the **concept** is "deprivation-based demand" — they are the same number.
- **Gap score:**
  `ROUND(COALESCE(demand_index, 50) / GREATEST(facility_count * avg_trust_weight / 10.0, 0.1), 2)` over a `FULL OUTER JOIN` of NFHS and facility states on `LOWER(TRIM(state))`. The denominator is floored at `0.1`; `demand_index` defaults to `50` when NFHS data is absent for a state. See §10.9 for the state-name-mismatch caveat.

> **`facilities.latitude/longitude` type note:** The heatmap query applies `CAST(latitude AS DOUBLE)` even though the data model documents these as `DOUBLE`. Type unverified — see §12 OV-1.

---

## 12. Open Verification Tasks

These are empirically answerable in under a minute against warehouse `5b2b29cce22aa2c4` (OV-3/OV-4 against the CLI). Until resolved, the sections above carry only a one-line "type/behavior unverified" pointer here rather than multi-paragraph hedging. **On resolution, record the result, then collapse the corresponding caveat in the referenced section to a stated fact.**

| ID | Question | Query/command to run | Result | Owner / opened |
|---|---|---|---|---|
| OV-1 | Is `facilities.latitude/longitude` actually `DOUBLE` or `STRING`? (decides whether the heatmap `CAST(... AS DOUBLE)` is defensive or required — see §10.7, §11) | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | `____` | TBD / 2026-06-15 |
| OV-2 | How many `facilities` rows have NULL/empty `source_types` and thus a `-0.333` trust weight? (sizes the §10.10 bug; confirms `SIZE(SPLIT(NULL,','))=-1`) | the GROUP BY query in §10.10 | `____` | TBD / 2026-06-15 |
| OV-3 | Confirm the verified synced-table DDL keyword (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`) for this CLI/runtime (see §4). **Canonical home of this verification task — other docs' "verify syntax" callouts should cross-link here.** | `databricks online-tables --help` | `____` | TBD / 2026-06-15 |
| OV-4 | Confirm the `databricks postgres` branch-listing subcommand for this CLI version (see §3.0) | `databricks postgres --help` | `____` | TBD / 2026-06-15 |

> **Resolved by reading source (not an open item): facility identifier.** Whether the **API response field** is `facility_id` or `unique_id` is **already settled** — it is `facility_id: number` (client interfaces `client/src/pages/desert/types.ts:14` and `client/src/pages/facilities/FacilitiesPage.tsx:20`; queries at `server/routes/virtue-health-routes.ts:72,167`). See §0.7. The only residual question is whether the **physical Delta column** is also literally named `facility_id` (run `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities`) — but this does not affect the response contract.

---

## Quick Reference

| Resource | Value |
|---|---|
| Deployed app name (CLI arg) | `virtue-health` |
| DABs app resource key | `app` |
| DABs bundle name | `virtue-health` |
| Working dir for all commands | `<repo>/virtue-health/` (where `databricks.yml`/`app.yaml`/`package.json` live) |
| App `source_code_path` | `./` (resolves against `<repo>/virtue-health/`) |
| `sync.include` (both required) | `dist/` **and** `client/dist/` (§1.5) |
| Warehouse wiring | `${var.warehouse_id}` → bound resource `sql-warehouse` → `app.yaml` `valueFrom: sql-warehouse` (chain in §1.5) |
| Facility API id field | `facility_id` (numeric) — **not** `unique_id`/string (§0.7) |
| Facilities API read path | plain `facilities` table (NOT `facilities_live`) — still contains null bytes (§8.1, §11) |
| Local dev command | `npm run dev` (tsx watch; also Playwright's `webServer`) |
| Production start command | `npm run start` (runs pre-built `./dist/server.js`, no build) |
| Build command | `npm run build` (`prebuild` runs `sync` + `typegen`; emits `dist/` + `client/dist/`) |
| Local dev port var | `DATABRICKS_APP_PORT` (Playwright `baseURL` = `DATABRICKS_APP_PORT \|\| PORT \|\| 8000`) |
| App-logs help command | `databricks apps --help` (to discover whether `logs` subcommand exists; §2.4) |
| CLI profile | `deepak-workspace` |
| Workspace | `dbc-0a01f518-764a.cloud.databricks.com` |
| SQL Warehouse ID | `5b2b29cce22aa2c4` |
| App SP client ID | `5ccf106a-7211-489d-a075-5ca82e07b0ae` |
| API read path | SQL Warehouse (`appkit.analytics.query()`) — Lakebase NOT used by app routes |
| Lakebase plugin status | **NOT loaded** in `server/server.ts`; todo-routes/LakebasePage are orphaned dead code |
| Lakebase project | `virtue-health` |
| Lakebase UC catalog | `` `virtue-pg` `` (hyphen — must be backtick-quoted in SQL; see §0.4) |
| Lakebase Postgres DB | `databricks_postgres` |
| Lakebase schema | `virtue_foundation_dataset_silver` |
| Lakebase full SQL path | `` `virtue-pg` ``.`databricks_postgres`.`virtue_foundation_dataset_silver`.`<table>` |
| Lakebase endpoint | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` (NOT in `.env.example`, which ships placeholders) |
| Lakebase env vars | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE`, `LAKEBASE_ENDPOINT` (placeholders in `.env.example`; unused at runtime since plugin not loaded) |
| Find Lakebase endpoint (local) | `databricks postgres list-branches --project virtue-health` then `list-endpoints <branch-name>` (see §3.0) |
| Source Delta catalog | `dais27hack` |
| Source Delta schema | `virtue_foundation_dataset_silver` |
| DATABASE_TABLE_SYNC quota | 1 concurrent pipeline |
| Synced ↔ online table | Same object; "synced table" in prose, `online-tables` in CLI (§0.3) |
| Synced-table status vocab | `ONLINE` / `BLOCKED-quota` / `BLOCKED-dup-pk` (§4.1) |
| Canonical _live reload order | disable CDF → TRUNCATE → INSERT → re-enable CDF (§7.1); zero-CDF-events test = **P-TC-03** |
| nfhs_5 synced table state | ONLINE (as of 2026-06-15) |
| facilities synced table state | BLOCKED-dup-pk — duplicate unique_id (as of 2026-06-15) |
| india_post synced table state | BLOCKED-quota (as of 2026-06-15) |

Rewritten runbook is above. File this back to `/Users/hz317604/Developer/dais27/virtue-health/docs/runbook.md` (the docs directory exists under the bundle root).

Relevant findings applied (those touching runbook.md):
- **Finding 1** (`unique_id`→`facility_id`): added §0.7, corrected §11 facility/heatmap shapes to `facility_id: number`, clarified physical-column vs response-field distinction in §4.1/§7.1/§10.5, added a resolution note in §12 and a Quick Reference row.
- **Finding 2** (`sync.include`): §1.5 YAML now lists both `dist/` and `client/dist/`; updated §1.1, §10.11, and Quick Reference.
- **Finding 5** (DDL-keyword OV): §4 preamble and §4.1 now cross-link the keyword-verification to canonical §12 OV-3.
- **Finding 6** (P-TC-01→P-TC-03): §7.1 note corrected to cite P-TC-03 for the zero-CDF-events assertion.
- **Finding 14** (`apps logs` help): §2.4 standardized on `databricks apps --help`; added Quick Reference row.

Also incorporated relevant secondary fixes that surface in runbook prose: null-byte status corrected to PARTIALLY RESOLVED / open-on-read-path (Findings 8/10) in §8.1/§8.4/§11; synced-table status vocabulary standardized to `ONLINE`/`BLOCKED-quota`/`BLOCKED-dup-pk` (Finding 4) in §4.1/§9.4/§12/Quick Reference; formula canonicality pointed to `data-model.md` (Finding 7) in §11; and the NFHS-vs-facilities "states" universe mismatch (Finding 11) noted in §11. Everything verified correct in the original (warehouse wiring, port resolution, SQL-injection posture, trust-weight/gap-score formulas, quota workarounds) was preserved unchanged.
