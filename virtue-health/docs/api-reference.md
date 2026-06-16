All facts confirmed. Now I'll produce the rewritten document with the three relevant fixes applied (Finding 1: `unique_id` → `facility_id`; Finding 3: Track 4 / `facilities_live` divergence cross-ref; Finding 9/10: null-byte status), preserving everything correct.

# Virtue Health — Backend API Reference

**Base URL:** Databricks App deployment at `https://dbc-0a01f518-764a.cloud.databricks.com` (deployed app name: `virtue-health`)
**SQL Warehouse:** `5b2b29cce22aa2c4`
**All endpoints:** HTTP/1.1, JSON responses, UTF-8 encoding

> **Naming conventions used in this doc.** `virtue-health` is, depending on context, the **bundle** name, the **deployed app name** (used in `databricks apps <cmd> virtue-health`), and the value of the app's `name` field; the DABs app **resource key** in `databricks.yml` (referenced via `${resources.apps.app...}`) is `app`. This document only uses the *deployed app name* sense. See `deployment.md` for the full convention. **NFHS-5** = National Family Health Survey, Round 5.

> **Example values are illustrative.** All example response bodies below use **illustrative** values for shape demonstration only. They are not drawn from the live dataset and are not guaranteed to match live data or each other (e.g., a `statesCovered` count in one example need not reconcile with the length of a `states` array in another).

> **Data source:** All endpoints below read from the Databricks SQL Warehouse via `appkit.analytics.query()` against the `dais27hack.virtue_foundation_dataset_silver` schema. **No endpoint reads from Lakebase Postgres.** The `lakebase` plugin is **not registered** in `server/server.ts` — `createApp` loads only the `analytics` and `server` plugins (verified: see the `plugins: [analytics({}), server()]` array), so `appkit.lakebase` does not exist at runtime. The scaffold `server/routes/lakebase/todo-routes.ts` exports `setupSampleLakebaseRoutes`, but it is **never imported or called** (`onPluginsReady` only calls `setupVirtueHealthRoutes`), and the matching `client/src/pages/lakebase/LakebasePage.tsx` is **not** added to the router — there is no `/lakebase` route. These are orphaned scaffold files; `/api/lakebase/todos` is not served at all. To make any Lakebase route functional you must (a) add the `lakebase` plugin to `createApp`, (b) call `setupSampleLakebaseRoutes(appkit)` in `onPluginsReady`, and (c) register the route/nav entry.

> **Read path reads the *plain* `facilities` table, not `facilities_live`.** Every facilities-touching endpoint below queries `dais27hack.virtue_foundation_dataset_silver.facilities` (verified: `FROM ${SRC}.facilities` at the summary, list, heatmap, state-gaps, and capability-summary handlers). It does **not** read `facilities_live`. This matters for data quality: the null-byte remediation was applied only to `facilities_live`, so the plain `facilities` table on the read path may still contain null bytes — see **Known Issues → Null bytes still present on the read path**. (If a future Track 4 implementation profiles `facilities_live` per `project-overview.md §8`, note the deliberate divergence: counts will differ from what these endpoints return.)

> **Response key is `facility_id` (numeric), not `unique_id`:** The facilities and heatmap endpoints project a **`facility_id: number`** field, confirmed in both the server SQL (`facility_id, name, organization_type, ...` and the heatmap `facility_id,` select) and the authoritative client interfaces (`client/src/pages/facilities/FacilitiesPage.tsx` → `facility_id: number;`, `client/src/pages/desert/types.ts` → `facility_id: number;`). The underlying physical PK column is documented **upstream** as `unique_id` (a string with known duplicate values), but **the API does not project `unique_id`** — it returns the numeric `facility_id`. Do not code clients against a `unique_id: string` field; it is not in any response. (Whether the physical column is *also* named `facility_id` is a data-model question tracked in `data-model.md`; for API-response purposes the client interfaces are authoritative: the field is `facility_id: number`.)

> **Common response field — `syncing` is client-gated, not informational:** Every endpoint includes a `syncing: boolean`, currently hardcoded `false` server-side. It is **not** purely informational — the client gates behavior on it:
> - The Facilities page suppresses the state-filter dropdown when `syncing` is truthy (in `FacilitiesPage.tsx`, the effect that calls `setStates` is guarded by `!d.syncing` — search for `!d.syncing && d.states`).
> - The Desert page replaces the heatmap/choropleth with a blocking "Data syncing… map will appear once the sync is complete" banner when `state-gaps` or `heatmap-points` report `syncing: true` (in `DesertPage.tsx`).
>
> Any future change that emits `syncing: true` will silently hide the states dropdown and the desert map. Document the intended `true`-state UX before wiring it. **Type note:** the client interfaces in `client/src/pages/desert/types.ts` mark this field **optional** (`syncing?: boolean`) even though the server always emits it — a contract mismatch worth aligning (make it required, or document the intentional optionality).

> **Code references in this doc use stable anchors, not line numbers.** Where this doc points at server or client code, it names the handler/identifier and quotes a short snippet to search for, rather than citing absolute line numbers (which rot on the next edit). Server route handlers live in `server/routes/virtue-health-routes.ts`.

---

## Known Issues

This section is the in-document reference for the API-level caveats. Several of these (negative `trust_weight`, the state-name join risk, the Lakebase-not-wired fact, `syncing` client-gating, the capability filter/summary asymmetry, null bytes on the read path) are project-wide and have a canonical write-up in `project-overview.md` Known Issues; the entries below are the API-specific summaries plus the concrete fixes relevant to these endpoints.

> **SQL Injection — quote-escaped, not parameterized (HIGH):** Endpoints that accept `search`, `state`, and `capability` query parameters interpolate user-supplied values into SQL strings. The values are **single-quote escaped** (`value.replace(/'/g, "''")`) before interpolation — this is a real mitigation against basic quote-breakout injection, but it is **not** equivalent to parameterized/bound queries. It does not defend against all edge cases, is easy to forget on new routes, and offers weaker guarantees than bound parameters. Affects `/api/facilities` (`search`, `state`), `/api/districts` (`state`), `/api/desert/heatmap-points` (`capability`), and `/api/desert/state-gaps` (`capability`). The `/api/facilities/states` and `/api/districts/states` endpoints accept no parameters and interpolate nothing. **Recommendation:** migrate to parameterized/bound queries.

> **Null bytes still present on the read path (OPEN — not "resolved"):** The null-byte (`0x00`) cleanup of `facilities.name` and `facilities.description` was applied to the **`facilities_live`** table only. The production API reads the **plain `facilities`** table (see the intro "Read path" note), so API responses for `name` (and any future endpoint that returns `description`) **can still contain null bytes**. This is **partially resolved at the data layer** (fixed in `_live`) but **OPEN on the read path** the API actually uses. Do not treat the null-byte issue as fully resolved for API consumers. Canonical entry: `project-overview.md` Known Issues; cross-referenced by `data-pipeline.md` and `data-model.md`.

> **State-name join mismatch (Track 2 correctness risk — the single biggest correctness risk in Track 2):** `/api/desert/state-gaps` joins facilities to NFHS-5 demand via a `FULL OUTER JOIN` on a normalized `LOWER(TRIM(state))` key, matching `facilities.address_stateorregion` against `nfhs_5_district_health_indicators.state_ut`. When these two sources spell a state differently (e.g., `"NCT of Delhi"` vs `"Delhi"`, abbreviations, or punctuation differences), rows fail to match: facility-only states get `demand_index = NULL` (falls back to `50` in the gap numerator), and NFHS-only states get `facility_count = 0` (floored supply). This can produce inflated, deflated, or default gap scores for affected states. See endpoint §7.
>
> **Example remediation — normalize both sides with a crosswalk before joining.** First enumerate the *actual* mismatches in this dataset (an `EXCEPT` diagnostic that diffs the distinct normalized state keys on each side; see `runbook.md`), then populate a crosswalk `CASE`:
>
> ```sql
> -- minimal crosswalk; EXTEND after running the EXCEPT diagnostic — values below are ILLUSTRATIVE and must be verified
> CASE LOWER(TRIM(state))
>   WHEN 'nct of delhi' THEN 'delhi'
>   WHEN 'orissa'       THEN 'odisha'
>   WHEN 'pondicherry'  THEN 'puducherry'
>   ELSE LOWER(TRIM(state))
> END AS state_key
> ```

> **Capability filter/summary asymmetry (Track 2 UX trap):** `/api/desert/capability-summary` groups on the **raw, un-split** capability string, so composites like `"Emergency,Surgery,ICU"` are their own bucket and become a dropdown option. But `/api/desert/heatmap-points` and `/api/desert/state-gaps` filter via `capability ILIKE '%value%'`. Selecting a composite option filters on that exact comma-joined substring (matching fewer facilities than the summary's `facility_count` for that bucket), while selecting `"Emergency"` also matches every composite containing it. Grouping is exact-string; filtering is substring — they are **not** symmetric. See §6/§7/§8. Fix by normalizing (split on comma) on both sides, or document the asymmetry for consumers.

> **Trust-weight NULL edge case — possible negative `trust_weight`:** A NULL/empty `source_types` value can yield a **negative** trust weight (`-0.333`) instead of the intended fallback, because Spark's `SIZE(SPLIT(NULL, ','))` returns `-1` (non-null), so the `COALESCE(..., 1)` fallback never fires. See the full caveat and the recommended fix under §6 "Trust Weight Formula." This is listed in **Open Verification Tasks** below pending a check on the target warehouse.

### Open Verification Tasks

These two questions are empirically answerable in seconds against warehouse `5b2b29cce22aa2c4`. They are tracked as open tasks rather than hedged inline throughout the doc; once resolved, delete the conditional language at the call sites.

> **OPEN — verify `facilities.latitude` / `longitude` column type (owner: TBD, opened 2026-06-15).**
> ```sql
> DESCRIBE dais27hack.virtue_foundation_dataset_silver.facilities;
> ```
> Expected: confirm whether `latitude`/`longitude` are `DOUBLE` or `STRING`. Record result here: `____`.
> Impact: the heatmap query applies `CAST(latitude AS DOUBLE)` / `CAST(longitude AS DOUBLE)`. If the columns are already `DOUBLE` the cast is defensive/redundant; if `STRING`, the cast is required and data-model docs and schema tests must reflect STRING. (Note: the sibling `india_post_pincode_directory` table's lat/lon **are** STRING — do not assume the same for `facilities` without running the check.)

> **OPEN — verify Spark `SIZE(SPLIT(NULL, ','))` behavior on the target warehouse (owner: TBD, opened 2026-06-15).**
> ```sql
> SELECT SIZE(SPLIT(CAST(NULL AS STRING), ','));   -- expect -1 in Spark SQL
> ```
> Expected: confirm it returns `-1` (which is what drives the negative-`trust_weight` edge case below). Record result here: `____`. On resolution, apply the recommended trust-weight fix (see §6) and remove the conditional hedging.

---

## Caching Summary

| Endpoint | Cached | TTL | Cache Key |
|---|---|---|---|
| `GET /api/summary` | No | — | — |
| `GET /api/facilities` | No | — | — |
| `GET /api/facilities/states` | No | — | — |
| `GET /api/districts` | No | — | — |
| `GET /api/districts/states` | No | — | — |
| `GET /api/desert/heatmap-points` | Yes | 5 minutes | `heatmap-points:<capability>` |
| `GET /api/desert/state-gaps` | Yes | 5 minutes | `state-gaps:<capability>` |
| `GET /api/desert/capability-summary` | Yes | 5 minutes | `capability-summary` (fixed) |

Cache implementation: a single in-memory `Map` on the Express.js process, shared by all three cached endpoints. Keys are **prefixed** (`heatmap-points:`, `state-gaps:`, plus the fixed `capability-summary`) so the same `capability` value never collides across endpoints. The empty string (`""`, when `capability` is omitted) is a valid key suffix. Cache does not persist across app restarts or redeploys and is not shared across app instances.

---

## Endpoints

---

### 1. GET /api/summary

Returns aggregate KPI counts used by the Overview page (`/`).

#### Request

```bash
curl https://<app-host>/api/summary
```

No query parameters.

#### Response Shape

```typescript
interface SummaryResponse {
  totalFacilities: number;    // COUNT(*) from facilities (the plain table, not facilities_live)
  statesCovered: number;      // COUNT(DISTINCT state_ut) from nfhs_5_district_health_indicators
  districtsCovered: number;   // COUNT(DISTINCT district_name) from nfhs_5_district_health_indicators
  avgSexRatio: number | null; // ROUND(AVG(sex_ratio_total_f_per_1000_m), 1); null if AVG is null
  syncing: boolean;           // always false (server-side); but client-gated — see "Common response field"
}
```

> **Note on `totalFacilities`:** This is `COUNT(*)` from the **plain `facilities`** table (`FROM ${SRC}.facilities`), not `facilities_live`. Because the plain table retains duplicate `unique_id` rows and null bytes, this count reflects the un-remediated table — see the intro "Read path" note.

> **Note on `statesCovered`:** This is the count of distinct `state_ut` from the **NFHS-5** table, not from `facilities`. It is a *different* state universe from the `address_stateorregion` values returned by `/api/facilities/states`; the two need not match (see the state-name mismatch in Known Issues).

> **Note on `districtsCovered`:** This is `COUNT(DISTINCT district_name)` from NFHS-5. Because NFHS-5 uses a **composite PK** (`district_name` + `state_ut`) and district names can repeat across states, the count of distinct `district_name` is generally **less than the 706 total NFHS-5 rows**. Do not assume `districtsCovered === 706`.

> **Note on `avgSexRatio`:** The value is `number | null`. The server sets it to `null` when the underlying `AVG(sex_ratio_total_f_per_1000_m)` is null. Clients must handle the null case (see the second example below).

#### Example Response

```json
{
  "totalFacilities": 10088,
  "statesCovered": 28,
  "districtsCovered": 640,
  "avgSexRatio": 943.7,
  "syncing": false
}
```

When the underlying average is null, `avgSexRatio` is `null`:

```json
{
  "totalFacilities": 10088,
  "statesCovered": 28,
  "districtsCovered": 640,
  "avgSexRatio": null,
  "syncing": false
}
```

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure or connectivity issue | `{ "error": "Failed to load summary" }` |

---

### 2. GET /api/facilities

Returns a paginated, searchable list of healthcare facilities. Used by the Facilities page (`/facilities`).

#### Request

```bash
curl "https://<app-host>/api/facilities?search=apollo&state=Maharashtra&page=1"
```

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `search` | `string` | No | `""` | Filters facilities where `name ILIKE '%search%' OR address_city ILIKE '%search%'` (case-insensitive substring match). Single-quote escaped before interpolation — **see Known Issues.** |
| `state` | `string` | No | `""` | Filters facilities by `address_stateorregion = '<state>'` (exact match). Single-quote escaped before interpolation — **see Known Issues.** |
| `page` | `integer` | No | `1` | 1-based page number, parsed via `parseInt` and floored to a minimum of `1` (`Math.max(1, ...)`). Each page returns 50 records. A non-numeric value parses to `NaN`, which `Math.max(1, NaN)` resolves to `1`. **Not clamped to `totalPages` — see over-range note below.** |

Results are ordered `ORDER BY name ASC`.

> **Over-range pages return empty with HTTP 200 (no error signal):** `page` is floored to ≥1 but is **not** clamped to `totalPages`. Requesting a page beyond the last (e.g. `page=5000` against 10,088 facilities issues `OFFSET 250000`) returns `facilities: []` with **HTTP 200**, while still reporting the true `total`/`totalPages`. The server emits no over-range indication; callers hitting the API directly must compare `page` to `totalPages` themselves. (The web client disables its "Next" button by comparing to `totalPages`, so it does not over-run in normal use.)

#### Response Shape

```typescript
interface FacilitiesResponse {
  facilities: Facility[];
  total: number;       // Total matching row count (for pagination)
  page: number;        // Current page number (1-based)
  pageSize: number;    // Always 50
  totalPages: number;  // Math.ceil(total / pageSize)
  syncing: boolean;    // always false (server-side); client gates the states dropdown on it — see "Common response field"
}

interface Facility {
  facility_id: number;                     // API response key (numeric). The API projects facility_id, NOT unique_id — see intro note. (Upstream physical PK unique_id is a string with duplicate values, but it is not returned here.)
  name: string;                            // may contain null bytes (0x00) — read path is the plain facilities table; see Known Issues
  organization_type: string | null;
  address_city: string | null;
  address_stateorregion: string | null;
  address_country: string | null;
}
```

> **Important:** The SELECT returns **only** the six columns above (`facility_id, name, organization_type, address_city, address_stateorregion, address_country`). Columns such as `capability`, `specialties`, `equipment`, `procedure`, `source_types`, `source_ids`, `latitude`, `longitude`, `description`, `cluster_id`, and `source_urls` exist in the underlying `facilities` table but are **not** returned by this endpoint. (Trust-related columns like `source_types` and coordinate columns are consumed by the desert endpoints, not by `/api/facilities`.)

#### Example Response

```json
{
  "facilities": [
    {
      "facility_id": 42,
      "name": "Apollo Hospital Chennai",
      "organization_type": "Private",
      "address_city": "Chennai",
      "address_stateorregion": "Tamil Nadu",
      "address_country": "India"
    }
  ],
  "total": 312,
  "page": 1,
  "pageSize": 50,
  "totalPages": 7,
  "syncing": false
}
```

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load facilities" }` |

> There is no `400` path. Invalid `page` values are coerced (`NaN`/`<1` → `1`); over-range values return an empty list (HTTP 200). Neither produces a `400`.

---

### 3. GET /api/facilities/states

Returns the list of distinct, non-empty state values present in the facilities table. Used to populate the state filter dropdown on the Facilities page.

> **Client behavior:** `FacilitiesPage.tsx` only populates the dropdown when `syncing` is falsy (search for `!d.syncing && d.states`). With the current always-`false` value this is a no-op, but if a future change emits `syncing: true` here, the state filter silently stays empty. See "Common response field."

#### Request

```bash
curl "https://<app-host>/api/facilities/states"
```

No query parameters.

#### Response Shape

```typescript
interface FacilitiesStatesResponse {
  states: string[];   // Distinct address_stateorregion, non-null and non-empty, sorted ASC
  syncing: boolean;   // always false (server-side); client suppresses dropdown if truthy
}
```

The response is an **object** with a `states` array, not a bare array. Values are filtered (`IS NOT NULL AND <> ''`) and sorted `ORDER BY address_stateorregion ASC`.

> **Note:** These are `address_stateorregion` values from **facilities** — a different state universe from the NFHS-5 `state_ut` count behind `summary.statesCovered`. They need not agree (see state-name mismatch in Known Issues).

#### Example Response

```json
{
  "states": [
    "Andhra Pradesh",
    "Assam",
    "Bihar",
    "Delhi",
    "Gujarat",
    "Karnataka",
    "Kerala",
    "Maharashtra",
    "Tamil Nadu",
    "Uttar Pradesh"
  ],
  "syncing": false
}
```

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load states" }` |

---

### 4. GET /api/districts

Returns NFHS-5 (National Family Health Survey, Round 5) district health indicator records, optionally filtered by state. Used by the Districts page (`/districts`).

#### Request

```bash
curl "https://<app-host>/api/districts?state=Kerala"
```

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `state` | `string` | No | `""` | Filters records by `state_ut = '<state>'` (exact match). Single-quote escaped before interpolation — **see Known Issues.** |

Results are ordered `ORDER BY state_ut ASC, district_name ASC`.

> **No pagination.** This endpoint applies no `LIMIT`/`OFFSET`; it returns the **entire** filtered result set in a single response (up to all 706 NFHS rows when unfiltered). The Districts page renders every returned row (no client-side paging either). Acceptable at 706 rows, but the full set is loaded into the payload and the DOM on each request — a scaling note if this table grows.

#### Response Shape

```typescript
interface DistrictsResponse {
  districts: DistrictIndicator[];
  syncing: boolean;   // always false (server-side)
}

interface DistrictIndicator {
  district_name: string;                              // Part of composite PK with state_ut
  state_ut: string;                                   // State or Union Territory name
  households_surveyed: number | null;
  hh_electricity_pct: number | null;
  hh_improved_water_pct: number | null;
  hh_use_improved_sanitation_pct: number | null;
  child_u5_whose_birth_was_civil_reg_pct: number | null;
}
```

> **Important:** Although the `nfhs_5_district_health_indicators` table has ~100 indicator columns, this endpoint returns **only the seven columns listed above**. Immunization, maternal-health, anemia, and blood-pressure columns are **not** returned by this endpoint. The response is an **object** with a `districts` array, not a bare array.

#### Example Response

```json
{
  "districts": [
    {
      "district_name": "Thiruvananthapuram",
      "state_ut": "Kerala",
      "households_surveyed": 28456,
      "hh_electricity_pct": 99.2,
      "hh_improved_water_pct": 95.1,
      "hh_use_improved_sanitation_pct": 97.8,
      "child_u5_whose_birth_was_civil_reg_pct": 98.5
    }
  ],
  "syncing": false
}
```

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load districts" }` |

---

### 5. GET /api/districts/states

Returns the list of distinct `state_ut` values present in the NFHS-5 district indicators table. Used to populate the state filter dropdown on the Districts page.

#### Request

```bash
curl "https://<app-host>/api/districts/states"
```

No query parameters.

#### Response Shape

```typescript
interface DistrictsStatesResponse {
  states: string[];   // Distinct state_ut, non-null, sorted ASC
  syncing: boolean;   // always false (server-side)
}
```

The response is an **object** with a `states` array, not a bare array. Values are filtered (`state_ut IS NOT NULL`) and sorted `ORDER BY state_ut ASC`.

#### Example Response

```json
{
  "states": [
    "Andaman & Nicobar Islands",
    "Andhra Pradesh",
    "Arunachal Pradesh",
    "Assam",
    "Bihar",
    "Chandigarh",
    "Goa",
    "Gujarat",
    "Kerala",
    "Lakshadweep",
    "Maharashtra"
  ],
  "syncing": false
}
```

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load district states" }` |

---

### 6. GET /api/desert/heatmap-points

Returns latitude, longitude, computed trust weight, and identifying fields for each in-bounds facility, optionally filtered by capability. Used to render the heatmap layer on the Desert Planner page (`/desert`).

**Cached:** Yes — 5-minute in-memory cache keyed on `heatmap-points:<capability>`.

> **Client behavior:** `DesertPage.tsx` replaces the map with a blocking "Data syncing…" banner when this endpoint (or `state-gaps`) reports `syncing: true`. Currently always `false`. See "Common response field."

#### Trust Weight Formula

```sql
LEAST(
  COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0,
  1.0
)
```

Trust weight is intended to represent the proportion of up to 3 distinct source types corroborating a facility's existence, capped at 1.0. A facility with 3+ source types receives 1.0.

> **Formula caveat — NULL `source_types` can yield a negative weight (verification tracked):** In Spark SQL, `SIZE(SPLIT(NULL, ','))` returns **-1**, not NULL. Since `-1` is non-null, the `COALESCE(..., 1)` fallback does **not** fire for a NULL/empty `source_types` value, and the expression evaluates to `LEAST(-1 / 3.0, 1.0) = -0.333` — a **negative** trust weight. The `NULLIF(TRIM(source_types), '')` collapses empty/whitespace strings to NULL, which feeds straight into this edge case. This behavior is tracked under **Known Issues → Open Verification Tasks** (run the one-line `SELECT SIZE(SPLIT(CAST(NULL AS STRING), ','))` check on warehouse `5b2b29cce22aa2c4`).
>
> **Recommended fix (NULL `source_types` → intended `0.333`):**
> ```sql
> LEAST(COALESCE(NULLIF(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), -1), 1) / 3.0, 1.0)
> ```
> Do **not** instead clamp with `GREATEST(..., 0.0)` unless you intend NULL `source_types` to score **0**, not `0.333` — the two fixes have **different semantics**. The `NULLIF(..., -1)` form maps an empty/NULL `source_types` to the intended one-source fallback (`1/3 = 0.333`); a `GREATEST(..., 0.0)` clamp would instead leave a genuine empty-source facility at `0`. Decide which semantics you want and document it before applying.

#### Coordinate Filtering

Points are filtered server-side to:
- `latitude IS NOT NULL AND longitude IS NOT NULL`, **and**
- India's bounding box: `CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5` and `CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5`.

Facilities with null or out-of-box coordinates are **silently excluded**. The latitude/longitude are emitted via `CAST(... AS DOUBLE)`. (To locate this filter in the handler, search for `BETWEEN 6.0 AND 37.5`.)

> Whether the `CAST(... AS DOUBLE)` on `facilities.latitude`/`longitude` is required or merely defensive depends on the column's actual type — tracked under **Known Issues → Open Verification Tasks** (`DESCRIBE ...facilities`).

#### Request

```bash
curl "https://<app-host>/api/desert/heatmap-points?capability=Emergency"
```

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `capability` | `string` | No | `""` | When non-empty, adds `AND capability ILIKE '%<capability>%'`. Single-quote escaped before interpolation — **see Known Issues.** Substring match — see the capability filter/summary asymmetry note in Known Issues. |

#### Response Shape

```typescript
interface HeatmapPointsResponse {
  points: HeatmapPoint[];
  syncing: boolean;   // always false (server-side); client shows blocking banner if truthy
}

interface HeatmapPoint {
  facility_id: number;                    // API response key (numeric) — NOT unique_id; see intro note
  latitude: number;                       // CAST(latitude AS DOUBLE)
  longitude: number;                      // CAST(longitude AS DOUBLE)
  trust_weight: number;                   // see formula + NULL caveat above
  capability: string | null;              // raw capability string
  address_stateorregion: string | null;
}
```

The response is an **object** with a `points` array, not a bare array.

#### Example Response

```json
{
  "points": [
    { "facility_id": 42, "latitude": 13.0827, "longitude": 80.2707, "trust_weight": 1.0, "capability": "Emergency,Surgery,ICU", "address_stateorregion": "Tamil Nadu" },
    { "facility_id": 88, "latitude": 19.0760, "longitude": 72.8777, "trust_weight": 0.667, "capability": "Emergency", "address_stateorregion": "Maharashtra" },
    { "facility_id": 131, "latitude": 28.6139, "longitude": 77.2090, "trust_weight": 0.333, "capability": "Emergency,Outpatient", "address_stateorregion": "Delhi" }
  ],
  "syncing": false
}
```

#### Caching Behavior

- Cache store: shared in-memory `Map` on the Express.js process
- TTL: 5 minutes from time of first fetch per cache key
- Cache key: `heatmap-points:<capability>` (suffix is `""` when omitted)
- Cache is not shared across app instances and is lost on process restart or redeploy

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load heatmap points" }` |

---

### 7. GET /api/desert/state-gaps

Returns per-state demand-versus-supply metrics, optionally filtered by capability. Used to render the state-level ranking/choropleth view on the Desert Planner page.

**Cached:** Yes — 5-minute in-memory cache keyed on `state-gaps:<capability>`.

> **Client behavior:** `DesertPage.tsx` replaces the map with a blocking "Data syncing…" banner when this endpoint (or `heatmap-points`) reports `syncing: true`. Currently always `false`. See "Common response field."

#### Demand Index Formula (NFHS-5)

The field is named `demand_index`, and the concept it encodes is a **deprivation-based demand proxy**: the average of four `(100 − coverage%)` terms over a state's NFHS-5 districts. Higher = more deprivation = more unmet demand. The **field** is `demand_index` and the **concept** is "deprivation-based demand" — they are the same number, not two different quantities.

```sql
ROUND((
    (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
  + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
  + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
  + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
) / 4.0, 1)
```

Each missing/NULL component average defaults to `50` before the `100 -` deprivation transform.

#### Gap Score Formula

```sql
ROUND(
  COALESCE(demand_index, 50) /
  GREATEST(facility_count * avg_trust_weight / 10.0, 0.1),
  2
)
```

- The numerator falls back to `50` when a state has no matching NFHS demand row (`COALESCE(demand_index, 50)`).
- `facility_count` and `avg_trust_weight` come from the facilities side, filtered by the capability clause.
- The denominator (the `supply_score`) is floored at `0.1` to prevent division by zero in states with zero matching facilities.
- Results are ordered `gap_score DESC NULLS LAST`.

#### Join Semantics (correctness caveat)

The query computes two CTEs — `facility_state` (grouped from `facilities`) and `nfhs_state` (grouped from NFHS-5) — and combines them with a **`FULL OUTER JOIN` on `LOWER(TRIM(state))`** (`address_stateorregion` vs `state_ut`). Consequently:
- States present in only one source still appear in the output.
- Facility-only states have `demand_index = null`, `district_count = null` (gap numerator falls back to `50`).
- NFHS-only states have `facility_count = 0`, `avg_trust_weight = 0` (supply floored to `0.1`).
- **State-name spelling mismatches** between the two sources (e.g., `"NCT of Delhi"` vs `"Delhi"`) prevent matching and can inflate/deflate or default gap scores. See Known Issues for the crosswalk remediation example.

#### Confidence Field

A `confidence` label is computed in the server (not SQL) from `source_type_variants` (= `COUNT(DISTINCT source_types)` for the state):

| `source_type_variants` | `confidence` |
|---|---|
| `>= 3` | `"high"` |
| `1` or `2` | `"medium"` |
| `0` | `"low"` |

#### Request

```bash
curl "https://<app-host>/api/desert/state-gaps?capability=Maternity"
```

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `capability` | `string` | No | `""` | When non-empty, adds `AND capability ILIKE '%<capability>%'` to the facility-side aggregation. Single-quote escaped before interpolation — **see Known Issues.** Substring match — see the capability filter/summary asymmetry note in Known Issues. |

#### Response Shape

```typescript
interface StateGapsResponse {
  gaps: StateGap[];
  syncing: boolean;   // always false (server-side); client shows blocking banner if truthy
}

interface StateGap {
  state: string;                          // COALESCE(nfhs.state_ut, facilities.address_stateorregion)
  facility_count: number;                 // matched facilities in state (0 if none)
  avg_trust_weight: number;               // ROUND(avg trust weight, 3); 0 if no facilities
  source_type_variants: number;           // COUNT(DISTINCT source_types)
  demand_index: number | null;            // deprivation-based demand; null when no NFHS row matched the state
  district_count: number | null;          // COUNT(DISTINCT district_name); null when no NFHS match
  supply_score: number;                   // ROUND(facility_count * avg_trust_weight / 10.0, 2)
  gap_score: number;                       // see formula
  confidence: 'high' | 'medium' | 'low';  // derived from source_type_variants (server-side)
  avg_electricity: number | null;         // ROUND(AVG(hh_electricity_pct), 1); null when no NFHS match
  avg_water: number | null;               // ROUND(AVG(hh_improved_water_pct), 1)
  avg_sanitation: number | null;          // ROUND(AVG(hh_use_improved_sanitation_pct), 1)
  avg_birth_reg: number | null;           // ROUND(AVG(child_u5_whose_birth_was_civil_reg_pct), 1)
}
```

The response is an **object** with a `gaps` array, not a bare array. (Authoritative client interface: `client/src/pages/desert/types.ts`. Note: that file declares `syncing?: boolean` as **optional** on the response wrappers, though the server always emits it.)

#### Example Response

```json
{
  "gaps": [
    {
      "state": "Bihar",
      "facility_count": 142,
      "avg_trust_weight": 0.44,
      "source_type_variants": 4,
      "demand_index": 58.4,
      "district_count": 38,
      "supply_score": 6.25,
      "gap_score": 9.34,
      "confidence": "high",
      "avg_electricity": 62.3,
      "avg_water": 71.8,
      "avg_sanitation": 38.2,
      "avg_birth_reg": 55.1
    },
    {
      "state": "Kerala",
      "facility_count": 890,
      "avg_trust_weight": 0.91,
      "source_type_variants": 3,
      "demand_index": 8.1,
      "district_count": 14,
      "supply_score": 80.99,
      "gap_score": 0.1,
      "confidence": "high",
      "avg_electricity": 97.2,
      "avg_water": 94.1,
      "avg_sanitation": 91.5,
      "avg_birth_reg": 99.0
    }
  ],
  "syncing": false
}
```

#### Caching Behavior

- Cache store: shared in-memory `Map` on the Express.js process
- TTL: 5 minutes from time of first fetch per cache key
- Cache key: `state-gaps:<capability>` (suffix is `""` when omitted)
- Cached value is the post-processed array **including** the server-computed `confidence` field
- Cache is not shared across app instances and is lost on process restart or redeploy

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load state gaps" }` |

---

### 8. GET /api/desert/capability-summary

Returns up to the top 20 facility capability strings by facility count. Used to populate the capability filter dropdown on the Desert Planner page.

**Cached:** Yes — 5-minute in-memory cache with a single fixed key `capability-summary`.

#### Aggregation Semantics

Grouping is on the **raw** capability string: `COALESCE(NULLIF(TRIM(capability), ''), 'Unknown')`. The query does **not** split comma-separated values. A facility whose `capability` is `"Emergency,Surgery,ICU"` forms a single composite bucket distinct from `"Emergency"`. Rows with null/empty `capability` are excluded by the `WHERE` clause (so the `'Unknown'` coalesce target is effectively unreachable here). Results are `ORDER BY facility_count DESC LIMIT 20`.

> **Filter/summary mismatch:** the dropdown is populated with raw, un-split capability strings (composites like `'Emergency,Surgery,ICU'` are their own option), but `heatmap-points`/`state-gaps` filter via `capability ILIKE '%value%'`. Selecting a composite option filters on that exact comma-joined substring, which can return **fewer** facilities than the summary's `facility_count` for that bucket; selecting `'Emergency'` will also match composites containing it. Grouping is exact-string; filtering is substring — they are not symmetric. Document this or normalize (split on comma) on both sides. See Known Issues.

#### Request

```bash
curl "https://<app-host>/api/desert/capability-summary"
```

No query parameters.

#### Response Shape

```typescript
interface CapabilitySummaryResponse {
  summary: CapabilitySummaryItem[];   // at most 20 entries (LIMIT 20)
  syncing: boolean;                   // always false (server-side)
}

interface CapabilitySummaryItem {
  capability: string;        // raw (un-split) capability string
  facility_count: number;    // COUNT(*) for that exact string
  avg_trust_weight: number;  // ROUND(avg trust weight, 2)
  state_count: number;       // COUNT(DISTINCT address_stateorregion)
}
```

The response is an **object** with a `summary` array, not a bare array. The array contains **at most** 20 entries (fewer if there are fewer than 20 distinct non-empty capability strings).

#### Example Response

```json
{
  "summary": [
    { "capability": "Outpatient", "facility_count": 7842, "avg_trust_weight": 0.61, "state_count": 31 },
    { "capability": "Emergency", "facility_count": 4103, "avg_trust_weight": 0.55, "state_count": 29 },
    { "capability": "Maternity", "facility_count": 3291, "avg_trust_weight": 0.58, "state_count": 28 },
    { "capability": "Emergency,Surgery,ICU", "facility_count": 1544, "avg_trust_weight": 0.83, "state_count": 22 }
  ],
  "syncing": false
}
```

#### Caching Behavior

- Cache store: shared in-memory `Map` on the Express.js process
- TTL: 5 minutes from time of population
- Cache key: fixed `capability-summary` (no parameter variation)
- Cache is not shared across app instances and is lost on process restart or redeploy

#### Error Responses

| Status | Condition | Body |
|---|---|---|
| `500 Internal Server Error` | SQL Warehouse query failure | `{ "error": "Failed to load capability summary" }` |

---

## Appendix A: Data Source Reference

All endpoints query the SQL Warehouse via `appkit.analytics.query()` against schema `dais27hack.virtue_foundation_dataset_silver`.

| Table | Catalog/Schema | Rows | Notes |
|---|---|---|---|
| `facilities` | `dais27hack.virtue_foundation_dataset_silver` | 10,088 | **The table every endpoint reads** (not `facilities_live`). Duplicate `unique_id` values; **null bytes in `name`/`description` are NOT cleaned on this table** — the cleanup was applied to `facilities_live` only, so API responses can still contain null bytes (see Known Issues). API projects the numeric `facility_id`, not the physical `unique_id` column. The heatmap query applies `CAST(latitude AS DOUBLE)` / `CAST(longitude AS DOUBLE)`; whether this is required or redundant depends on the column type — tracked under **Known Issues → Open Verification Tasks**. |
| `nfhs_5_district_health_indicators` | `dais27hack.virtue_foundation_dataset_silver` | 706 | Composite PK: `district_name` + `state_ut`. Indicator columns used by the API: `households_surveyed`, `hh_electricity_pct`, `hh_improved_water_pct`, `hh_use_improved_sanitation_pct`, `child_u5_whose_birth_was_civil_reg_pct`, `sex_ratio_total_f_per_1000_m`. |
| `india_post_pincode_directory` | `dais27hack.virtue_foundation_dataset_silver` | 165,627 | `latitude` and `longitude` are STRING type, not DOUBLE — requires `CAST` for geographic queries. Not currently read by any documented endpoint. |

Live variants (`facilities_live`, `nfhs_5_district_health_indicators_live`, `india_post_pincode_directory_live`) are CDF-enabled (Change Data Feed) Delta tables in the same schema, synced to Lakebase Postgres (catalog: `virtue-pg`, endpoint: `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com`) via TRIGGERED mode synced tables. **The production API endpoints do not read from these live/Lakebase tables** — they read the base tables via the SQL Warehouse. This is why the null-byte remediation (applied to `facilities_live`) does **not** reach the API read path. (And the Lakebase plugin itself is not even loaded at runtime — see the intro Data-source note.) Note: if a future Track 4 implementation profiles `facilities_live` per `project-overview.md §8`, its completeness/null-byte counts will deliberately differ from what these endpoints return against the plain `facilities` table.

---

## Appendix B: Deployment Wiring (for API operators)

The warehouse the API queries is bound through the DABs (Databricks Asset Bundles) bundle, not a hardcoded literal in the app code. The full resolution chain is documented authoritatively in `deployment.md`; the relevant facts for this API:

- `databricks.yml`: bundle `name: virtue-health`; app resource key is **`app`** (with `name: "virtue-health"`); `source_code_path: ./`; warehouse supplied via a bundle **variable** `${var.warehouse_id}` (default `5b2b29cce22aa2c4` under `targets.default.variables`); the app declares a `resources` binding `sql-warehouse` with `permission: CAN_USE`; the `sync.include` block lists **both** `dist/` and `client/dist/`.
- `app.yaml`: `command: ['npm', 'run', 'start']`; env `DATABRICKS_WAREHOUSE_ID` is sourced via `valueFrom: sql-warehouse` (the bound resource), **not** a literal value.

Resolution chain (where the warehouse ID actually comes from at runtime):

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

- `.env.example` (local dev): ships **placeholders, not resolved values** — `DATABRICKS_HOST=https://...`, `PGDATABASE=your_postgres_databaseName`, `LAKEBASE_ENDPOINT=your_postgres_endpointPath`, `PGHOST=your_postgres_host`, `PGPORT=5432`, `PGSSLMODE=require`, `DATABRICKS_APP_PORT=8000`, `DATABRICKS_APP_NAME=virtue-health`, `FLASK_RUN_HOST=0.0.0.0`. There are no `LAKEBASE_HOST/DATABASE/USER/PASSWORD/SCHEMA` variables. The `PG*`/`LAKEBASE_ENDPOINT` values would be consumed by the AppKit `lakebase` plugin — but that plugin is **not currently loaded** (see intro note), so these variables are unused at runtime today.
