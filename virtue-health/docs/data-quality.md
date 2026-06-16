# Data Quality: Bronze → Silver Pipeline

**Notebook**: `src/enrich_facilities.py`  
**Input**: `dais27hack.virtue_foundation_dataset_silver.facilities` (read-only source)  
**Output**: `dais27hack.virtue_foundation_dataset_silver.facilities_silver`  
**Job**: `[virtue-health] Enrich Facilities: Bronze → Silver` (daily 05:30 IST, PAUSED)

---

## Overview

The `facilities` table is ingested from upstream as a read-only snapshot. It contains a range of structural and content quality problems traceable to the original file-based ingestion: embedded null bytes, blank columns encoded as empty strings, coordinates outside India, column data shifted by CSV parsing errors, and missing geographic fields needed for downstream analytics.

`enrich_facilities.py` runs three phases:

| Phase | What it does |
|-------|-------------|
| 1 — Text cleaning | Strips null bytes, normalizes whitespace, converts `''` → NULL, fixes `source_types` NULL |
| 2 — LLM column alignment | Detects rows where data landed in the wrong column; calls a Databricks-hosted LLM in parallel to identify and correct misalignment |
| 3 — Enrichment joins | Fills missing coordinates and address fields from five enrichment tables; normalizes state names; derives district for NFHS joins |

---

## Phase 1: Text Cleaning

### 1.1 Null byte removal

**Issue**: The `name` and `description` columns (and occasionally others) contain embedded null bytes (`\x00`, ASCII 0). These cause silent truncation in downstream string operations, break the Lakebase Postgres sync (which rejects null bytes), and produce misleading `LIKE` / `CONTAINS` misses.

**Source**: The upstream file contained binary-encoded text from a source system that pads strings with null terminators.

**Fix**: `TRANSLATE(col, '\x00', '')` is applied to all text columns before any other transformation.

**Columns affected**: `name`, `description`, `address_city`, `address_stateorregion`, `address_country`, `specialties`, `equipment`, `procedure`, `source_ids`, `source_urls`, `organization_type`, `capability`, `cluster_id`.

### 1.2 Empty string normalization

**Issue**: Many columns contain `''` (empty string) rather than `NULL`. Spark SQL treats `''` and `NULL` differently — aggregations, `COALESCE`, and `IS NULL` checks behave incorrectly against empty strings.

**Fix**: After null-byte stripping and trimming, any remaining empty string is converted to `NULL` via `NULLIF(TRIM(…), '')`.

### 1.3 `source_types` NULL fix

**Issue**: The facility capability scoring notebook computes a trust weight using `SIZE(SPLIT(source_types, ','))`. In Spark, `SIZE(SPLIT(NULL, ','))` returns `-1`, producing a **negative** trust weight. Facilities with no source types receive a lower score than they should, artificially depressing their ranking.

**Fix**: `COALESCE(source_types, '')` — NULL `source_types` becomes an empty string. `SIZE(SPLIT('', ','))` returns `1` (a single empty element), which nets to `0` signal rather than `-1`. This is conservative and correct.

**Downstream impact**: Fixes the trust-weight bug in `facility_capability_scoring_enhanced.py` without requiring changes to the scoring notebook, as long as it reads from `facilities_silver`.

### 1.4 Coordinate validation

**Issue**: Some facilities have `latitude`/`longitude` values that are:
- Outside India's bounding box (6°N–37.5°N, 68°E–97.5°E) — likely default/placeholder values from the source system (e.g., `0, 0` or coordinates in another country).
- Stored as `STRING` type instead of `DOUBLE` in some variants of the source table (see `india_post_pincode_directory` type anomaly in `docs/data-model.md`).

**Fix**:
1. Cast both columns to `DOUBLE` defensively.
2. Nullify any row where either coordinate falls outside the India bbox.
3. These nullified coordinates are then eligible for recovery in Phase 3.

**Counts logged** at runtime: rows nullified, rows needing coordinate enrichment.

---

## Phase 2: LLM Column Alignment

### 2.1 Problem: CSV/Excel column shifts

When the source files were ingested, rows containing an unescaped comma inside a quoted field, or a Unicode character outside the expected range, caused the CSV parser to miscount columns. The result is that a facility's data is shifted one or more columns to the right or left for affected rows:

| Expected | Actual (shifted) |
|----------|-----------------|
| `name` = "Apollo Hospital, Mumbai" | `name` = "Apollo Hospital" |
| `address_city` = "Mumbai" | `organization_type` = "Mumbai" |
| `organization_type` = "Hospital" | `capability` = "Hospital" |

This is distinct from missing data or wrong values — the correct data is present but in the wrong column.

### 2.2 Detection

Suspicious rows are identified with lightweight regex heuristics before invoking the LLM:

| Heuristic | Detected pattern |
|-----------|----------------|
| `name` contains a phone pattern | `+91`, `0XXXXXXXXXX`, `NNN-NNN-NNNN` |
| `name` starts with a digit followed by address keywords | e.g., `"12 Sector 5 Road"` |
| `address_city` contains facility-type keywords | `hospital`, `clinic`, `PHC`, `nursing home` |
| `capability` contains address keywords | `sector`, `nagar`, `road`, etc. |
| `organization_type` length > 60 chars | Likely contains a facility name |

Up to **5,000 suspicious rows** are sampled for LLM review (`LLM_CAP` constant).

### 2.3 LLM endpoint discovery

The notebook auto-discovers the best available Databricks Foundation Model endpoint, trying in priority order:

1. `databricks-meta-llama-3-3-70b-instruct`
2. `databricks-meta-llama-3-1-70b-instruct`
3. `databricks-dbrx-instruct`
4. `databricks-mixtral-8x7b-instruct`

Calls are made via `requests.post()` directly against the workspace serving-endpoint URL, using the notebook's API token captured in the main thread before any workers are spawned. This avoids the shared `requests.Session` inside the MLflow deployment client, which is not safe for concurrent use across threads. If no endpoint is reachable, the LLM pass is **skipped gracefully** (the notebook continues and logs a warning; other phases still run).

### 2.4 Parallel LLM calls

Each suspicious row is sent as an independent prompt to the LLM using a **10-thread `ThreadPoolExecutor`**, yielding ~10× throughput versus sequential calls. Up to **1,000 suspicious rows** are sampled (`LLM_CAP` constant) — roughly 3 minutes wall-clock at 10 workers × ~2s/call. Each call includes:

- The row's key column values as JSON
- Column definitions (expected content per column)
- An instruction to identify misalignment only (not general data quality issues)
- A schema for structured JSON output

**Prompt output format**:
```json
{
  "column_corrections": {
    "name": "Apollo Hospital Mumbai",
    "address_city": "Mumbai"
  }
}
```

Corrections are only recorded when the LLM provides a non-null replacement value. The LLM response is parsed with a bracket-depth JSON extractor that handles models that add surrounding prose before the JSON object.

Failed or rate-limited calls are retried up to 2 times with exponential backoff (1 s, 2 s). Calls that fail all retries contribute no correction (safe — the row keeps its original values).

### 2.5 Applying corrections

Corrections are collected as `{_row_id → {col: new_value}}` in the driver. A surrogate row key (`monotonically_increasing_id()`) is used instead of `unique_id` because the source table contains duplicate `unique_id` values (a known upstream defect — see `docs/data-pipeline.md`).

A correction DataFrame is broadcast-joined back to `cleaned` on `_row_id`. For each correctable column, the corrected value replaces the original only when the LLM provided a non-null replacement:

```
final_value = IF _fix_<col> IS NOT NULL THEN _fix_<col> ELSE original_<col>
```

**Columns eligible for LLM correction**: `name`, `organization_type`, `capability`, `address_city`, `address_stateorregion`, `description`.

---

## Phase 3: Enrichment Joins

Five enrichment tables (populated by the ingest jobs in `resources/*.job.yml`) are joined to fill missing coordinates and address fields.

### 3.1 Enrichment sources

| Table | Rows (approx.) | Provides | Join key |
|-------|---------------|----------|----------|
| `geonames_pincodes` | ~30K | State, district, city, lat/lon | 6-digit pincode extracted from `address_city` |
| `postalpincode_lookup` | ~30K | State, district | 6-digit pincode extracted from `address_city` |
| `wikidata_hospitals` | ~2.5K | Lat/lon for known hospitals | `lower(trim(name))` |
| `osm_india_facilities` | ~50K | Lat/lon, city | `lower(trim(name))` + `lower(trim(state))` |
| `overture_india_places` | ~10K | Lat/lon, city | `lower(trim(name))` + `lower(trim(state))` |

> **Note**: `osm_india_facilities` is populated from Overture Maps data when all Overpass API mirrors block cloud egress IPs. The data is OpenStreetMap-derived regardless.

### 3.2 Pincode extraction

Many Indian addresses embed the 6-digit postal code inside the `address_city` string (e.g., `"Bandra West 400050"`). A regex extracts it before the city-centroid match so that the numeric portion does not corrupt the city name key:

```
_pin       = REGEXP_EXTRACT(address_city, '(\d{6})', 1)   -- for pincode joins
_city_key  = TRIM(LOWER(REGEXP_REPLACE(address_city, '\d{6}', '')))  -- for city joins
```

### 3.3 Coordinate recovery priority

For rows where valid original coordinates were nullified or were never present:

```
latitude = COALESCE(
    _lat_ok,        -- 1. valid original (in-bbox)
    wk_lat,         -- 2. Wikidata name match
    om_lat,         -- 3. OSM/Overture name + state match
    ov_lat,         -- 4. Overture name + state match
    gp_lat,         -- 5. GeoNames pincode match (point)
    gc_lat          -- 6. GeoNames city centroid (fallback)
)
```

Wikidata is prioritized because it uses manually curated hospital records with verified GPS. OSM/Overture use name + state as the join key (rather than name alone) to reduce false positives from common facility names like "Government Hospital" that appear in every state.

`coord_source` records which source filled each row's coordinates — used for quality auditing in the final report.

### 3.4 Address backfill

| Column | Backfill source (in order) |
|--------|--------------------------|
| `address_city` | OSM `addr_city` → Overture `city` → GeoNames `place_name` |
| `address_stateorregion` | GeoNames `state` (from pincode) → Pincode lookup `state` |
| `address_district` *(new)* | Pincode lookup `district` → GeoNames `district` |

`address_district` is a **new column** not present in the source. It is required for joining facilities to `nfhs_5_district_health_indicators` at district granularity (Track 2 gap-score computation currently joins only at state level, losing precision).

### 3.5 State name normalization

**Issue**: `address_stateorregion` is inconsistently cased and uses historic or abbreviated state names that do not match the `state_ut` column in `nfhs_5_district_health_indicators`. The largest known cases:

| Source value | NFHS canonical |
|-------------|---------------|
| `MAHARASHTRA` / `maharashtra` | `Maharashtra` |
| `Orissa` | `Odisha` |
| `Uttaranchal` | `Uttarakhand` |
| `Pondicherry` | `Puducherry` |
| `NCT of Delhi` / `New Delhi` | `Delhi` |
| `Jammu and Kashmir` / `J&K` | `Jammu & Kashmir` |
| `Chattisgarh` | `Chhattisgarh` |
| `Telengana` | `Telangana` |
| `Daman and Diu` / `Dadra and Nagar Haveli` | `Dadra & Nagar Haveli and Daman & Diu` |
| `Andaman and Nicobar Islands` / `A&N Islands` | `Andaman & Nicobar Islands` |

**Fix**: Two-step normalization:
1. Lookup against the alias table above (broadcast join on `lower(trim(address_stateorregion))`).
2. Fallback: `INITCAP(address_stateorregion)` normalizes the common case of wrong casing without a known alias.

Result stored in **`state_canonical`** (new column). Existing `address_stateorregion` is preserved unchanged for audit purposes.

---

## Output Schema

`facilities_silver` contains all columns from `facilities` (in-place cleaned) plus:

| New column | Type | Description |
|------------|------|-------------|
| `address_district` | STRING | District name from pincode lookup — enables NFHS district joins |
| `state_canonical` | STRING | NFHS-compatible state name |
| `coord_source` | STRING | Which source filled coordinates: `original`, `wikidata`, `osm`, `overture`, `geonames_pin`, `geonames_city`, `none` |

---

## Known Remaining Limitations

| Issue | Status | Notes |
|-------|--------|-------|
| Duplicate `unique_id` | **NOT FIXED** — upstream defect | Requires source-side deduplication; tracked in `data-pipeline.md` |
| LLM column-alignment coverage | **PARTIAL** — up to 1,000 rows | `LLM_CAP` in notebook; raise for full coverage (costs more, ~3 min at default) |
| Fuzzy name matching for coordinates | **NOT DONE** | Exact name match only; typos or abbreviations in `name` will miss Wikidata/OSM/Overture lookups |
| `address_district` NULL rate | **DEPENDS ON PINCODE COVERAGE** | Only populated when a 6-digit pincode is detectable in `address_city`; many facilities have no pincode in address |
| State mismatch in NFHS join | **PARTIALLY FIXED** via `state_canonical` | Downstream analytics must join on `state_canonical`, not `address_stateorregion` |
| Null bytes in source `facilities` table | **NOT FIXED IN SOURCE** — only in silver | The `facilities` read-only table still has null bytes; apps reading it directly will see them |

---

## Running the Pipeline

```bash
# Deploy (after any notebook edit)
databricks bundle deploy --profile jody-free-workspace

# Run once manually
databricks bundle run enrich_facilities --profile jody-free-workspace

# Check run status
databricks bundle run enrich_facilities --profile jody-free-workspace --no-wait
```

The job is scheduled daily at 05:30 IST (`PAUSED` by default). Unpause via the Databricks UI or:

```bash
databricks jobs update <job_id> --json '{"schedule": {"pause_status": "UNPAUSED"}}'
```

---

## Dependency Order

```
geonames_pincodes     ──┐
postalpincode_lookup  ──┤
wikidata_hospitals    ──┼──► enrich_facilities ──► facilities_silver
osm_india_facilities  ──┤                              │
overture_india_places ──┘                              ▼
                                            facility_capability_scoring
                                            (reads facilities_silver for
                                             clean source_types, coords,
                                             state_canonical)
```

Downstream notebooks should read `facilities_silver` instead of `facilities` to get the quality-fixed data.
