This is a single-document rewrite task. The instructions say to apply only findings relevant to `deployment.md`. Let me identify which findings touch this document.

Relevant findings for deployment.md:
- **Finding 1** (`unique_id` vs `facility_id`): deployment.md doesn't define API response shapes, so no change needed here.
- **Finding 2** (`sync.include`): deployment.md is already correct (shows both).
- **Finding 14** (`apps logs` help command): deployment.md says `databricks apps --help` — the recommended standard. Already correct, but I'll keep it consistent.

Let me check the document against each finding carefully. The document is largely already correct on the findings that mention it (Findings 2 and 14 cite deployment.md as the correct exemplar). The Open Verification Tasks section references the `facilities.latitude/longitude` type question, which is genuine to this doc.

The findings that are actionable for deployment.md are minimal because deployment.md is repeatedly cited as the *correct* document. The main improvement is to remove the leftover review-process preamble (the first paragraph "I have verified the key facts...") which is not part of the actual guide, and ensure cross-references are sound.

Here is the improved markdown.

# Virtue Health — Deployment Guide

## Conventions Used in This Guide

### Working directory

**The working directory for all `databricks bundle`, `databricks apps`, and `npm` commands in this guide is `<repo>/virtue-health/`.** This is the directory that contains `databricks.yml`, `app.yaml`, and `package.json`, and it is what `source_code_path: ./` resolves against. The git repository top level is `<repo>/` (e.g. `/Users/hz317604/Developer/dais27`), and `virtue-health/` is a **subdirectory** of it. When this guide (or others in the set) says "bundle root," it means `<repo>/virtue-health/`, **not** the git repository top level.

### The three meanings of "virtue-health"

The string `virtue-health` is overloaded. To disambiguate:

- **bundle** = `virtue-health` (the `bundle.name` in `databricks.yml`).
- **app resource key** = `app` (the key under `resources.apps` in `databricks.yml`, referenced as `${resources.apps.app...}`).
- **deployed app name** = `virtue-health` (the `name:` field of the `app` resource; the argument to `databricks apps <cmd> <name>`).

When a command takes the **deployed app name** we write `virtue-health`. When DABs config references the **resource**, we write `app`.

### Glossary

- **DABs** — Databricks Asset Bundles (the deployment bundle tooling; sometimes mis-expanded as "Declarative Automation Bundles" — that expansion is wrong).
- **SPA** — Single-Page Application (the React client).
- **PAT** — Personal Access Token.
- **SP** — Service Principal.
- **CDF** — Change Data Feed (relevant only to the data pipeline, not the running app).
- **OLTP** — Online Transaction Processing (Lakebase Postgres reads — not wired in; see below).
- **NFHS-5** — National Family Health Survey, Round 5.

---

## Prerequisites

### Required Tools

- **Databricks CLI** with DABs (Databricks Asset Bundles) support. Install via the unified CLI:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh
  ```
- **Node.js** (v18 or later) and **npm**
- **Git**
- Access to the Databricks workspace: `https://dbc-0a01f518-764a.cloud.databricks.com`

### Required Access

- Databricks workspace membership with permission to deploy Apps
- Permission to use SQL Warehouse `5b2b29cce22aa2c4`
- Read access to catalog `dais27hack.virtue_foundation_dataset_silver`
- A Databricks Personal Access Token (PAT) or service principal credentials

### Databricks CLI Profile

The project uses a named CLI profile called `deepak-workspace`. Configure it once:

```bash
databricks configure --profile deepak-workspace
```

When prompted:
- **Host**: `https://dbc-0a01f518-764a.cloud.databricks.com`
- **Token**: your Databricks Personal Access Token

Verify the profile is working:

```bash
databricks workspace list / --profile deepak-workspace
```

---

## Environment Setup

### .env File (Local Development)

Create a `.env` file in the bundle root, `<repo>/virtue-health/` (this file is gitignored — never commit it). The authoritative source of variable **names** is the shipped `virtue-health/.env.example`. Lakebase connectivity uses the **Postgres-standard `PG*` environment variables** (read by the AppKit lakebase plugin) plus `LAKEBASE_ENDPOINT`, not hand-rolled `LAKEBASE_*` credential vars.

> **Important — `.env.example` ships placeholders, not real values.** The actual file contains generic placeholders, so copying it to `.env` does **not** give you working values. The real contents are:
>
> ```env
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

To populate the placeholders for local dev:

- **`DATABRICKS_HOST`** → set to the workspace URL: `https://dbc-0a01f518-764a.cloud.databricks.com`.
- **`PGHOST`** → for this project, `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`. (`PGHOST`/`PGDATABASE`/`PGPORT`/`PGSSLMODE` are normally platform-injected at deploy time; for local dev you fill them in by hand.)
- **`PGDATABASE`** → for this project, `databricks_postgres`.
- **`LAKEBASE_ENDPOINT`** → obtain the endpoint resource name via the Lakebase plugin's documented CLI path (per `appkit.plugins.json`). You need a **branch name** first, then the endpoint:
  ```bash
  # 1. List branches for the Lakebase project to find the branch name:
  databricks postgres list-branches --project virtue-health --profile deepak-workspace
  # 2. Pass the chosen branch name to list its endpoints:
  databricks postgres list-endpoints <branch-name> --profile deepak-workspace
  ```
  Use the selected endpoint's `.name` value (form: `projects/{project-id}/branches/{branch-id}/endpoints/{endpoint-id}`).
  > A Lakebase "branch" is a Postgres branch within the `virtue-health` project; you must list branches to discover a valid `<branch-name>` before you can list endpoints. **Confirm both subcommands against `databricks postgres --help` for your installed CLI version** — the exact noun/flags vary by version. If the branch-listing subcommand is unavailable in your CLI, obtain the branch and endpoint names from the Databricks workspace UI under the `virtue-health` Lakebase project instead.

> **Notes:**
> - There are **no** `LAKEBASE_HOST` / `LAKEBASE_DATABASE` / `LAKEBASE_USER` / `LAKEBASE_PASSWORD` / `LAKEBASE_SCHEMA` variables — those names do not exist in this project. The AppKit lakebase plugin handles connection/credential injection from the `PG*` variables, `LAKEBASE_ENDPOINT`, and the bound Lakebase resource.
> - **These `PG*` / `LAKEBASE_ENDPOINT` values are unused at runtime today.** The `lakebase` plugin is **not** registered in `server/server.ts` (see "Lakebase Is Not Wired In" below), so nothing reads them. They are kept only so the scaffold remains complete if Lakebase is ever activated.
> - For local dev, authentication to the SQL Warehouse is handled through your configured CLI profile / `DATABRICKS_HOST`. A `DATABRICKS_TOKEN` may be set in the environment for PAT-based auth, but it is not listed in `.env.example`.
> - `FLASK_RUN_HOST` appears in `.env.example` despite this being a Node/Express app; it is carried over from the AppKit scaffold and is not used by the Express server.

### Environment Variables in Production (Databricks Apps)

When deployed as a Databricks App, the runtime environment automatically injects:

- `DATABRICKS_HOST` — the workspace URL
- A short-lived token scoped to the App Service Principal (`5ccf106a-7211-489d-a075-5ca82e07b0ae`)

The SQL Warehouse is **not** supplied as a literal ID in production. It is provided through a bound App resource named `sql-warehouse` (declared in `databricks.yml`), and the app's `DATABRICKS_WAREHOUSE_ID` env var is sourced from that resource via `valueFrom: sql-warehouse` in `app.yaml` (see below). There is no manual password `secretRef` wiring in `app.yaml` because no Lakebase route is active.

#### Where `DATABRICKS_WAREHOUSE_ID` actually comes from (resolution chain)

Use this when debugging a `DATABRICKS_WAREHOUSE_ID not set` error — the value is indirected through three files:

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

---

## DABs Bundle Structure

### `databricks.yml`

The DABs bundle descriptor lives at `virtue-health/databricks.yml`. The bundle name is `virtue-health`. The **actual** structure is:

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
    app:                       # <-- resource key is "app", NOT "virtue-health"
      name: "virtue-health"    # the deployed app name
      description: "Healthcare data explorer for DAIS 2026 — facilities, district health indicators, and pin codes"
      source_code_path: ./     # <-- bundle root (virtue-health/), NOT a nested ./virtue-health

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

Key facts that differ from a naive reading:
- The app **resource key** is `app`; only the `name:` field is `"virtue-health"` (see "The three meanings of virtue-health" above).
- `source_code_path` is `./`, which resolves to the **bundle root** (`<repo>/virtue-health/`), not a further-nested `./virtue-health`.
- The SQL Warehouse ID is supplied via the DABs **variable** `${var.warehouse_id}`, whose default value (`5b2b29cce22aa2c4`) is set under `targets.default.variables`.
- The app binds a `sql-warehouse` resource with `permission: CAN_USE`; the warehouse connection is delivered to the app through this binding.
- The top-level `sync.include` block syncs both `dist/` **and** `client/dist/` to the workspace, ensuring the built backend bundle and the built frontend assets are available. (Other docs in the set have historically shown only `dist/` here — that is incomplete; both entries are required, or the deployed app ships without its client assets.)

### `app.yaml`

The App manifest is at `virtue-health/app.yaml`. The **actual** contents are:

```yaml
command: ['npm', 'run', 'start']
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse
```

Notes:
- The warehouse ID is sourced from the bound `sql-warehouse` resource via `valueFrom: sql-warehouse` — it is **not** a literal `value: 5b2b29cce22aa2c4`. (See the resolution chain above.)
- There is no `LAKEBASE_PASSWORD` / secret `valueFrom: secretRef` wiring, and no `valueFrom: postgres` wiring, because the Lakebase plugin is not loaded (see below).
- `command: ['npm', 'run', 'start']` runs the **already-built** `dist/server.js`. The build must have happened before this is invoked (the bundle ships `dist/` and `client/dist/` via `sync.include`).

### App Source Directory

The frontend and backend source code lives under `virtue-health/` (which is also the bundle root, given `source_code_path: ./`). Key layout:

```
virtue-health/                # <-- bundle root; ALL commands run from here
  databricks.yml        # DABs bundle descriptor
  app.yaml              # App runtime manifest
  .env.example          # authoritative env var NAMES (placeholder values) for local dev
  package.json          # npm scripts (dev, build, start)
  appkit.plugins.json   # plugin manifest / env var origins (e.g. lakebase endpoint CLI)
  vitest.config.ts      # unit test config (passWithNoTests; no tests exist yet)
  playwright.config.ts  # E2E config (testDir ./tests; webServer = npm run dev)
  tests/
    smoke.spec.ts       # the only existing E2E test
  server/
    server.ts                   # createApp({ plugins: [analytics, server] }) — NO lakebase
    routes/
      virtue-health-routes.ts   # production API routes (SQL Warehouse)
      lakebase/todo-routes.ts   # ORPHANED scaffold — never imported/registered
  client/
    src/                        # React 19 + TypeScript frontend
      pages/lakebase/LakebasePage.tsx  # ORPHANED — not in the router
```

---

## Read Paths (Important)

All production API endpoints (`/api/summary`, `/api/facilities*`, `/api/districts*`, `/api/desert/*`) read from the **SQL Warehouse** via `appkit.analytics.query()` against `dais27hack.virtue_foundation_dataset_silver`. None of them read from Lakebase.

> **The API reads the plain `facilities` table, not `facilities_live`.** The facility-count and facility-listing endpoints query `dais27hack.virtue_foundation_dataset_silver.facilities` (the plain table), **not** the CDF-enabled `facilities_live`. This matters for deployment-time debugging: data-quality fixes applied only to `_live` (e.g. null-byte stripping — see the null-byte error below) are **not** reflected on the app's read path. See `data-pipeline.md §2`.

### Lakebase Is Not Wired In (orphaned scaffold)

There is **no active Lakebase code path** in this app. This is verified, not hedged:

- **The `lakebase` plugin is not registered.** `server/server.ts` calls `createApp({ plugins: [analytics({}), server()] })` — only `analytics` and `server`. Because the plugin is absent, **`appkit.lakebase` does not exist at runtime**.
- **The sample routes are never registered.** `server/routes/lakebase/todo-routes.ts` exports `setupSampleLakebaseRoutes`, but the `onPluginsReady` callback only calls `setupVirtueHealthRoutes(appkit)`. The function is never imported or invoked, so `/api/lakebase/todos` is **not served**.
- **The sample page is not routed.** `client/src/pages/lakebase/LakebasePage.tsx` exists but is never referenced in `App.tsx`'s router — there is no `/lakebase` route and no nav link.

These are orphaned scaffold files. Do **not** assume a working Lakebase path exists. A Lakebase OLTP read path for facilities/districts is **aspirational, not implemented**.

To make any Lakebase route functional you would have to:
1. Add the `lakebase` plugin to the `createApp({ plugins: [...] })` array in `server/server.ts`.
2. Call `setupSampleLakebaseRoutes(appkit)` (or your own route setup) inside the `onPluginsReady` callback.
3. Register the corresponding client route / nav entry in `App.tsx`.
4. Populate the `PG*` / `LAKEBASE_ENDPOINT` env vars (see Environment Setup) and bind the Lakebase resource in `app.yaml`/`databricks.yml`.

---

## Deploying to Databricks

> All commands below run from the bundle root, `<repo>/virtue-health/`.

### Step 1 — Build, then Bundle Deploy

Build the frontend and backend first so the bundle has up-to-date assets to sync, then compile the DABs bundle and synchronize all resources to the workspace:

```bash
npm run build
databricks bundle deploy -t default --profile deepak-workspace
```

`databricks bundle deploy` does the following:
- Resolves the `databricks.yml` configuration for the `default` target (including `var.warehouse_id`)
- Syncs the app source code and the `dist/` + `client/dist/` build output to the workspace
- Creates or updates the app resource (resource key `app`, deployed name `virtue-health`) and its `sql-warehouse` binding

### Step 2 — Apps Deploy

After the bundle is deployed, push the latest app code and trigger a redeploy:

```bash
databricks apps deploy virtue-health --profile deepak-workspace
```

This command:
- Packages the source under `virtue-health/`
- Deploys it to the `virtue-health` Databricks App (the **deployed app name**)
- Restarts the app process (which runs `npm run start` → `node ./dist/server.js`) with the new code

### Full Deploy (All Steps)

```bash
npm run build && \
databricks bundle deploy -t default --profile deepak-workspace && \
databricks apps deploy virtue-health --profile deepak-workspace
```

---

## Running Locally

> All commands below run from the bundle root, `<repo>/virtue-health/`.

### Install Dependencies

```bash
npm install
```

> `npm install` triggers `postinstall: npm run typegen` (`appkit generate-types`), so the first install also regenerates AppKit types.

### Start the Development Server

For local development, use **`npm run dev`** — not `npm run start`:

```bash
npm run dev
```

`npm run dev` runs `tsx watch` against `server/server.ts` (with hot reload). This is also exactly what Playwright's `webServer.command` launches for E2E tests. Its `predev` hook first runs `npm run sync` (`appkit plugin sync`) + `npm run typegen` (`appkit generate-types`).

> **Do not use `npm run start` for local dev.** The `start` script is the **production** command: `NODE_ENV=production node ./dist/server.js`. It runs the already-built `dist/server.js` and performs **no build**, so it will **fail outright if `dist/` does not exist** (i.e., if you have not run `npm run build`).

### Required Environment Variables for Local Dev

Copy `.env.example` to `.env` and replace its placeholders with real values (see **Environment Setup** above — the file ships placeholders like `your_postgres_host`, not concrete values). The AppKit server plugin uses `DATABRICKS_HOST` (and your CLI/PAT auth) plus the bound SQL Warehouse to run analytics queries. Without valid Databricks auth, all `/api/*` endpoints will return errors. The `PG*` / `LAKEBASE_ENDPOINT` values are not needed for the app to function today, since no Lakebase route is active.

### Port Resolution

- Express binds the port from `DATABRICKS_APP_PORT` (default `8000` per `.env.example`).
- Playwright resolves its `baseURL` as `http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}` — i.e., `PORT` is honored as a fallback.
- To keep the server bind port and the test base URL aligned, set **`DATABRICKS_APP_PORT`** (not `PORT`) for local dev. Setting `PORT` alone can cause a mismatch between where the server binds and where Playwright looks.

### Building the Frontend

```bash
npm run build
```

`npm run build` runs `build:server` (`tsc -b tsconfig.server.json && tsdown ...`) then `build:client` (`tsc -b tsconfig.client.json && vite build ...`), compiling the backend and the React + TypeScript frontend into `dist/` (server) and `client/dist/` (client). Its `prebuild` hook first runs `npm run sync` (`appkit plugin sync`) + `npm run typegen` (`appkit generate-types`).

> **Build note:** The build uses **`rolldown-vite@7.1.14`**, applied via the `overrides.vite` / `devDependencies.vite: "npm:rolldown-vite@7.1.14"` entries in `package.json` — not stock Vite. This is relevant when debugging build behavior.

The production flow is therefore: `npm run build` → then `npm run start` (or, on Databricks Apps, the platform runs `npm run start` against the synced `dist/`).

---

## SQL Warehouse Dependency

All analytics queries are executed against SQL Warehouse `5b2b29cce22aa2c4` via `appkit.analytics.query()`. This warehouse must be:

- **Running** (not terminated) before the app handles any API request
- **Accessible** to the identity making requests — in production, the App Service Principal (`5ccf106a-7211-489d-a075-5ca82e07b0ae`) via the bound `sql-warehouse` resource (`CAN_USE`); in local dev, the PAT/profile owner

If the warehouse is in a stopped state, the first query will cold-start it (typically 2–5 minutes for a serverless warehouse — this **warehouse-cold-start** time is excluded from all app-level timing targets, which assume a RUNNING warehouse). The `/api/desert/*` endpoints have a 5-minute in-memory cache to reduce warehouse hits.

Source tables are all in catalog `dais27hack.virtue_foundation_dataset_silver`. The querying identity must have `SELECT` grants on that schema.

---

## Lakebase Connection Details (Local Dev)

> **Reminder:** Lakebase is **not wired into the running app** (see "Lakebase Is Not Wired In" above). The plugin is not loaded, and the only Lakebase code (`todo-routes.ts`) is orphaned and never registered. The table below documents the intended connection parameters for if/when Lakebase is activated — it does not describe a live read path today.

> **Synced table vs online table:** Databricks calls these objects **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables ...`). They are the same object. This guide uses "synced table" in prose and the CLI's `online-tables` noun in commands.

> **Backtick rule for the catalog name:** The Lakebase UC catalog is `virtue-pg` (with a **hyphen**). Because the name contains a hyphen, it **must** be backtick-quoted in all SQL/DDL: `` `virtue-pg` ``. Unquoted `virtue-pg` is a SQL syntax error; `virtue_pg` (underscore) is simply the wrong catalog and does not exist.

Connection parameters (via the env vars consumed by the AppKit lakebase plugin):

| Parameter | Env Var | Value |
|---|---|---|
| Host | `PGHOST` | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` |
| Port | `PGPORT` | `5432` |
| Database | `PGDATABASE` | `databricks_postgres` |
| SSL Mode | `PGSSLMODE` | `require` |
| Endpoint path | `LAKEBASE_ENDPOINT` | obtain via `databricks postgres list-endpoints <branch-name>` (find `<branch-name>` via `list-branches` first — see Environment Setup) |
| UC Catalog | — | `virtue-pg` (backtick-quote in SQL: `` `virtue-pg` ``) |
| Schema | — | `virtue_foundation_dataset_silver` |
| Lakebase Project | — | `virtue-health` |

In `.env.example` these ship as placeholders (`your_postgres_host`, `your_postgres_databaseName`, `your_postgres_endpointPath`); fill in the real values above for local dev. Credentials are injected by the AppKit lakebase plugin and the bound Lakebase resource; there is no plaintext username/password in `.env.example`. If you need to authenticate manually, obtain credentials from the Databricks workspace under the `virtue-health` Lakebase project, or from the team's secure credential store.

> **Important:** The Lakebase project (`virtue-health`) was deleted and recreated during development. The current synced-table state is: `nfhs_5_district_health_indicators` is `ONLINE`; `india_post_pincode_directory_live` is `BLOCKED-quota`; `facilities_live` is `BLOCKED-dup-pk` (duplicate `unique_id`) and also subject to the quota limit. The workspace `DATABASE_TABLE_SYNC` quota allows only 1 concurrent pipeline. Do not attempt to create additional synced tables until the in-progress pipeline completes. The canonical synced-table status vocabulary (`ONLINE` / `BLOCKED-quota` / `BLOCKED-dup-pk`) is defined in `data-pipeline.md`; cross-reference it rather than re-coining "PENDING." Note that even with NFHS `ONLINE` in Lakebase, **`/api/districts` still reads from the SQL Warehouse** — the Lakebase read path is not wired into the application routes (nor is the Lakebase plugin even loaded).

### Synced-Table DDL (template — verify before use)

> **Synced-table DDL is Lakebase-version-specific and has NOT been verified against this workspace.** Before running any `CREATE ... TABLE` here, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version). The form below is a *template*, not a known-good command. Standardize on the `CREATE ONLINE TABLE` keyword (do not mix in `CREATE SYNCED TABLE`) until one is verified — see the canonical DDL-keyword verification task in `runbook.md §12 OV-3`. Note the **four-level** path: catalog → `databricks_postgres` database → schema → table, with the catalog backtick-quoted.

```sql
-- TEMPLATE — verify syntax before use
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table>
  PRIMARY KEY (...)
  FROM dais27hack.virtue_foundation_dataset_silver.<table>_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

Concrete example for the NFHS table (still a template — verify syntax first):

```sql
-- TEMPLATE — verify syntax before use
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators
  PRIMARY KEY (district_name, state_ut)
  FROM dais27hack.virtue_foundation_dataset_silver.nfhs_5_district_health_indicators_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

---

## Same-Origin Serving and SPA Fallback

The Express process (AppKit `server` plugin) serves **both** the API (`/api/*`) and the built SPA (from the synced client assets) from a **single origin**. Consequences for deployment and debugging:

- The React client uses **relative** fetch paths (e.g. `fetch('/api/facilities/states')`). This works only because the API and the SPA share the same Express process/origin. There is no separate API base URL to configure.
- Client-side routes (`/facilities`, `/districts`, `/desert`) rely on the `server` plugin's **SPA fallback** — serving `index.html` for non-`/api` paths — so deep links and hard refreshes resolve to the SPA rather than 404ing.
- **If a hard refresh on a deep link (e.g. `/desert`) returns 404**, the static/SPA-fallback configuration in the `server` plugin is the place to check.

> The SPA fallback depends on the client assets being present in the workspace, which is why `sync.include` must list **`client/dist/`** in addition to `dist/` (see `databricks.yml` above). A bundle that syncs only `dist/` will deploy a server with no SPA to serve.

---

## Checking Deployment Status

> All commands run from the bundle root, `<repo>/virtue-health/`.

### App Status

```bash
databricks apps get virtue-health --profile deepak-workspace
```

### List All Apps

```bash
databricks apps list --profile deepak-workspace
```

### Validate Bundle Configuration

```bash
databricks bundle validate -t default --profile deepak-workspace
```

---

## Viewing App Logs

The exact log-streaming subcommand depends on your installed Databricks CLI version. **First confirm the `logs` subcommand exists** by running `databricks apps --help`. If `databricks apps logs` is available in your CLI, stream logs with:

```bash
databricks apps logs virtue-health --profile deepak-workspace
```

And follow (tail) them with:

```bash
databricks apps logs virtue-health --follow --profile deepak-workspace
```

> **Verify first:** Run `databricks apps --help` to confirm the `logs` subcommand exists in your CLI version (this is the standard help-discovery command used across all docs in this set). If it is not available, view logs from the App's page in the Databricks workspace UI. Logs include stdout/stderr from the Express.js server process — API errors and SQL Warehouse connection failures appear here. (Lakebase connection errors will **not** appear, because no Lakebase code runs.)

---

## Common Deployment Errors and Fixes

### Error: `npm run start` fails — cannot find `./dist/server.js`

**Symptom:** Running `npm run start` locally exits immediately with a module-not-found / missing-file error for `dist/server.js`.

**Fix:** `npm run start` runs the pre-built production bundle and does **no build**. Either run `npm run build` first, or — for local development — use `npm run dev` instead (tsx watch, no build required). On Databricks Apps, ensure `dist/` was built and synced (`npm run build` before `databricks bundle deploy`).

---

### Error: `DATABRICKS_WAREHOUSE_ID not set`

**Symptom:** All `/api/*` endpoints return 500 errors immediately after startup.

**Fix:** Trace the resolution chain (see "Where `DATABRICKS_WAREHOUSE_ID` actually comes from" above). In production, ensure the app's `sql-warehouse` resource is bound and `app.yaml` sources the env var via `valueFrom: sql-warehouse`. Confirm `var.warehouse_id` resolves (default `5b2b29cce22aa2c4` under `targets.default.variables`). For local dev, ensure your CLI auth / `DATABRICKS_HOST` is set and the warehouse is reachable.

---

### Error: `Authentication failed` / `401 Unauthorized`

**Symptom:** Bundle deploy or app deploy fails with an authentication error.

**Fix:**
1. Verify the `deepak-workspace` CLI profile is configured correctly:
   ```bash
   databricks auth env --profile deepak-workspace
   ```
2. Regenerate your PAT in the Databricks workspace UI if it has expired.
3. Re-run `databricks configure --profile deepak-workspace`.

---

### Error: `DATABASE_TABLE_SYNC quota exceeded` (Lakebase synced tables)

**Symptom:** Creating a new Lakebase synced table fails with a quota error.

**Fix:** The workspace allows only 1 concurrent `DATABASE_TABLE_SYNC` pipeline. Wait for the in-progress pipeline (`india_post_pincode_directory_live` or `facilities_live`) to reach `ONLINE` status before creating the next synced table. Check synced-table status via `databricks online-tables list --profile deepak-workspace`, or in the Databricks workspace UI under Data > Lakebase > `virtue-health`. (Note: this affects the data pipeline, not the running app — no app route reads from Lakebase.)

---

### Error: `Duplicate unique_id values` (facilities synced table)

**Symptom:** Synced table creation for `facilities_live` fails due to primary key violations.

**Fix:** This is a known upstream data quality issue — the `facilities` source table contains duplicate `unique_id` values (the physical PK column documented upstream as `unique_id`). The fix requires deduplication in the source table by the data owner. Do not attempt to create the `facilities_live` synced table until the upstream issue is resolved.

---

### Error: Null bytes in facilities data (`\x00` / `CHAR(0)`)

**Symptom:** Queries against `facilities.name` or `facilities.description` fail with encoding errors.

**Context:** This was fixed during the data pipeline setup using:
```sql
REPLACE(col, CAST(CHAR(0) AS STRING), '')
```
The fix was applied to **`facilities_live` only**. The production API reads the **plain `facilities` table** (see "Read Paths" above), which still contains null bytes — so this issue is only **partially resolved** on the read path. See `data-pipeline.md §11`.

**Fix:** If the issue recurs after a source table refresh, re-apply the null byte replacement on `facilities_live` using the same pattern before re-seeding. When re-seeding `facilities_live`, use an explicit column list with the `REPLACE(...)` applied to `name` and `description` — do **not** use `INSERT ... SELECT *`, which re-introduces the null bytes. To resolve it on the actual read path, the same remediation must be applied to the plain `facilities` table (or the API repointed to `facilities_live`).

---

### Error: Geographic queries fail on `india_post_pincode_directory`

**Symptom:** Queries that filter or compute on latitude/longitude from `india_post_pincode_directory` return type errors.

**Fix:** The `latitude` and `longitude` columns in `india_post_pincode_directory` are `STRING` type (not `DOUBLE`). Always cast them explicitly in SQL:
```sql
CAST(latitude AS DOUBLE), CAST(longitude AS DOUBLE)
```
(Note: the `facilities` heatmap query also applies `CAST(latitude AS DOUBLE)` defensively. Whether `facilities.latitude/longitude` are genuinely `DOUBLE` is unverified — see Open Verification Tasks below. If they are `DOUBLE`, that cast is redundant but harmless.)

---

### Error: SQL Warehouse cold-start timeout

**Symptom:** First request after a period of inactivity times out; subsequent requests succeed.

**Fix:** This is expected behavior. The SQL Warehouse `5b2b29cce22aa2c4` may auto-terminate when idle, adding a 2–5 minute serverless **warehouse-cold-start** on the first request. Configure the warehouse's auto-stop setting in the Databricks workspace to a longer idle timeout if cold starts are disruptive. Alternatively, send a warm-up query on app startup.

---

### Error: Deep-link refresh 404s (e.g. hard refresh on `/desert`)

**Symptom:** Navigating within the SPA works, but a hard refresh or direct URL hit on a client route (`/facilities`, `/districts`, `/desert`) returns 404.

**Fix:** Client routes depend on the `server` plugin's SPA fallback (serving `index.html` for non-`/api` paths). If deep-link refresh 404s, check the static/SPA-fallback configuration in the `server` plugin (see "Same-Origin Serving and SPA Fallback"). Also confirm `client/dist/` was actually synced — a bundle missing the `client/dist/` entry in `sync.include` deploys no SPA at all.

---

### Error: Desert heatmap cache lost on restart

**Symptom:** After an app restart, the `/api/desert/*` endpoints are slow for the first 5 minutes.

**Context:** The Desert Planner cache is an in-memory `Map` with a 5-minute TTL, keyed by `heatmap-points:<capability>`, `state-gaps:<capability>`, and `capability-summary`. It does not persist across process restarts. This is a known limitation — no persistent cache backend (Redis, etc.) is currently configured.

**Fix:** No action required; the cache will repopulate within one request cycle. For production use, consider replacing the in-memory cache with a persistent store.

---

### Error: SQL injection risk (mitigated by quote-escaping, not parameterized)

**Context:** The server routes for `/api/facilities`, `/api/districts`, and the `/api/desert/*` endpoints build SQL by **string interpolation**, but every user-supplied `search` / `state` / `capability` value is escaped with `.replace(/'/g, "''")` (single-quote doubling) before interpolation. This mitigates basic quote-breakout injection — it is **not** "unsanitized" — but it is **not** equivalent to parameterized/bound queries: it does not defend against every edge case and is easy to forget when adding new routes.

**Mitigation (permanent fix):** Migrate these routes to parameterized queries using the Databricks SQL connector's parameter binding API. Until then, ensure any new route applies the same escaping to every interpolated user value.

---

## Open Verification Tasks

These items are empirically answerable in seconds against warehouse `5b2b29cce22aa2c4`. Resolve them and delete the conditional hedging in the relevant sections above and in the other docs.

- **OPEN — verify `facilities.latitude` / `facilities.longitude` column types (owner: TBD, opened 2026-06-15):**
  ```sql
  DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;
  ```
  Expected: confirm `DOUBLE` vs `STRING`. Record result here: `____`. On resolution, remove the "unverified" note in the geographic-queries error section and reconcile across docs.

- **Cross-ref — synced-table DDL keyword (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`):** tracked canonically as `runbook.md §12 OV-3`. Do not re-open a duplicate task here; standardize on `CREATE ONLINE TABLE` in all templates above until verified.

---

## Reference: Key Resource IDs

| Resource | Value |
|---|---|
| Databricks Workspace | `https://dbc-0a01f518-764a.cloud.databricks.com` |
| CLI Profile | `deepak-workspace` |
| Working directory (all commands) | `<repo>/virtue-health/` (the bundle root) |
| DABs Bundle Name | `virtue-health` |
| App Resource Key (databricks.yml) | `app` |
| Deployed App Name | `virtue-health` |
| `source_code_path` | `./` (resolves to `<repo>/virtue-health/`) |
| Local dev command | `npm run dev` (tsx watch; also Playwright `webServer`) |
| Production start command | `npm run start` (`node ./dist/server.js`; requires prior `npm run build`) |
| Build tool | `rolldown-vite@7.1.14` (via `package.json` `overrides`) |
| Sync paths (databricks.yml) | `dist/`, `client/dist/` (both required) |
| Warehouse DABs Variable | `warehouse_id` (`${var.warehouse_id}`) |
| SQL Warehouse ID (default value) | `5b2b29cce22aa2c4` |
| App SQL Warehouse Resource Binding | `sql-warehouse` (`CAN_USE`) |
| App Service Principal Client ID | `5ccf106a-7211-489d-a075-5ca82e07b0ae` |
| Source Catalog + Schema | `dais27hack.virtue_foundation_dataset_silver` |
| API facilities read table | `facilities` (plain table, NOT `facilities_live`) |
| Lakebase plugin status | **NOT loaded** in `server/server.ts` (`createApp` plugins: `analytics`, `server` only) |
| Lakebase UC Catalog | `virtue-pg` (backtick-quote in SQL: `` `virtue-pg` ``) |
| Lakebase Project | `virtue-health` |
| Lakebase Endpoint (PGHOST) | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` |
| Lakebase Database (PGDATABASE) | `databricks_postgres` |
| Lakebase Schema | `virtue_foundation_dataset_silver` |
| Lakebase branch discovery | `databricks postgres list-branches --project virtue-health --profile deepak-workspace` |
| Lakebase endpoint discovery | `databricks postgres list-endpoints <branch-name> --profile deepak-workspace` |
