# Virtue Health — Architecture Document

**Project:** Virtue Health — India Healthcare Data Explorer
**Hackathon:** DAIS 2026
**Workspace:** https://dbc-0a01f518-764a.cloud.databricks.com
**Document Date:** 2026-06-15

> **Scope of this document.** This is the architecture reference for Virtue Health. It is authoritative for: the component model, the read-path design, the Track 2 computation semantics, the security model, and the runtime/deployment topology. It is **not** the authoritative source for operational runbooks (see `runbook.md`), the data-pipeline seed procedure (see `data-pipeline.md`), the API response contracts (see `api-reference.md`), the canonical data-model / formula definitions (see `data-model.md`), or the canonical Known-Issues list (see `project-overview.md §10`). Where those topics appear here, they are summarized and cross-linked rather than restated in full.

---

## 0. Conventions, Glossary, and Where Things Live

### 0.1 Reading-Order Map

If you are new, read these in order. Each topic has exactly **one** authoritative document; this one cross-links to the others rather than duplicating them.

| If you are… | Read | This doc covers |
|-------------|------|-----------------|
| New to the project | `project-overview.md` (§1–§9), then this document | System shape, component model, read path |
| Deploying | `deployment.md` (authoritative for commands), then §5 here | Runtime/deployment topology |
| Responding to an incident | `runbook.md` | — (this doc gives architectural context only) |
| Touching the data pipeline | `data-pipeline.md` (authoritative for seed pattern) | §3 here gives the lineage overview |
| Reviewing the data model / formulas | `data-model.md` (authoritative for formulas + column types) | §7 here gives the computation semantics |
| Writing tests | `test-plan.md` | §7 here gives the computation semantics under test |
| Triaging bugs | `project-overview.md §10` (canonical Known Issues) | §10 here links to it |

### 0.2 Glossary (acronyms used in this document)

| Term | Expansion |
|------|-----------|
| **CDF** | Change Data Feed (Delta row-level change tracking) |
| **DABs** | Databricks Asset Bundles |
| **OLTP** | Online Transaction Processing |
| **SP** | Service Principal |
| **M2M** | Machine-to-Machine (OAuth client-credentials flow) |
| **NFHS-5** | National Family Health Survey, Round 5 |
| **SPA** | Single-Page Application |
| **UC** | Unity Catalog |

### 0.3 Naming Conventions (used consistently below)

- **Bundle** = `virtue-health` (the DABs bundle name).
- **App resource key** = `app` (the key under `resources.apps` in `databricks.yml`; what `${resources.apps.app...}` references resolve against).
- **Deployed app name** = `virtue-health` (what `databricks apps <cmd> <name>` takes on the command line).

When a command takes the deployed name, we write `virtue-health`; when DABs config references the resource, we write `app`.

- **Synced table = online table.** Databricks calls these objects **synced tables** in docs/UI and **online tables** in the CLI (`databricks online-tables ...`). They are the same object; this document uses "synced table" in prose and the CLI's `online-tables` noun in commands.
- **`virtue-pg` (hyphen) is the catalog.** Because the name contains a hyphen, it **must** be backtick-quoted in all SQL/DDL: `` `virtue-pg` ``. Unquoted `virtue-pg` is a syntax error; `virtue_pg` (underscore) is simply the wrong catalog name.
- **`facility_id` is the API response field.** Every shipped query and TypeScript client interface projects/consumes a numeric `facility_id`, **not** `unique_id` — see §7.6 and Known Issues. ("`unique_id`" is the upstream-documented physical PK name with the duplicate-value problem; the API does not return a field named `unique_id`.)

### 0.4 Working Directory

**The working directory for all `databricks bundle`, `databricks apps`, and `npm` commands is `<repo>/virtue-health/`** — this is where `databricks.yml`, `app.yaml`, and `package.json` live, and what `source_code_path: ./` resolves against. When this document says "bundle root," it means `<repo>/virtue-health/`, **not** the git repository top level (`<repo>/`).

### 0.5 Code References

Code is referenced by **handler/function name plus a searchable snippet**, not by line number (line numbers rot on the next edit). E.g. "the `/api/desert/heatmap-points` handler — search for `BETWEEN 6.0 AND 37.5`."

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Diagram](#2-component-diagram)
3. [Data Flow](#3-data-flow)
4. [Tech Stack Rationale](#4-tech-stack-rationale)
5. [Databricks Apps Deployment Model](#5-databricks-apps-deployment-model)
6. [Read Path: SQL Warehouse (with Lakebase as Future Path)](#6-read-path-sql-warehouse-with-lakebase-as-future-path)
7. [Track 2 Computation Model](#7-track-2-computation-model)
8. [Scalability Considerations](#8-scalability-considerations)
9. [Security Model](#9-security-model)
10. [Known Limitations and Open Issues](#10-known-limitations-and-open-issues)

---

## 1. System Overview

Virtue Health is a full-stack data application deployed on Databricks Apps that surfaces India healthcare facility data alongside NFHS-5 district health indicators. Its primary purpose is to help stakeholders identify "medical deserts" — geographic regions with high healthcare demand but insufficient or low-quality facility supply.

The application is organized around four hackathon tracks:

| Track | Name | Status |
|-------|------|--------|
| Track 1 | Facility Trust Desk | Not yet implemented |
| Track 2 | Medical Desert Planner | Implemented (data/API layer + UI) |
| Track 3 | Referral Copilot | Not yet implemented |
| Track 4 | Data Readiness Desk | Not yet implemented |

The implemented surface (Track 2) provides a heatmap of facility locations weighted by a trust signal, a **choropleth** state-fill layer keyed on gap score, a **confidence filter**, a clickable **state detail panel** (showing NFHS-5 indicator averages per state), and a **KPI bar**, plus a state-level gap score combining demand from NFHS-5 data against facility supply density (see §7 and §2 for the full component list). All Track 2 UI components are fully implemented; the heatmap is bounding-box filtered to India (see §7.4).

The architecture currently relies on a single live read path:

- **Databricks SQL Warehouse** (`5b2b29cce22aa2c4`) for all application queries, via `appkit.analytics.query()`, over Delta tables in catalog `dais27hack.virtue_foundation_dataset_silver`.

A second read path — **Lakebase Postgres** (project `virtue-health`, endpoint `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`) — is provisioned and partially synced via CDF, but **no code reads from it today, and the Lakebase plugin is not even loaded** (see §1.1 and Known Issues). The Lakebase OLTP read path for application data is aspirational; see §6.2.

### 1.1 Lakebase Is Not Wired (Important)

`server/server.ts` calls `createApp({ plugins: [ analytics({}), server() ] })` — the **`lakebase` plugin is NOT registered**, so `appkit.lakebase` does not exist at runtime. `onPluginsReady` calls only `setupVirtueHealthRoutes(appkit)`; `setupSampleLakebaseRoutes` (exported from `server/routes/lakebase/todo-routes.ts`) is **never imported or called**, so `/api/lakebase/todos` is **not served**. `client/src/App.tsx` registers routes only for `/`, `/facilities`, `/districts`, `/desert` — there is **no `/lakebase` route** and no nav link, so `client/src/pages/lakebase/LakebasePage.tsx` is unreachable.

These are orphaned scaffold files, not a "live sample." To make **any** Lakebase route functional you must (a) add the `lakebase` plugin to `createApp`'s `plugins` array, (b) call `setupSampleLakebaseRoutes(appkit)` inside `onPluginsReady`, and (c) register the client route and nav entry. Until then, all `PG*` / `LAKEBASE_ENDPOINT` env values are unused at runtime.

> Confirmed against `server/server.ts`: `createApp` loads only `analytics` + `server`, and `onPluginsReady` calls only `setupVirtueHealthRoutes`.

---

## 2. Component Diagram

A textual summary precedes the diagram so the content survives if the box-drawing wraps in a narrow viewport. The system has two paths: a **request path** (browser → Express → SQL Warehouse → Delta) and a **data/sync path** (Delta `_live` tables → CDF → Lakebase Postgres, which is **not read by the app today**).

### 2.1 Request Path (≤72 cols)

```
Browser
  │  HTTPS
  ▼
Databricks Apps ingress
  │
  ▼
App Container (Node.js)
  ├─ React 19 / Vite SPA  (AppKit UI, Router v7, Tailwind,
  │    MapLibre GL + react-map-gl)
  │    routes: /  /facilities  /districts  /desert
  │    (no /lakebase route)
  │        │  HTTP (relative, same-origin)
  │        ▼
  └─ Express backend (@databricks/appkit server plugin)
       plugins loaded: analytics({}), server()   (lakebase NOT loaded)
       /api/summary                /api/districts
       /api/facilities             /api/districts/states
       /api/facilities/states      /api/desert/heatmap-points
       /api/desert/state-gaps      /api/desert/capability-summary
       (also serves the SPA + static fallback to index.html)
            │  appkit.analytics.query()
            ▼
      SQL Warehouse (5b2b29cce22aa2c4)
            │  Delta scan
            ▼
      Delta Lake — dais27hack.virtue_foundation_dataset_silver
```

### 2.2 Data / Sync Path (≤72 cols)

```
Delta SOURCE tables (read-only):
  facilities, nfhs_5_district_health_indicators,
  india_post_pincode_directory

Delta LIVE tables (CDF-enabled; app writes target these):
  facilities_live, nfhs_5_..._live, india_post_..._live
       │  CDF (TRIGGERED mode synced tables; quota: 1 pipeline)
       ▼
Lakebase Postgres   (NOT read by the app; plugin not loaded —
                     appkit.lakebase absent; todo route orphaned)
  Project:  virtue-health
  Catalog:  `virtue-pg` (UC)  →  DB: databricks_postgres
  Schema:   virtue_foundation_dataset_silver
  Endpoint: ep-solitary-poetry-d8v1iwpc.database
            .us-east-2.cloud.databricks.com
  nfhs_5_district_health_indicators  ONLINE
  facilities_live                    pending (quota)
  india_post_pincode_directory_live  pending (quota)
```

```
Identifiers:
  Bundle: virtue-health | App resource key: app | Deployed name: virtue-health
  App SP: 5ccf106a-7211-489d-a075-5ca82e07b0ae  (OAuth M2M to Databricks)
```

> If this diagram wraps unreadably in your viewport, rely on the §2.1/§2.2 textual summaries and the component table in §2.3. A future revision may replace the ASCII with a Mermaid diagram for GitHub rendering.

### 2.3 Desert Planner (`/desert`) Frontend Components

The Desert Planner page is materially richer than "a heatmap + a gap table." The component tree (under `client/src/pages/desert/`) is:

| Component | Role |
|-----------|------|
| `DesertPage` | Page shell; orchestrates data + controls; renders the syncing banner and data-limitation disclosure |
| `DesertControls` | Toggle panel: **Show Heatmap**, **Show Choropleth**, **Show Confidence Filter** |
| `DesertMap` | MapLibre GL map (`maplibre-gl` + `react-map-gl`) rendering both the heatmap point layer and the choropleth state-fill layer |
| `DesertKpiBar` | KPI summary bar across the top |
| `DesertLegend` | Legend for the heatmap / choropleth color scales |
| `DesertDetailPanel` | Clickable per-state detail panel (opens on choropleth state selection) |
| `useDesertData` | Hook that fetches `state-gaps`, `heatmap-points`, and `capability-summary` and exposes `syncing`/error state |

---

## 3. Data Flow

> **Authoritative source:** `data-pipeline.md` owns the seed/CDF procedure. This section gives the architectural lineage overview only.

### 3.1 Source Data Lineage

The authoritative source is the upstream Unity Catalog:

```
databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset
  │
  │  (catalog clone / INSERT INTO SELECT FROM)
  ▼
dais27hack.virtue_foundation_dataset_silver
  ├── facilities                         (10,088 rows, read-only)
  ├── nfhs_5_district_health_indicators  (706 rows, read-only)
  └── india_post_pincode_directory       (165,627 rows, read-only)
```

These source tables are read-only reference copies. They are scanned directly by the SQL Warehouse for all application queries (facility counts, paginated lookups, heatmap coordinates, gap scoring). **Note:** the production API reads the **plain** `facilities` table (not `facilities_live`); see §3.5 for the null-byte consequence and Known Issues.

### 3.2 Live Table Seeding (Canonical Order)

Live variants are maintained in the same schema. The **canonical seeding order — identical across this document, `data-pipeline.md`, and `runbook.md` — is: disable CDF → TRUNCATE → bulk INSERT → re-enable CDF.**

The ordering is deliberate: TRUNCATE must occur **while CDF is disabled**, otherwise it is logged as delete events at the seed version, defeating the goal of a clean change feed. CDF is re-enabled only *after* the INSERT so the bulk load itself is not recorded as change events either.

```sql
-- Canonical clean-CDF-log seed order:
ALTER TABLE <table>_live SET TBLPROPERTIES ('delta.enableChangeDataFeed' = false);
TRUNCATE TABLE <table>_live;
-- ... bulk INSERT (see null-byte note in §3.5 for facilities) ...
ALTER TABLE <table>_live SET TBLPROPERTIES ('delta.enableChangeDataFeed' = true);
```

Under this order, `table_changes(..., <seed_version>)` shows **zero** insert/delete events for the seed. Any procedure that truncates or inserts while CDF is enabled will record spurious events; see `data-pipeline.md` and `runbook.md` for the operational procedure and the corresponding test expectations. The matching pipeline test is **`P-TC-03`** in `test-plan.md` (the zero-CDF-events assertion); note that `P-TC-01` is the separate row-count check (`SELECT COUNT(*)` = 10,088), not the CDF-event check.

### 3.3 CDF Pipeline: Delta → Lakebase Postgres

```
facilities_live                        (CDF enabled)
nfhs_5_district_health_indicators_live (CDF enabled)
india_post_pincode_directory_live      (CDF enabled)
         │
         │  Lakebase synced tables (= online tables)
         │  Scheduling mode: TRIGGERED
         │  (sequential creation, quota: 1 concurrent pipeline)
         ▼
Lakebase Postgres
  Host:    ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com
  Catalog: `virtue-pg` (Unity Catalog)
  DB:      databricks_postgres
  Schema:  virtue_foundation_dataset_silver
  Tables:  nfhs_5_district_health_indicators (ONLINE)
           facilities_live                   (pending quota)
           india_post_pincode_directory_live (pending quota)
```

CDF tracks row-level changes (`_change_type`, `_commit_version`, `_commit_timestamp`) on each `_live` Delta table. The Lakebase synced-table pipeline consumes these change events in TRIGGERED mode and applies upserts/deletes to the corresponding Postgres tables, keeping the Postgres replica consistent with the Delta source without full table scans on each sync. **The application does not currently read from these Postgres tables, and the Lakebase plugin is not loaded** (see §1.1 and §6.2).

### 3.4 Application Write Path

Application-layer writes (e.g., future Track 1 trust annotations, Track 4 data quality flags) are directed to the `_live` Delta tables, never to the read-only source tables. Changes propagate to Postgres automatically via the CDF pipeline on the next trigger cycle.

### 3.5 Null Byte Remediation (Read Path Still Affected)

During data preparation, the `facilities.name` and `facilities.description` columns were found to contain embedded null bytes (`0x00`). These were stripped using:

```sql
REPLACE(col, CAST(CHAR(0) AS STRING), '')
```

This must be applied as an explicit, column-aliased projection during the INSERT INTO SELECT step for `facilities` — **do not use `SELECT *`** for facilities seeding/reloads, or the null bytes will be re-introduced into `facilities_live` and downstream Postgres.

**Important — this is only partially resolved.** The null bytes are stripped in **`facilities_live`** only. The production API reads from the **plain** `facilities` table (§3.1, §6.1), which **still contains null bytes**. Therefore API responses for facility `name`/`description` can still carry `0x00`. This is tracked as an OPEN issue in §10 and `project-overview.md §10`; do not describe the null-byte issue as fully "RESOLVED" while the read path is the plain table.

---

## 4. Tech Stack Rationale

### 4.1 Frontend: React 19 + TypeScript + Vite + AppKit UI + MapLibre

React 19 is used for its concurrent rendering capabilities and the latest stable ecosystem. TypeScript enforces type safety across a codebase that works with multiple complex data shapes (facility records, NFHS indicator rows, geographic coordinates). Vite provides fast HMR during development and an optimized production bundle.

**The build uses `rolldown-vite` 7.1.14 via an npm override** (`"vite": "npm:rolldown-vite@7.1.14"` in both `dependencies`/`overrides`), not stock Vite — relevant for anyone debugging the build.

`@databricks/appkit-ui` is the prescribed component library for Databricks Apps. Using AppKit UI ensures visual consistency with the Databricks platform, provides pre-built data-display primitives (tables, KPI cards, filters), and integrates natively with AppKit's authentication context so the frontend receives the current user's identity without bespoke auth wiring.

React Router v7 provides client-side routing for the four main pages (`/`, `/facilities`, `/districts`, `/desert`) without full-page reloads.

Tailwind CSS provides utility-first styling for layout and spacing, complementing AppKit UI's component-level styles.

**Mapping:** the Desert Planner heatmap and choropleth are rendered with **`maplibre-gl` (^5.24)** + **`react-map-gl` (^8.1)** (see `DesertMap.tsx`). This is the library the entire Track 2 geographic UI depends on.

**Other notable runtime dependencies** (present in `package.json` but omitted from terser "React/Vite/AppKit/Router/Tailwind" summaries): `zod` (request validation in the scaffold routes), `lucide-react` (icons — e.g. the `Activity` brand mark and the mobile-nav `Menu`), `next-themes`, `react-resizable-panels`, and `embla-carousel-react`.

### 4.2 Backend: Express.js via AppKit Server Plugin

The backend is an Express.js server initialized through `@databricks/appkit`'s server plugin. `server/server.ts` calls `createApp({ plugins: [ analytics({}), server() ], onPluginsReady })`; routes are registered in `onPluginsReady` via `setupVirtueHealthRoutes(appkit)`. AppKit's server plugin handles:

- Injecting Databricks OAuth tokens (on behalf of the logged-in user or the app service principal) into outbound SDK calls.
- Providing the `appkit.analytics.query()` helper that routes SQL to the configured SQL Warehouse.
- Serving the built React SPA (from `dist/`) and the API from the **same** Express process/origin, including SPA fallback for client-side routes (see §5.4).
- Establishing the runtime trust boundary between the frontend SPA and Databricks data plane resources.

> **Note:** the `lakebase` plugin is **not** in the `plugins` array, so `appkit.lakebase.query()` is **not available** at runtime. No production route uses it (see §1.1, §6.2). Express was chosen over alternatives (Fastify, Hono) because AppKit's server plugin documentation and examples are Express-native, reducing integration risk in a hackathon timeline.

### 4.3 Databricks Apps Platform

Databricks Apps provides a managed hosting environment with:

- Low-latency access to the Databricks control plane and SQL Warehouse.
- Native Unity Catalog credential passthrough — the app runs under a service principal and requests can be scoped to the SP's permissions without managing secrets manually.
- DABs (Databricks Asset Bundles) for repeatable, versioned deployment.

### 4.4 DABs Bundle

The bundle name `virtue-health` encapsulates all Databricks resources (the app definition, warehouse binding, permission grants) as code. Deployment is two steps (run from the bundle root `<repo>/virtue-health/`, see §0.4):

```bash
databricks bundle deploy -t default --profile deepak-workspace
databricks apps deploy virtue-health --profile deepak-workspace
```

`deployment.md` is the authoritative source for deploy commands; this ensures the app definition and its resource bindings are always in sync with the deployed artifact.

---

## 5. Databricks Apps Deployment Model

> **Authoritative source for commands:** `deployment.md`. This section describes the architectural model.

### 5.1 Bundle Structure

The actual `databricks.yml` (at `<repo>/virtue-health/databricks.yml`) declares:

```yaml
bundle:
  name: virtue-health

sync:
  include:
    - dist/
    - client/dist/

variables:
  warehouse_id:
    description: SQL Warehouse ID for analytics queries.

resources:
  apps:
    app:                              # ← resource key is `app`
      name: "virtue-health"           # ← deployed app name
      description: "Healthcare data explorer for DAIS 2026 ..."
      source_code_path: ./            # ← bundle root = <repo>/virtue-health/, not <repo>/
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: ${var.warehouse_id}   # ← warehouse supplied via DABs variable
            permission: CAN_USE

targets:
  default:
    default: true
    workspace:
      host: https://dbc-0a01f518-764a.cloud.databricks.com
    variables:
      warehouse_id: 5b2b29cce22aa2c4  # ← default value for the variable
```

Key facts:

- The DABs **resource key** is `app`; only the `name:` field is `"virtue-health"` (see §0.3).
- `source_code_path` is `./`, which resolves against the bundle root `<repo>/virtue-health/` (where `databricks.yml` lives), **not** the git repo top level.
- The warehouse ID is supplied via a DABs **variable** `${var.warehouse_id}` (default `5b2b29cce22aa2c4` under `targets.default.variables`), not as a literal inside the app block.
- The app declares a named resource binding `sql-warehouse` with `permission: CAN_USE`.
- The `sync.include` block ships **both** `dist/` (the built server bundle) **and** `client/dist/` (the built client assets) — it is **not** `dist/` alone. Omitting `client/dist/` would deploy a server with no client assets.

The `app.yaml` runtime manifest is:

```yaml
command: ['npm', 'run', 'start']
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse        # ← sourced from the bound resource, NOT a literal value
```

The warehouse env var uses `valueFrom: sql-warehouse` (resolving from the bound resource), not `value: 5b2b29cce22aa2c4`. Lakebase connectivity, *were the plugin ever loaded*, would be handled by the AppKit Lakebase plugin via standard Postgres env vars (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE`, `LAKEBASE_ENDPOINT`) — there is no hand-rolled `LAKEBASE_PASSWORD` secret reference in `app.yaml`. Since the Lakebase plugin is not registered (§1.1), these `PG*` / `LAKEBASE_ENDPOINT` values are unused at runtime today.

#### 5.1.1 Warehouse ID Resolution Chain

A reader debugging "`DATABRICKS_WAREHOUSE_ID` not set" needs the full indirection in one place. The warehouse ID is never a literal in the app block; it resolves like this:

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

### 5.2 App Runtime

At runtime, Databricks Apps:

1. Launches the Node.js process inside a managed container via `npm run start`, which runs `NODE_ENV=production node --env-file-if-exists=./.env ./dist/server.js` — i.e. it executes the **already-built** `dist/server.js` and performs **no build** (see §5.3).
2. Injects environment variables providing the workspace URL, warehouse binding, and OAuth token material for the app SP.
3. Routes inbound HTTPS traffic from the browser through the Apps ingress layer to the Express server.
4. Serves the Vite-built React SPA as static assets through the same Express process (see §5.4).

### 5.3 Build vs. Start (Local Development)

The `start` and `dev` scripts are not interchangeable; this is a common new-dev pitfall. All commands below run from the bundle root `<repo>/virtue-health/` (§0.4):

- **Local development:** use `npm run dev` (`tsx watch ... ./server/server.ts`). This is also what Playwright's `webServer.command` launches. A `predev` hook first runs `npm run sync` (`appkit plugin sync`) + `npm run typegen` (`appkit generate-types`).
- **`npm run start` is the production command.** It runs the pre-built `./dist/server.js` and does **no build**, so it **errors outright if `dist/` does not exist** (no build has run).
- **Production/deploy build flow:** `npm run build` (runs `build:server` then `build:client`; a `prebuild` hook first runs `appkit plugin sync` + `appkit generate-types`) → then `npm run start`.
- **Note:** `npm install` triggers `postinstall: npm run typegen`.

### 5.4 Static Serving and SPA Fallback (Same-Origin Contract)

The Express process (AppKit `server` plugin) serves **both** the API (`/api/*`) and the built SPA from `dist/` on a **single origin**. Because of this, the client uses **relative** fetch paths (e.g. `fetch('/api/facilities/states')`) — there is no configurable API base URL, and cross-origin deployment is not supported without changes.

Client-side routes (`/facilities`, `/districts`, `/desert`) rely on the server plugin's **SPA fallback** (serving `index.html` for non-`/api` paths) so deep links and hard refreshes resolve to the SPA rather than 404ing. If a deep-link hard refresh on `/desert` returns 404, the static / SPA-fallback configuration in the `server` plugin is the place to check.

### 5.5 Service Principal

The app service principal client ID is `5ccf106a-7211-489d-a075-5ca82e07b0ae`. This SP holds the permissions required to:

- Execute queries against SQL Warehouse `5b2b29cce22aa2c4`.
- Read from Unity Catalog `dais27hack.virtue_foundation_dataset_silver`.
- Connect to Lakebase endpoint `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` (provisioned for future use; not exercised today).

The SP credentials are managed by the Databricks Apps platform and are not embedded in application source code.

### 5.6 Local Environment File

The committed `.env.example` ships **placeholders, not resolved values**:

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

Copying `.env.example` to `.env` yields placeholders, not working values. `FLASK_RUN_HOST` is a scaffold leftover and is unused by this Node app. Set `DATABRICKS_HOST` to the workspace URL.

Since the Lakebase plugin is not currently loaded (§1.1), the `PG*` / `LAKEBASE_ENDPOINT` values are **unused at runtime today**. To populate them for local dev *if/when* Lakebase is wired, you need the Lakebase **branch** first (a Lakebase branch is a named, isolatable copy of the Postgres project's data/endpoint; a project can have several). List branches, then list that branch's endpoints:

```bash
# 1) Find the branch name (a Lakebase project may have multiple branches):
databricks postgres list-branches --project virtue-health --profile deepak-workspace

# 2) Pass the chosen branch to list its endpoints:
databricks postgres list-endpoints <branch-name> --profile deepak-workspace
```

> The exact `postgres` subcommands are Lakebase/CLI-version-specific — confirm against `databricks postgres --help` for your CLI version. If the branch-listing subcommand differs, use `databricks postgres --help` to discover it rather than guessing.

**Port resolution:** Playwright's `baseURL` is `http://localhost:${DATABRICKS_APP_PORT || PORT || 8000}`. Set `DATABRICKS_APP_PORT` (not `PORT`) for local dev to keep the server bind port and the test base URL aligned; setting only `PORT` can mismatch them.

---

## 6. Read Path: SQL Warehouse (with Lakebase as Future Path)

### 6.1 SQL Warehouse Path (All Production Endpoints)

**Resource:** Warehouse `5b2b29cce22aa2c4`
**Client:** `appkit.analytics.query()`
**Tables:** `dais27hack.virtue_foundation_dataset_silver.facilities`, `nfhs_5_district_health_indicators`, `india_post_pincode_directory` (the **plain** tables, not the `_live` variants)

**Every production API endpoint reads from the SQL Warehouse.** This includes both the analytical/aggregation endpoints and the paginated row-lookup endpoints:

| Endpoint | Query character |
|----------|-----------------|
| `GET /api/summary` | Aggregation: `COUNT(*)` over the plain `facilities` table + `COUNT(DISTINCT state_ut)`, `COUNT(DISTINCT district_name)`, `AVG(sex_ratio_total_f_per_1000_m)` over NFHS |
| `GET /api/facilities` | Paginated lookup (50/page) with search/state filter, `ORDER BY name ASC`, `LIMIT/OFFSET` |
| `GET /api/facilities/states` | Distinct `address_stateorregion` from facilities |
| `GET /api/districts` | Filtered row lookup from NFHS by `state_ut` (**no `LIMIT`/`OFFSET` — full filtered set**, see §6.4) |
| `GET /api/districts/states` | Distinct `state_ut` from NFHS |
| `GET /api/desert/heatmap-points` | Bounding-box-filtered lat/lon scan with trust weight |
| `GET /api/desert/state-gaps` | FULL OUTER JOIN facilities × NFHS on normalized state key, GROUP BY |
| `GET /api/desert/capability-summary` | GROUP BY raw `capability`, top 20 by facility count |

Analytical endpoints benefit from Databricks SQL's vectorized execution, Delta column pruning, and distributed aggregation. The paginated facilities/districts endpoints also run here today (see §6.2 for why this is the current — not necessarily final — state). Because the read path is the **plain** `facilities` table (not `facilities_live`), facility `name`/`description` responses can still carry null bytes (§3.5).

The three desert endpoints apply a 5-minute in-memory cache (server-side `Map`) keyed by **prefixed composite keys**, not the bare param value:

| Endpoint | Cache key |
|----------|-----------|
| `GET /api/desert/heatmap-points` | `heatmap-points:<capability>` |
| `GET /api/desert/state-gaps` | `state-gaps:<capability>` |
| `GET /api/desert/capability-summary` | `capability-summary` (fixed) |

The key prefix is what prevents heatmap and state-gaps from colliding on the same `capability` value.

### 6.2 Lakebase Path (Provisioned, NOT Wired — Plugin Not Loaded)

**Resource:** Lakebase project `virtue-health`
**Endpoint:** `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`
**UC Catalog:** `` `virtue-pg` `` → DB `databricks_postgres` → Schema `virtue_foundation_dataset_silver`

The intent was to serve paginated/filtered OLTP access patterns (`/api/facilities`, `/api/districts`) from a Postgres replica with B-tree indexes, responding in single-digit milliseconds without consuming warehouse slots. **This is not implemented, and not even reachable.** As detailed in §1.1:

- The `lakebase` plugin is **not** in `createApp`'s `plugins` array, so `appkit.lakebase` does not exist at runtime.
- `setupSampleLakebaseRoutes` (in `server/routes/lakebase/todo-routes.ts`, schema `app.todos`) is **never imported or called**, so `/api/lakebase/todos` is **not served**.
- `client/src/pages/lakebase/LakebasePage.tsx` is **not routed** — there is no `/lakebase` route.

So there is no working Lakebase code path at all — the scaffold is orphaned dead code, unrelated to facilities/districts. Note that `nfhs_5_district_health_indicators` is reported ONLINE *in Lakebase*, yet `/api/districts` still reads from the warehouse — confirming the Lakebase OLTP path is aspirational, not wired.

**Current status of Lakebase synced tables:**

| Table | Lakebase Status |
|-------|----------------|
| `nfhs_5_district_health_indicators` | ONLINE |
| `facilities_live` | Pending (quota limit) |
| `india_post_pincode_directory_live` | Pending (quota limit) |

The synced-table DDL is owned by `data-pipeline.md` (and `runbook.md` for recovery). It is **Lakebase-version-specific and has not been verified against this workspace**; before running any `CREATE ... TABLE`, confirm the exact statement with `databricks online-tables --help` (or the Lakebase docs for your CLI version). The form below is a **template**, not a known-good command, and is reproduced here only to show the four-level backticked catalog path. The verified DDL **keyword** (`CREATE ONLINE TABLE` vs `CREATE SYNCED TABLE`) is tracked as an Open Verification Task in `runbook.md §12 OV-3` — standardize on `CREATE ONLINE TABLE` until that task resolves:

```sql
-- TEMPLATE — verify syntax before use; same template used in data-pipeline.md / runbook.md
CREATE ONLINE TABLE `virtue-pg`.databricks_postgres.virtue_foundation_dataset_silver.<table>
  PRIMARY KEY (...)
  FROM dais27hack.virtue_foundation_dataset_silver.<table>_live
  WITH SCHEDULING POLICY = TRIGGERED;
```

Note the four levels — `` `virtue-pg` `` (backticked, hyphenated catalog) → `databricks_postgres` (database) → `virtue_foundation_dataset_silver` (schema) → table. The `databricks_postgres` database level between catalog and schema is required.

To move facilities/districts to Lakebase, a future iteration must (a) add the `lakebase` plugin, (b) register routes that call `appkit.lakebase.query()`, and (c) keep the existing API contracts so the frontend is unaffected. Until then, all reads are warehouse reads.

### 6.3 Geographic Type Mismatch and Casting

The `india_post_pincode_directory` table stores `latitude` and `longitude` as `STRING` rather than `DOUBLE`. Any geographic query against this table requires an explicit `CAST(latitude AS DOUBLE)` / `CAST(longitude AS DOUBLE)`.

The heatmap query also applies `CAST(latitude AS DOUBLE)` to the **`facilities`** table (`/api/desert/heatmap-points` handler — search for `CAST(latitude AS DOUBLE)` and `BETWEEN 6.0 AND 37.5`). The project context lists `facilities.latitude/longitude` as `DOUBLE`; if that is correct, the cast is defensive/redundant. The actual type is an **Open Verification Task** (see §10.1) — do not assume either way until the `DESCRIBE` has been run and recorded.

### 6.4 `/api/districts` Has No Pagination

`/api/districts` applies **no `LIMIT`/`OFFSET`** (the `/api/districts` handler builds a `WHERE state_ut = ...` filter with no paging clause); it returns the **entire filtered result** in a single response — up to all 706 NFHS rows when unfiltered. The Districts page renders every returned row (no client-side paging either), so the full set is loaded into the DOM on each request. This is acceptable at 706 rows, but is a concrete current behavior (large single payload, all rows in DOM). If the NFHS dataset grew, or for Track 3/4 reuse, server-side paging would be needed.

---

## 7. Track 2 Computation Model

Track 2 endpoints embed non-trivial SQL whose semantics are load-bearing for correctness. They are documented here in full because this document is the architecture reference for Track 2's computation model. The **canonical formula definitions** live in `data-model.md`; the canonical bug fixes are tracked in `project-overview.md §10` (Known Issues) — this section summarizes and cross-links rather than re-deriving fixes.

### 7.1 Trust Weight

```sql
LEAST(
  COALESCE(
    SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')),
    1
  ) / 3.0,
  1.0
)
```

This counts comma-separated `source_types` tokens, divides by 3, and caps at 1.0. For a present value with N tokens, weight = `min(N/3, 1.0)`.

**NULL edge case (possible negative value) — see Known Issues #6.** `NULLIF(TRIM(source_types), '')` converts empty/whitespace-only values to `NULL`. In Spark SQL, `SIZE(SPLIT(NULL, ','))` returns **-1**, and because -1 is non-null, the `COALESCE(..., 1)` fallback **does not fire** — yielding `LEAST(-1/3.0, 1.0) = -0.333` (a negative trust weight) for NULL `source_types`. This contradicts any documentation claiming NULL → 0.333 and any test asserting `0.0 ≤ trust_weight ≤ 1.0`. This behavior is unverified — see Open Verification Task §10.1.

**Recommended fix (canonical — NULL `source_types` → intended 0.333):**

```sql
LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
```

Do **not** instead clamp with `GREATEST(..., 0.0)` unless you intend NULL `source_types` to score **0**, not 0.333 — the two fixes have **different semantics** (the `COALESCE(NULLIF(..., -1), 1)` form maps NULL → 0.333; a `GREATEST(..., 0.0)` clamp maps it → 0.0). Decide which semantics you want and document the decision in Known Issues #6.

### 7.2 Demand Index (deprivation-based demand proxy)

The field is named `demand_index` in code and responses, and the concept is "deprivation-based demand." **They are the same number:** we call the *field* `demand_index` and the *concept* "deprivation-based demand." Higher = more deprivation = more unmet demand.

Computed per state in the `nfhs_state` CTE:

```sql
ROUND((
    (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
  + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
  + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
  + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
) / 4.0, 1)
```

It is the average of four `(100 − coverage%)` deprivation terms over electricity, improved water, improved sanitation, and child birth civil registration. Each missing per-column average defaults to 50 (so the deprivation term defaults to 50).

### 7.3 Gap Score and the State-Name Join

The state-gaps query joins facility supply against NFHS demand with a **`FULL OUTER JOIN`** on a normalized state key `LOWER(TRIM(state))` (facilities `address_stateorregion` ↔ NFHS `state_ut`):

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

Material behaviors to note:

- The numerator is `COALESCE(ns.demand_index, 50)` — a state with no matching NFHS demand defaults to demand 50, not raw `demand_index`.
- The denominator (supply score) is floored at `0.1` to prevent division by zero where there are no matching facilities.
- Because it is a `FULL OUTER JOIN`, states present in only one source still appear (`state` is `COALESCE(ns.state_ut, fs.address_stateorregion)`).
- **State-name normalization is the single biggest Track 2 correctness risk — see Known Issues #5.** The join matches on `LOWER(TRIM(...))` only. Variants such as "NCT of Delhi" vs "Delhi", or differing punctuation/abbreviations between `address_stateorregion` and `state_ut`, will **not** match — producing unmatched rows, default-50 demand, or null-side facility counts that distort gap scores.

**Example remediation — normalize both sides with a crosswalk before joining** (run the `EXCEPT` diagnostic in `runbook.md` first to enumerate the *actual* mismatches in this dataset; the values below are **illustrative and must be verified**):

```sql
-- minimal crosswalk; extend after running the EXCEPT diagnostic in the runbook
CASE LOWER(TRIM(state))
  WHEN 'nct of delhi' THEN 'delhi'
  WHEN 'orissa'       THEN 'odisha'
  WHEN 'pondicherry'  THEN 'puducherry'
  ELSE LOWER(TRIM(state))
END AS state_key
```

Each gap row also carries a derived `confidence` ('high' if `source_type_variants ≥ 3`, 'medium' if `≥ 1`, else 'low'), plus `source_type_variants`, `district_count`, and `supply_score`. The `confidence` value feeds the Desert Planner's **Show Confidence Filter** control.

### 7.4 Heatmap Bounding Box

The heatmap query filters to non-null coordinates **and** India's bounding box:

```sql
WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  AND CAST(latitude  AS DOUBLE) BETWEEN 6.0  AND 37.5
  AND CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5
```

Facilities with coordinates outside this box are **silently dropped** and never appear on the heatmap. Any acceptance-criteria claim that the heatmap shows "facility locations" must be qualified by this exclusion.

### 7.5 Capability Filter vs. Capability Summary (Asymmetric Semantics)

`capability-summary` groups on the **raw** `capability` string (no comma-splitting), so a composite like `'Emergency,Surgery,ICU'` forms its own bucket, and that exact composite string becomes a dropdown option (`LIMIT 20` ⇒ at most 20 options). However, `heatmap-points` and `state-gaps` filter via `capability ILIKE '%<value>%'`.

These two semantics are **not symmetric**:

- Selecting the composite option `'Emergency,Surgery,ICU'` runs `capability ILIKE '%Emergency,Surgery,ICU%'`, matching only rows whose capability string contains that exact comma-joined substring — which can be **fewer** facilities than the summary's `facility_count` for that bucket implied.
- Selecting `'Emergency'` matches **any** capability string containing `Emergency`, including composites.

Grouping is exact-string; filtering is substring. This mismatch is a real correctness/UX trap and should either be documented prominently in the UI or fixed by splitting `capability` on comma on **both** sides (grouping and filtering).

### 7.6 Response Shapes

> **Authoritative source:** `api-reference.md` owns the full response contracts and example bodies. The shapes below are the architecture-level summary, reflecting the actual code and `client/src/pages/desert/types.ts`. All endpoints return JSON **objects** (not bare arrays), each with a `syncing` flag.

```ts
// GET /api/summary
{ totalFacilities: number;                             // COUNT(*) over the plain facilities table
  statesCovered: number;                               // distinct state_ut (NFHS)
  districtsCovered: number;                            // distinct district_name (NFHS) — < 706
  avgSexRatio: number | null;                          // sex_ratio_total_f_per_1000_m, nullable
  syncing: boolean }

// GET /api/facilities
{ facilities: Facility[]; total: number; page: number;
  pageSize: number; totalPages: number; syncing: boolean }
//   Facility = { facility_id, name, organization_type,
//                address_city, address_stateorregion, address_country }
//   facility_id is NUMBER (the API projects facility_id, not unique_id — see note below)
//   (capability/specialties/equipment/lat/lon/description/etc. are NOT returned)

// GET /api/facilities/states  and  GET /api/districts/states
{ states: string[]; syncing: boolean }

// GET /api/districts
{ districts: DistrictIndicator[]; syncing: boolean }
//   DistrictIndicator = { district_name, state_ut, households_surveyed,
//                         hh_electricity_pct, hh_improved_water_pct,
//                         hh_use_improved_sanitation_pct,
//                         child_u5_whose_birth_was_civil_reg_pct }
//   (only these ~7 columns — NOT all ~100 NFHS indicators; NOT paginated, see §6.4)

// GET /api/desert/heatmap-points
{ points: HeatmapPoint[]; syncing: boolean }
//   HeatmapPoint = { facility_id, latitude, longitude, trust_weight,
//                    capability, address_stateorregion }
//   facility_id is NUMBER (not unique_id — see note below)

// GET /api/desert/state-gaps
{ gaps: StateGap[]; syncing: boolean }
//   StateGap = { state, facility_count, avg_trust_weight, source_type_variants,
//                demand_index, district_count, supply_score, gap_score, confidence }

// GET /api/desert/capability-summary
{ summary: CapabilitySummaryItem[]; syncing: boolean }
//   CapabilitySummaryItem = { capability, facility_count, avg_trust_weight, state_count }
//   grouping is on the RAW capability string (no comma-splitting);
//   composite strings form distinct buckets; LIMIT 20 ⇒ at most 20 rows
```

**`facility_id` (not `unique_id`) — important.** The `Facility` and `HeatmapPoint` shapes project a **numeric `facility_id`**, confirmed by the server queries (`virtue-health-routes.ts` selects `facility_id, name, organization_type, ...` and `facility_id` in the heatmap) and by the client interfaces (`client/src/pages/facilities/FacilitiesPage.tsx` and `client/src/pages/desert/types.ts` both declare `facility_id: number`). The API does **not** return a field named `unique_id`. The upstream-documented physical PK `unique_id` (which has the duplicate-value problem) is a separate concern — whether the *physical column* is also named `facility_id` is an Open Verification Task in `data-model.md`, but the **response field is `facility_id: number`** regardless. Any consumer coding against `unique_id: string` will break.

`districtsCovered` is `COUNT(DISTINCT district_name)`; because district names repeat across states (the NFHS PK is `district_name + state_ut`), this value is strictly **less than 706**.

**`statesCovered` vs the Facilities-page state filter draw from different universes.** `statesCovered` (Overview KPI) counts NFHS-5 `state_ut`. The Facilities-page state filter is populated from `/api/facilities/states`, which returns distinct **`address_stateorregion`** from the **facilities** table. These two state universes do **not** necessarily match (this is exactly the state-name mismatch of Known Issues #5). A reader should not assume the "States Covered" KPI reflects the states the facilities span.

**Type caveat:** the server always emits `syncing`, but the client interfaces in `client/src/pages/desert/types.ts` (`StateGapsResponse`, `HeatmapPointsResponse`, `CapabilitySummaryResponse`) declare it **optional** (`syncing?: boolean`). A consumer relying on the TS type should not assume the field is guaranteed present; either align the types to required `syncing: boolean` or document the intentional optionality.

### 7.7 `syncing` Is Load-Bearing in the Client (Not "Informational")

Although the server currently hardcodes `syncing: false` on every response, the client **gates rendering on it** — it is not purely informational:

- `FacilitiesPage` suppresses populating the state-filter dropdown when `syncing` is truthy (search for `!d.syncing && d.states` in `FacilitiesPage.tsx`). If `syncing` ever flips `true`, the states filter silently goes empty.
- `DesertPage` replaces the heatmap with a blocking amber banner ("Data syncing… map will appear once the sync is complete") whenever `state-gaps` or `heatmap-points` report `syncing: true` (search for `Data syncing` in `DesertPage.tsx`).

Any future change that emits `syncing: true` (e.g. when wiring Lakebase synced-table status) will hide the states dropdown and the desert map. The intended `true`-state UX should be designed and documented before that flip is made.

### 7.8 Pagination Over-Range Behavior (`/api/facilities`)

`page` is floored to ≥1 via `Math.max(1, parseInt(...))`, but is **not** clamped to `totalPages`. The last real page is computed from 10,088 / 50 = 201.76 → **202 pages** (page 202 → `OFFSET 10050`, returning the final 38 rows). Requesting a page beyond the last (e.g. `page=5000`) issues a large `OFFSET` (e.g. 250000), returns `facilities: []` with **HTTP 200**, and still reports the true `total`/`totalPages`. The client's "Next" button is disabled only by comparing the current `page` to `data.totalPages`; there is no server-side over-range signal. Callers hitting the API directly must compare `page` to `totalPages` themselves.

---

## 8. Scalability Considerations

### 8.1 SQL Warehouse

The SQL Warehouse (`5b2b29cce22aa2c4`) is shared across all app queries. Under hackathon demo load (low concurrency), this is unlikely to be a bottleneck. In a production scenario:

- The warehouse should be configured with auto-scale to handle concurrent analytical requests.
- The desert endpoints' 5-minute in-memory cache reduces warehouse calls for the most expensive queries, but the cache is not shared across multiple app instances and is not persistent across restarts.
- A distributed cache (e.g., Redis or Databricks-managed caching) would be required for multi-instance deployments.

### 8.2 Lakebase Postgres (Future)

Should the OLTP path be implemented (§6.2 — which first requires loading the `lakebase` plugin), Lakebase Postgres is well-suited to paginated access. Scalability would then depend on:

- Index coverage on filter columns (`address_stateorregion`, `name`, `address_city`).
- Lakebase project tier (instance size, connection pool limits) — not documented in the project context and assumed to be platform defaults.

The TRIGGERED sync mode means Lakebase data lags the Delta source by up to one trigger interval. For mostly read-only display data this is acceptable; real-time consistency would require CONTINUOUS mode. (Until the app actually reads Lakebase, this lag has no user-facing effect.)

### 8.3 CDF Pipeline Quota

The workspace enforces a limit of 1 concurrent `DATABASE_TABLE_SYNC` pipeline, so synced tables must be created sequentially. For the current three tables this is a minor operational constraint; at scale, many synced tables would need quota increases or batched creation planning.

### 8.4 Data Volumes

| Table | Row Count | Scale Assessment |
|-------|-----------|-----------------|
| `facilities` | 10,088 | Small; SQL Warehouse scans are sub-second |
| `nfhs_5_district_health_indicators` | 706 | Trivial; returned unpaginated (§6.4) |
| `india_post_pincode_directory` | 165,627 | Moderate; full scans acceptable for analytics |

At current volumes, no partitioning or Z-ordering is required. If the facility registry grows by an order of magnitude, partitioning `facilities` by `address_stateorregion` and Z-ordering on `latitude`/`longitude` would accelerate geographic queries.

---

## 9. Security Model

### 9.1 Service Principal Authentication

The application runs under service principal `5ccf106a-7211-489d-a075-5ca82e07b0ae`. Databricks Apps injects OAuth credentials for this SP into the app container at runtime. The AppKit server plugin consumes these credentials transparently to authenticate outbound calls to:

- The SQL Warehouse (for `appkit.analytics.query()` calls — the **only** data path in use).
- The Lakebase Postgres endpoint (via Databricks-managed credential injection) — **not exercised**, since the Lakebase plugin is not loaded and no route calls it (§1.1).

SP credentials are never exposed in application source code, environment files, or client-side bundles.

### 9.2 AppKit Authentication

AppKit provides an authentication layer that:

1. Requires users to authenticate via Databricks OAuth before accessing the app.
2. Passes the authenticated user's identity to the Express backend via request context, allowing per-user authorization checks if needed.
3. Issues short-lived OAuth tokens for the session; token refresh is handled by the AppKit runtime.

The frontend SPA receives the authenticated user context through AppKit's React hooks, enabling the UI to display user identity and scope UI elements by role if required in future tracks.

### 9.3 OAuth Token Generation

Token generation follows the Databricks OAuth 2.0 M2M (machine-to-machine) flow for the app SP:

- The Databricks Apps platform acts as the token issuer.
- Tokens are scoped to the resources the SP has been granted access to in Unity Catalog and the SQL Warehouse.
- Token lifetimes and rotation are managed by the platform; the application does not implement token storage or rotation logic.

### 9.4 Unity Catalog Permissions

Data access is governed by Unity Catalog. The app SP must hold at minimum:

- `USE CATALOG` on `dais27hack`
- `USE SCHEMA` on `dais27hack.virtue_foundation_dataset_silver`
- `SELECT` on all source and live tables in that schema
- `CAN USE` on SQL Warehouse `5b2b29cce22aa2c4`
- `USE CATALOG` on `` `virtue-pg` `` (for future Lakebase reads)

Write permissions to `_live` tables are required for any track that performs application-layer updates.

### 9.5 Known Security Issues

**SQL Injection — partially mitigated, not parameterized.** The server routes construct SQL by string interpolation, but every user-supplied value (`search`, `state`, `capability`) is first passed through single-quote escaping `.replace(/'/g, "''")` before interpolation (e.g. `address_stateorregion = '${state.replace(/'/g, "''")}'`; search the routes file for `.replace(/'/g, "''")` to find every site). This mitigates basic quote-breakout injection. It is **not** equivalent to parameterized/bound queries — it relies on the developer remembering to escape on every new interpolation site, does not defend against every edge case, and is easy to omit when adding routes.

**Recommendation:** Migrate to bound parameters via the analytics/Postgres client. Until then, audit every interpolation site for the escape, and add a lint/test that asserts user values are escaped (not "passed through raw").

---

## 10. Known Limitations and Open Issues

> **Canonical Known-Issues list:** `project-overview.md §10`. The table below is the architecture-scoped view; when a bug is fixed, update the canonical list first, then reconcile here. Cross-references like "Known Issues #5/#6" point to that canonical list's numbering (not any local numbering in `data-model.md`, which uses a different scheme).

**Status legend** (one value per row): **OPEN** = needs work, no decision yet; **ACCEPTED** = known and intentionally not fixing now (rationale documented); **BLOCKED** = needs an external/upstream fix; **RESOLVED** = fixed.

| Issue | Detail | Status | Impact |
|-------|--------|--------|--------|
| API returns `facility_id`, not `unique_id` | `Facility`/`HeatmapPoint` project numeric `facility_id`; no API field named `unique_id` (server queries + `types.ts`/`FacilitiesPage.tsx`) | OPEN (docs/tests to reconcile) | Consumers coding against `unique_id: string` break; physical-column name is a separate `data-model.md` verification task (§7.6) |
| Null bytes still on the read path | `0x00` stripped in `facilities_live` only; the API reads the **plain** `facilities` table, which still contains them | OPEN (partially resolved) | Facility `name`/`description` responses can carry null bytes; do not mark "RESOLVED" while the read path is the plain table (§3.5) |
| Lakebase entirely unwired | `lakebase` plugin not in `createApp` plugins; `setupSampleLakebaseRoutes` never called; `LakebasePage` not routed | ACCEPTED (Track 2 doesn't need it) | `appkit.lakebase` unavailable at runtime; `/api/lakebase/todos` and `/lakebase` do not exist; sample todo route is orphaned dead code |
| `syncing` is load-bearing in client | Server hardcodes `false`, but `FacilitiesPage` gates the state dropdown and `DesertPage` shows a blocking banner on `syncing: true` | OPEN | Flipping `syncing` to `true` silently hides the states filter and the desert map; intended `true`-state UX is undocumented |
| State-name join mismatch (Track 2) — Known Issues #5 | `state-gaps` joins facilities (`address_stateorregion`) to NFHS (`state_ut`) on `LOWER(TRIM(...))` only; same mismatch affects Overview-KPI vs Facilities-filter state universes (§7.6) | OPEN (highest priority) | Variant names ("NCT of Delhi" vs "Delhi") fail to match → unmatched FULL-OUTER rows, default-50 demand, distorted/null gap scores. Crosswalk fix sketched in §7.3 |
| Possible negative `trust_weight` — Known Issues #6 | `SIZE(SPLIT(NULL,','))` = -1 in Spark; `COALESCE(...,1)` does not fire for NULL `source_types` → `LEAST(-1/3, 1) = -0.333` | OPEN (pending §10.1 verification) | NULL `source_types` may yield negative weights. Canonical fix in §7.1; semantics decision required |
| Capability filter ↔ summary asymmetry | Summary groups on raw `capability`; heatmap/state-gaps filter with `ILIKE '%value%'` | OPEN | Selecting a composite bucket can return fewer facilities than its `facility_count`; selecting a single term also matches composites (§7.5) |
| `/api/districts` unpaginated | No `LIMIT`/`OFFSET`; returns full filtered set (up to all 706 rows), all rendered into the DOM | ACCEPTED (fine at 706 rows) | Large single payload, no paging (§6.4) |
| `/api/facilities` over-range page | `page` floored to ≥1 but not clamped to `totalPages`; large page ⇒ empty list, HTTP 200, no signal | ACCEPTED | Direct API callers can silently overrun the last page (§7.8) |
| `facilities` duplicate `unique_id` | Source table has non-unique values in the upstream `unique_id` PK column | BLOCKED (upstream fix) | Blocks creation of `facilities_live` as a Lakebase synced table |
| Lakebase quota (1 concurrent pipeline) | Workspace `DATABASE_TABLE_SYNC` quota allows only 1 concurrent synced-table pipeline | BLOCKED (workspace quota) | `facilities_live` and `india_post_..._live` synced tables cannot be created until `nfhs_5` finishes and quota is released |
| In-memory desert cache | Desert API responses cached in a server-side `Map`, keyed `heatmap-points:<cap>` / `state-gaps:<cap>` / `capability-summary` | ACCEPTED (hackathon scale) | Lost on restart; not shared across instances; no eviction beyond the 5-minute TTL |
| Heatmap bounding-box exclusion | Heatmap filters to lat 6–37.5, lon 68–97.5; out-of-box facilities dropped | ACCEPTED (India scope by design) | Facilities with valid-but-out-of-box coordinates never appear; "shows all facility locations" is not strictly true (§7.4) |
| `india_post` lat/lon as STRING | `india_post_pincode_directory.latitude`/`.longitude` are `STRING`, not `DOUBLE` | ACCEPTED (cast in queries) | All geographic queries on this table require explicit `CAST` (§6.3) |
| `facilities` lat/lon cast unverified | Heatmap casts `facilities.latitude` to DOUBLE despite the column being documented as DOUBLE | OPEN (see §10.1) | Either a redundant cast (if DOUBLE) or the type docs are wrong (if not) |
| `syncing?` optional in client types | `types.ts` declares `syncing?: boolean` though server always emits it | OPEN | TS consumers should not assume presence; align type or document optionality (§7.6) |
| SQL injection (residual) | `search`/`state`/`capability` are quote-escaped but interpolated, not parameterized | OPEN | Lower risk than "unmitigated"; migrate to bound parameters before non-hackathon use (§9.5) |
| `.env.example` is placeholders | Ships `your_postgres_host` / `https://...`, not real values | ACCEPTED | Copying to `.env` yields placeholders; real host/endpoint via the branch→endpoint flow in §5.6; values unused until Lakebase plugin is loaded |
| `npm run start` needs a prior build | `start` runs pre-built `dist/server.js` and does no build; errors if `dist/` absent | ACCEPTED (documented) | Local dev must use `npm run dev`; production flow is `npm run build` → `npm run start` (§5.3) |
| Tracks 1, 3, 4 not implemented | Facility Trust Desk, Referral Copilot, Data Readiness Desk have no backend or frontend | ACCEPTED (out of scope) | Hackathon submission covers Track 2 only |
| Lakebase project recreation | The `virtue-health` Lakebase project was deleted and recreated during development | RESOLVED (historical note) | Original-project data/config is gone; `nfhs_5` is confirmed ONLINE in the recreated project |
| Lakebase connection details | Postgres username/password/pool config used by the Express server is not documented; `.env.example` uses `PGHOST/PGPORT/PGDATABASE/PGSSLMODE/LAKEBASE_ENDPOINT` placeholders | OPEN | Connection-management details unknown from available docs; moot until the Lakebase plugin is loaded |

### 10.1 Open Verification Tasks

These two questions are empirically answerable in seconds against warehouse `5b2b29cce22aa2c4`. They are tracked as **tasks**, not permanent prose. When resolved, record the result here and delete the conditional hedging wherever it appears (§6.3, §7.1).

| # | Task | Query | Expected / record result | Owner | Opened |
|---|------|-------|--------------------------|-------|--------|
| V1 | Verify `facilities.latitude` / `.longitude` column type | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | Confirm `DOUBLE` vs `STRING`. If `DOUBLE`, the heatmap cast (§6.3) is redundant; if `STRING`, the data-model docs are wrong. Result: `____` | TBD | 2026-06-15 |
| V2 | Verify `SIZE(SPLIT(NULL, ','))` behavior on this warehouse | `SELECT SIZE(SPLIT(NULLIF(TRIM(CAST(NULL AS STRING)), ''), ','));` | Confirm returns `-1` (Spark default). If so, NULL `source_types` yields trust_weight `-0.333` (Known Issues #6); apply the §7.1 fix. Result: `____` | TBD | 2026-06-15 |
| V3 | Confirm the physical PK column name on `facilities` | `DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;` | API response field is already confirmed `facility_id: number` (client interfaces). Open item: is the *physical column* named `facility_id` or `unique_id`? Record: `____`. (Owned by `data-model.md`; mirrored here for the §7.6 note.) | TBD | 2026-06-15 |
