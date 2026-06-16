# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Enrich Facilities: Bronze → Silver
# MAGIC
# MAGIC Reads `facilities` (read-only source), applies quality fixes, an LLM-based
# MAGIC column-alignment pass, and coordinate / address backfill from enrichment tables.
# MAGIC Writes `facilities_silver`.
# MAGIC
# MAGIC | Phase | Fix |
# MAGIC |-------|-----|
# MAGIC | 1 — Text cleaning | Strip `\x00`, trim, `''` → NULL, fix `source_types` NULL |
# MAGIC | 1 — Coord validation | Nullify coords outside India bbox |
# MAGIC | 2 — LLM alignment | Parallel LLM calls flag rows where data landed in wrong column |
# MAGIC | 3 — Enrichment joins | Wikidata / OSM / Overture / GeoNames fill missing coords + address |
# MAGIC | 3 — State normalization | `INITCAP` + alias map → `state_canonical` for NFHS joins |
# MAGIC | 3 — District backfill | Pincode lookup → `address_district` for NFHS district joins |

# COMMAND ----------

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from pyspark.sql import functions as F
from pyspark.sql.functions import broadcast
from pyspark.sql.types import LongType, StringType, StructField, StructType

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
SRC     = f"{CATALOG}.{SCHEMA}.facilities"
OUT     = f"{CATALOG}.{SCHEMA}.facilities_silver"

INDIA_LAT_MIN, INDIA_LAT_MAX = 6.0,  37.5
INDIA_LON_MIN, INDIA_LON_MAX = 68.0, 97.5

# Columns the LLM is allowed to correct
CORRECTABLE_COLS = [
    "name", "organization_type", "capability",
    "address_city", "address_stateorregion", "description",
]

# COMMAND ----------

fac = spark.table(SRC)
total_src = fac.count()
print(f"Source: {SRC}  rows={total_src:,}  cols={len(fac.columns)}")

# COMMAND ----------
# ── Phase 1: Text cleaning ───────────────────────────────────────────────────

TEXT_COLS = [c for c in [
    "name", "description", "address_city", "address_stateorregion",
    "address_country", "specialties", "equipment", "procedure",
    "source_ids", "source_urls", "organization_type", "capability", "cluster_id",
] if c in fac.columns]

def clean_str(col_expr):
    stripped = F.trim(F.translate(col_expr, "\x00", ""))
    return F.when(stripped.isNotNull() & (stripped != ""), stripped)

cleaned = fac
for c in TEXT_COLS:
    cleaned = cleaned.withColumn(c, clean_str(F.col(c)))

# NULL source_types → '' prevents SIZE(SPLIT(NULL, ',')) = -1 in trust-weight scoring
if "source_types" in fac.columns:
    cleaned = cleaned.withColumn(
        "source_types",
        F.coalesce(clean_str(F.col("source_types")), F.lit("")),
    )

# Stable surrogate row key — unique_id has known duplicates in source
cleaned = cleaned.withColumn("_row_id", F.monotonically_increasing_id())

# Validate and cast coordinates; nullify anything outside India
cleaned = (
    cleaned
    .withColumn("_lat0", F.col("latitude").cast("double"))
    .withColumn("_lon0", F.col("longitude").cast("double"))
    .withColumn(
        "_lat_ok",
        F.when(
            F.col("_lat0").between(INDIA_LAT_MIN, INDIA_LAT_MAX)
            & F.col("_lon0").between(INDIA_LON_MIN, INDIA_LON_MAX),
            F.col("_lat0"),
        ),
    )
    .withColumn(
        "_lon_ok",
        F.when(
            F.col("_lat0").between(INDIA_LAT_MIN, INDIA_LAT_MAX)
            & F.col("_lon0").between(INDIA_LON_MIN, INDIA_LON_MAX),
            F.col("_lon0"),
        ),
    )
    .drop("latitude", "longitude", "_lat0", "_lon0")
)

n_bad  = fac.filter(F.col("latitude").cast("double").isNotNull() & ~F.col("latitude").cast("double").between(INDIA_LAT_MIN, INDIA_LAT_MAX)).count()
n_null = cleaned.filter(F.col("_lat_ok").isNull()).count()
print(f"Coords outside India bbox (nullified): {n_bad:,}")
print(f"Rows needing coordinate enrichment:     {n_null:,}")

# COMMAND ----------
# ── Phase 2: LLM column alignment ───────────────────────────────────────────
#
# Detects rows where a column's value looks wrong for that column (typical of
# CSV/Excel shifts: a stray comma in a facility name splits the row mid-field,
# pushing all subsequent values one column to the right).
#
# Each suspicious row is sent to a Databricks-hosted LLM in parallel; the
# model returns a JSON correction map that is joined back and applied.

# 2a. Discover best available foundation-model endpoint
#
# We use requests.post() directly rather than mlflow.deployments.get_deploy_client()
# because the MLflow client wraps a requests.Session that is not safe for concurrent
# use across threads.  A plain requests.post() opens its own connection per call and
# is unambiguously thread-safe.

import requests as _requests

_LLM_CANDIDATES = [
    "databricks-meta-llama-3-3-70b-instruct",
    "databricks-meta-llama-3-1-70b-instruct",
    "databricks-dbrx-instruct",
    "databricks-mixtral-8x7b-instruct",
]

# Capture auth token and workspace URL in main thread before spawning workers.
# dbutils / spark context are not reliably accessible inside ThreadPoolExecutor threads.
try:
    _LLM_TOKEN = dbutils.notebook.entry_point.getDbutils().notebook().getContext().apiToken().get()
except Exception:
    _LLM_TOKEN = None

_LLM_WORKSPACE = spark.conf.get("spark.databricks.workspaceUrl", "")
_LLM_HEADERS   = {
    "Authorization": f"Bearer {_LLM_TOKEN}",
    "Content-Type":  "application/json",
}

def _llm_post(endpoint, payload, timeout=30):
    url  = f"https://{_LLM_WORKSPACE}/serving-endpoints/{endpoint}/invocations"
    resp = _requests.post(url, headers=_LLM_HEADERS, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()

LLM_ENDPOINT = None
for _ep in _LLM_CANDIDATES:
    try:
        _llm_post(_ep, {"messages": [{"role": "user", "content": "ping"}], "max_tokens": 3})
        LLM_ENDPOINT = _ep
        print(f"LLM endpoint: {LLM_ENDPOINT}")
        break
    except Exception as _e:
        print(f"  {_ep}: unavailable ({_e})")

if not LLM_ENDPOINT:
    print("WARNING: no LLM endpoint reachable — skipping column-alignment pass")

# COMMAND ----------

# 2b. Detect suspicious rows (lightweight regex heuristics)
LLM_CAP      = 1_000   # max suspicious rows to send to LLM (~3 min at 10 workers)
LLM_WORKERS  = 10      # concurrent calls

PHONE_PAT  = r"(\+91|\b0\d{9,10}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)"
ADDR_WORDS = r"(?i)\b(sector|road|street|nagar|colony|near|ward|block|gate|marg|chowk|bazar|plot|flat|floor)\b"
FAC_WORDS  = r"(?i)\b(hospital|clinic|medical|health\s*cent(re|er)|nursing\s*home|dispensary|PHC|CHC|diagnostic)\b"

suspicious_df = (
    cleaned
    .filter(
        F.col("name").rlike(PHONE_PAT)
        | (F.col("name").rlike(ADDR_WORDS) & F.col("name").rlike(r"^\d"))
        | F.col("address_city").rlike(FAC_WORDS)
        | F.col("capability").rlike(ADDR_WORDS)
        | (F.length(F.col("organization_type")) > 60)
    )
    .select("_row_id", *[c for c in CORRECTABLE_COLS if c in cleaned.columns])
    .limit(LLM_CAP)
)

sus_rows = suspicious_df.collect()
print(f"Suspicious rows to review: {len(sus_rows):,}")

# COMMAND ----------

# 2c. LLM call function

_COL_DEFS = """- name: facility name (e.g. "Apollo Hospital", "Govt. PHC Raipur")
- organization_type: short type label (e.g. "Hospital", "Clinic", "PHC", "Pharmacy")
- capability: care level (e.g. "Primary Care", "Secondary Care", "Tertiary Care")
- address_city: city name only (e.g. "Mumbai", "Bangalore")
- address_stateorregion: Indian state or UT (e.g. "Maharashtra", "Karnataka")
- description: free-text description of the facility"""

def _build_prompt(row_dict):
    payload = {k: v for k, v in row_dict.items() if k != "_row_id" and v is not None}
    return (
        "You are a data quality expert for Indian healthcare facility records.\n\n"
        "Review this record. Identify ONLY columns where the value clearly belongs in a "
        "different column (column misalignment from CSV/Excel parsing errors — NOT other "
        "data quality issues).\n\n"
        f"Record:\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        f"Column definitions:\n{_COL_DEFS}\n\n"
        "Respond with valid JSON ONLY. If no misalignment, return {\"column_corrections\": {}}.\n"
        "If misalignment found, include only the corrected columns with corrected values "
        "(use null to blank a field):\n"
        "{\"column_corrections\": {\"column_name\": \"corrected value or null\", ...}}"
    )

def _parse_json(text):
    """Extract the first JSON object from LLM output (handles surrounding prose)."""
    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    pass
                break
    return {}

def _call_llm(row, retries=2):
    """Call LLM for one suspicious row. Returns (row_id, {col: corrected_val}).

    Uses requests.post() directly rather than a shared mlflow deployment client
    so each thread opens its own connection (thread-safe by construction).
    """
    row_dict = row.asDict()
    prompt   = _build_prompt(row_dict)
    payload  = {
        "messages":    [{"role": "user", "content": prompt}],
        "max_tokens":  256,
        "temperature": 0.0,
    }
    for attempt in range(retries + 1):
        try:
            data = _llm_post(LLM_ENDPOINT, payload)
            text = data["choices"][0]["message"]["content"]
            obj  = _parse_json(text)
            fixes = {
                k: (None if v in (None, "null", "NULL", "") else str(v))
                for k, v in obj.get("column_corrections", {}).items()
                if k in CORRECTABLE_COLS
            }
            return (row_dict["_row_id"], fixes)
        except Exception:
            if attempt < retries:
                time.sleep(2 ** attempt)
    return (row_dict["_row_id"], {})

# COMMAND ----------

# 2d. Run LLM calls in parallel and collect corrections

all_corrections = {}   # {_row_id: {col: new_val}}

if LLM_ENDPOINT and sus_rows:
    with ThreadPoolExecutor(max_workers=LLM_WORKERS) as pool:
        futures = {pool.submit(_call_llm, row): row["_row_id"] for row in sus_rows}
        for i, future in enumerate(as_completed(futures), 1):
            row_id, fixes = future.result()
            if fixes:
                all_corrections[row_id] = fixes
            if i % 100 == 0:
                print(f"  LLM: {i:,}/{len(sus_rows):,} — {len(all_corrections):,} corrections so far")

    print(f"LLM corrections: {len(all_corrections):,} rows out of {len(sus_rows):,} reviewed")
else:
    print("Skipping LLM pass (no endpoint or no suspicious rows)")

# COMMAND ----------

# 2e. Apply corrections to `cleaned` via join on _row_id

if all_corrections:
    fix_schema = StructType(
        [StructField("_row_id", LongType(), False)]
        + [StructField(f"_fix_{c}", StringType(), True) for c in CORRECTABLE_COLS]
    )

    fix_rows = []
    for row_id, col_fixes in all_corrections.items():
        row = {"_row_id": row_id}
        for c in CORRECTABLE_COLS:
            row[f"_fix_{c}"] = col_fixes.get(c)  # None = no correction for this col
        fix_rows.append(row)

    fix_df  = spark.createDataFrame(fix_rows, schema=fix_schema)
    cleaned = cleaned.join(broadcast(fix_df), "_row_id", "left")

    for c in CORRECTABLE_COLS:
        fc = f"_fix_{c}"
        if c in cleaned.columns and fc in cleaned.columns:
            # _fix_<col> is non-null only when the LLM provided a replacement value
            cleaned = cleaned.withColumn(
                c,
                F.when(F.col(fc).isNotNull(), F.col(fc)).otherwise(F.col(c)),
            )

    cleaned = cleaned.drop(*[f"_fix_{c}" for c in CORRECTABLE_COLS])
    print(f"Applied LLM corrections to {len(all_corrections):,} rows")

# COMMAND ----------
# ── Phase 3: Enrichment lookups ──────────────────────────────────────────────
#
# All lookup DataFrames use unique column prefixes to avoid ambiguity across
# the multi-table join chain below.

# GeoNames — one row per pincode (precise point)
geo_pin = (
    spark.table(f"{CATALOG}.{SCHEMA}.geonames_pincodes")
    .select(
        F.col("pincode").alias("gp_pin"),
        F.col("state").alias("gp_state"),
        F.col("district").alias("gp_district"),
        F.col("place_name").alias("gp_city"),
        F.col("latitude").cast("double").alias("gp_lat"),
        F.col("longitude").cast("double").alias("gp_lon"),
    )
    .dropDuplicates(["gp_pin"])
)

# GeoNames — city centroid (fallback when only city name is known)
geo_city = (
    spark.table(f"{CATALOG}.{SCHEMA}.geonames_pincodes")
    .groupBy(
        F.trim(F.lower(F.regexp_replace(F.col("place_name"), r"\d{6}", ""))).alias("gc_city_key")
    )
    .agg(
        F.avg(F.col("latitude").cast("double")).alias("gc_lat"),
        F.avg(F.col("longitude").cast("double")).alias("gc_lon"),
    )
    .filter(F.col("gc_city_key").isNotNull() & (F.col("gc_city_key") != ""))
)

# Pincode lookup — canonical state / district from India Post
pin_lkp = (
    spark.table(f"{CATALOG}.{SCHEMA}.postalpincode_lookup")
    .select(
        F.col("pincode").alias("pl_pin"),
        F.col("state").alias("pl_state"),
        F.col("district").alias("pl_district"),
    )
    .dropDuplicates(["pl_pin"])
)

# Wikidata — GPS for known Indian hospitals by name
wiki_lkp = (
    spark.table(f"{CATALOG}.{SCHEMA}.wikidata_hospitals")
    .filter(F.col("latitude").isNotNull() & F.col("longitude").isNotNull())
    .groupBy(F.lower(F.trim(F.col("name"))).alias("wk_name"))
    .agg(
        F.first(F.col("latitude").cast("double"),  ignorenulls=True).alias("wk_lat"),
        F.first(F.col("longitude").cast("double"), ignorenulls=True).alias("wk_lon"),
    )
    .filter(F.col("wk_name").isNotNull())
)

# OSM / Overture-derived — GPS by name + state (name-only would have too many false positives)
osm_lkp = (
    spark.table(f"{CATALOG}.{SCHEMA}.osm_india_facilities")
    .filter(F.col("latitude").isNotNull() & F.col("name").isNotNull())
    .groupBy(
        F.lower(F.trim(F.col("name"))).alias("om_name"),
        F.lower(F.trim(F.col("addr_state"))).alias("om_state"),
    )
    .agg(
        F.first(F.col("latitude").cast("double"),  ignorenulls=True).alias("om_lat"),
        F.first(F.col("longitude").cast("double"), ignorenulls=True).alias("om_lon"),
        F.first(F.col("addr_city"), ignorenulls=True).alias("om_city"),
    )
)

# Overture Maps — GPS by name + state
ov_lkp = (
    spark.table(f"{CATALOG}.{SCHEMA}.overture_india_places")
    .filter(F.col("latitude").isNotNull() & F.col("name").isNotNull())
    .groupBy(
        F.lower(F.trim(F.col("name"))).alias("ov_name"),
        F.lower(F.trim(F.col("state"))).alias("ov_state"),
    )
    .agg(
        F.first(F.col("latitude").cast("double"),  ignorenulls=True).alias("ov_lat"),
        F.first(F.col("longitude").cast("double"), ignorenulls=True).alias("ov_lon"),
        F.first(F.col("city"), ignorenulls=True).alias("ov_city"),
    )
)

# COMMAND ----------
# ── Phase 3b: State alias map ────────────────────────────────────────────────
#
# Resolves historic names, misspellings, and casing variants to the canonical
# form used in NFHS-5 (the `state_ut` column in nfhs_5_district_health_indicators).

STATE_ALIASES = broadcast(spark.createDataFrame([
    ("orissa",                        "Odisha"),
    ("uttaranchal",                   "Uttarakhand"),
    ("pondicherry",                   "Puducherry"),
    ("nct of delhi",                  "Delhi"),
    ("new delhi",                     "Delhi"),
    ("jammu and kashmir",             "Jammu & Kashmir"),
    ("j&k",                           "Jammu & Kashmir"),
    ("chattisgarh",                   "Chhattisgarh"),
    ("dadra and nagar haveli",        "Dadra & Nagar Haveli and Daman & Diu"),
    ("daman and diu",                 "Dadra & Nagar Haveli and Daman & Diu"),
    ("andaman and nicobar islands",   "Andaman & Nicobar Islands"),
    ("a&n islands",                   "Andaman & Nicobar Islands"),
    ("d&n haveli",                    "Dadra & Nagar Haveli and Daman & Diu"),
    ("telengana",                     "Telangana"),
], ["sa_key", "sa_canonical"]))

# COMMAND ----------
# ── Phase 3c: Join keys + enrichment joins ───────────────────────────────────

df = (
    cleaned
    # Extract 6-digit pincode embedded in address_city ("Bandra West 400050" → "400050")
    .withColumn(
        "_pin",
        F.when(
            F.length(F.regexp_extract(F.col("address_city"), r"(\d{6})", 1)) == 6,
            F.regexp_extract(F.col("address_city"), r"(\d{6})", 1),
        ),
    )
    .withColumn("_name_key",  F.lower(F.trim(F.col("name"))))
    .withColumn("_state_key", F.lower(F.trim(F.col("address_stateorregion"))))
    # City key strips embedded pincode before matching GeoNames place_name
    .withColumn(
        "_city_key",
        F.trim(F.lower(F.regexp_replace(F.col("address_city"), r"\d{6}", ""))),
    )
)

# State alias resolution → state_canonical
df = (
    df
    .join(STATE_ALIASES, df["_state_key"] == F.col("sa_key"), "left")
    .withColumn(
        "state_canonical",
        F.coalesce(F.col("sa_canonical"), F.initcap(F.col("address_stateorregion"))),
    )
    .drop("sa_key", "sa_canonical")
)

# Pincode-based joins (broadcast — small lookup tables)
df = df.join(broadcast(geo_pin),  df["_pin"] == geo_pin["gp_pin"],   "left").drop("gp_pin")
df = df.join(broadcast(pin_lkp),  df["_pin"] == pin_lkp["pl_pin"],   "left").drop("pl_pin")

# City-centroid join
df = df.join(geo_city, df["_city_key"] == geo_city["gc_city_key"], "left").drop("gc_city_key")

# Name-based GPS (broadcast wikidata — ~2.5K rows)
df = df.join(broadcast(wiki_lkp), df["_name_key"] == wiki_lkp["wk_name"], "left").drop("wk_name")

# Name + state GPS — OSM and Overture
df = (
    df
    .join(osm_lkp, (df["_name_key"] == osm_lkp["om_name"]) & (df["_state_key"] == osm_lkp["om_state"]), "left")
    .drop("om_name", "om_state")
)
df = (
    df
    .join(ov_lkp, (df["_name_key"] == ov_lkp["ov_name"]) & (df["_state_key"] == ov_lkp["ov_state"]), "left")
    .drop("ov_name", "ov_state")
)

# COMMAND ----------
# ── Phase 3d: Coalesce enriched values ──────────────────────────────────────

df = (
    df
    # Coords: valid original → Wikidata → OSM → Overture → GeoNames-pin → GeoNames-city
    .withColumn("latitude",  F.coalesce("_lat_ok", "wk_lat", "om_lat", "ov_lat", "gp_lat", "gc_lat"))
    .withColumn("longitude", F.coalesce("_lon_ok", "wk_lon", "om_lon", "ov_lon", "gp_lon", "gc_lon"))
    # Backfill address_city: OSM → Overture → GeoNames-pin
    .withColumn(
        "address_city",
        F.coalesce(F.col("address_city"), F.col("om_city"), F.col("ov_city"), F.col("gp_city")),
    )
    # Backfill address_stateorregion: GeoNames-pin → pincode-lookup
    .withColumn(
        "address_stateorregion",
        F.coalesce(F.col("address_stateorregion"), F.col("gp_state"), F.col("pl_state")),
    )
    # New: district for NFHS district-level joins
    .withColumn("address_district", F.coalesce(F.col("pl_district"), F.col("gp_district")))
    # Coordinate provenance
    .withColumn(
        "coord_source",
        F.when(F.col("_lat_ok").isNotNull(),  "original")
        .when(F.col("wk_lat").isNotNull(),    "wikidata")
        .when(F.col("om_lat").isNotNull(),    "osm")
        .when(F.col("ov_lat").isNotNull(),    "overture")
        .when(F.col("gp_lat").isNotNull(),    "geonames_pin")
        .when(F.col("gc_lat").isNotNull(),    "geonames_city")
        .otherwise("none"),
    )
)

# COMMAND ----------
# ── Final column selection ───────────────────────────────────────────────────
#
# Original columns (cleaned in-place) + three new enrichment columns.
# All internal join-key and working columns (_row_id, _pin, _lat_ok, etc.)
# are excluded because they are not listed.

ORIGINAL_COLS = [c for c in fac.columns if c not in ("latitude", "longitude")]
ENRICH_COLS   = ["address_district", "state_canonical", "coord_source"]

final = df.select(
    *[F.col(c) for c in ORIGINAL_COLS],
    F.col("latitude").cast("double"),
    F.col("longitude").cast("double"),
    *[F.col(c) for c in ENRICH_COLS],
)

# COMMAND ----------
# ── Write silver table ───────────────────────────────────────────────────────

final.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(OUT)

result = spark.table(OUT)
total  = result.count()
print(f"✓ {OUT}  rows={total:,}")

print("\nCoordinate source breakdown:")
result.groupBy("coord_source").count().orderBy(F.desc("count")).show(truncate=False)

null_lat      = result.filter(F.col("latitude").isNull()).count()
null_state    = result.filter(F.col("state_canonical").isNull()).count()
null_city     = result.filter(F.col("address_city").isNull()).count()
null_district = result.filter(F.col("address_district").isNull()).count()
print(f"NULL latitude after enrichment:   {null_lat:,} / {total:,}  ({100*null_lat/total:.1f}%)")
print(f"NULL state_canonical:              {null_state:,} / {total:,}  ({100*null_state/total:.1f}%)")
print(f"NULL address_city after backfill:  {null_city:,} / {total:,}  ({100*null_city/total:.1f}%)")
print(f"NULL address_district:             {null_district:,} / {total:,}  ({100*null_district/total:.1f}%)")
print(f"\nLLM column-alignment corrections applied: {len(all_corrections):,}")
