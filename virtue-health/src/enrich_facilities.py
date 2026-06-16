# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Enrich Facilities: Bronze → Silver
# MAGIC
# MAGIC Reads `facilities` (read-only source), applies quality fixes and coordinate /
# MAGIC address backfill from enrichment tables, writes `facilities_silver`.
# MAGIC
# MAGIC | # | Issue | Fix |
# MAGIC |---|-------|-----|
# MAGIC | 1 | Null bytes (`\x00`) in text fields | `TRANSLATE` strip |
# MAGIC | 2 | Empty strings masquerading as values | `NULLIF(TRIM(…), '')` |
# MAGIC | 3 | Coordinates outside India bounding box | Nullify → re-fill from enrichment |
# MAGIC | 4 | `NULL source_types` → negative trust-weight in scoring | Coalesce → `''` |
# MAGIC | 5 | Inconsistent state name casing / old names | `INITCAP` + alias map → `state_canonical` |
# MAGIC | 6 | Missing `address_city` / `address_stateorregion` | Pincode regex → GeoNames backfill |
# MAGIC | 7 | Missing `address_district` for NFHS district joins | Pincode lookup |
# MAGIC | 8 | Missing / invalid coordinates | Wikidata → OSM → Overture → GeoNames-pin → GeoNames-city |

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.functions import broadcast

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
SRC     = f"{CATALOG}.{SCHEMA}.facilities"
OUT     = f"{CATALOG}.{SCHEMA}.facilities_silver"

INDIA_LAT_MIN, INDIA_LAT_MAX = 6.0,  37.5
INDIA_LON_MIN, INDIA_LON_MAX = 68.0, 97.5

# COMMAND ----------

# Load source
fac = spark.table(SRC)
total_src = fac.count()
print(f"Source: {SRC}  rows={total_src:,}  cols={len(fac.columns)}")

# COMMAND ----------
# ── Step 1: Text cleaning ────────────────────────────────────────────────────
#
# Columns that may contain null bytes (0x00) or should be treated as NULL
# when blank. We translate out the null byte, trim, and convert '' → NULL.

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

# Validate coordinates: cast to DOUBLE and nullify anything outside India
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

n_bad = (
    fac
    .filter(
        F.col("latitude").cast("double").isNotNull()
        & ~F.col("latitude").cast("double").between(INDIA_LAT_MIN, INDIA_LAT_MAX)
    )
    .count()
)
n_null = cleaned.filter(F.col("_lat_ok").isNull()).count()
print(f"Coords outside India bbox (nullified): {n_bad:,}")
print(f"Rows needing coordinate enrichment:     {n_null:,}")

# COMMAND ----------
# ── Step 2: Build enrichment lookup tables ───────────────────────────────────
#
# Every lookup uses a unique column prefix so multi-table joins stay unambiguous.

# GeoNames — one representative row per pincode (for precise point coords)
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

# GeoNames — centroid per city name (fallback when only city is known)
geo_city = (
    spark.table(f"{CATALOG}.{SCHEMA}.geonames_pincodes")
    .groupBy(
        F.lower(F.trim(F.regexp_replace(F.col("place_name"), r"\d{6}", ""))).alias("gc_city_key")
    )
    .agg(
        F.avg(F.col("latitude").cast("double")).alias("gc_lat"),
        F.avg(F.col("longitude").cast("double")).alias("gc_lon"),
    )
    .filter(F.col("gc_city_key").isNotNull() & (F.col("gc_city_key") != ""))
)

# Pincode lookup — canonical state / district from India Post (or GeoNames fallback)
pin_lkp = (
    spark.table(f"{CATALOG}.{SCHEMA}.postalpincode_lookup")
    .select(
        F.col("pincode").alias("pl_pin"),
        F.col("state").alias("pl_state"),
        F.col("district").alias("pl_district"),
    )
    .dropDuplicates(["pl_pin"])
)

# Wikidata — GPS coords for known Indian hospitals, keyed by lowercase name
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

# OSM / Overture-derived — GPS keyed by name + state (reduces false positives vs name-only)
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

# Overture Maps — GPS keyed by name + state
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
# ── Step 3: State alias map ──────────────────────────────────────────────────
#
# Maps historic / misspelled / all-caps state names to the canonical form used
# in NFHS-5 (state_ut column). INITCAP handles the common case of wrong casing.

STATE_ALIASES = broadcast(spark.createDataFrame([
    # old name            → canonical NFHS name
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
# ── Step 4: Add join keys and perform all enrichment joins ───────────────────

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
    # Name key: lowercase + strip non-alphanumeric (for Wikidata) — reuse for OSM/Overture
    .withColumn("_name_key",  F.lower(F.trim(F.col("name"))))
    # State key for OSM/Overture join
    .withColumn("_state_key", F.lower(F.trim(F.col("address_stateorregion"))))
    # City key for GeoNames city-centroid join (strip any embedded pincode first)
    .withColumn(
        "_city_key",
        F.trim(F.lower(F.regexp_replace(F.col("address_city"), r"\d{6}", ""))),
    )
)

# 4a. State alias resolution
df = (
    df
    .join(STATE_ALIASES, df["_state_key"] == F.col("sa_key"), "left")
    .withColumn(
        "state_canonical",
        F.coalesce(F.col("sa_canonical"), F.initcap(F.col("address_stateorregion"))),
    )
    .drop("sa_key", "sa_canonical")
)

# 4b. GeoNames pincode join
df = df.join(broadcast(geo_pin), df["_pin"] == geo_pin["gp_pin"], "left").drop("gp_pin")

# 4c. Pincode lookup (state/district from India Post or GeoNames)
df = df.join(broadcast(pin_lkp), df["_pin"] == pin_lkp["pl_pin"], "left").drop("pl_pin")

# 4d. GeoNames city-centroid join
df = df.join(geo_city, df["_city_key"] == geo_city["gc_city_key"], "left").drop("gc_city_key")

# 4e. Wikidata name-based GPS
df = df.join(broadcast(wiki_lkp), df["_name_key"] == wiki_lkp["wk_name"], "left").drop("wk_name")

# 4f. OSM name+state GPS
df = (
    df
    .join(
        osm_lkp,
        (df["_name_key"] == osm_lkp["om_name"]) & (df["_state_key"] == osm_lkp["om_state"]),
        "left",
    )
    .drop("om_name", "om_state")
)

# 4g. Overture name+state GPS
df = (
    df
    .join(
        ov_lkp,
        (df["_name_key"] == ov_lkp["ov_name"]) & (df["_state_key"] == ov_lkp["ov_state"]),
        "left",
    )
    .drop("ov_name", "ov_state")
)

# COMMAND ----------
# ── Step 5: Coalesce enriched values ────────────────────────────────────────

df = (
    df
    # Coordinates: valid original > Wikidata > OSM > Overture > GeoNames-pin > GeoNames-city
    .withColumn(
        "latitude",
        F.coalesce("_lat_ok", "wk_lat", "om_lat", "ov_lat", "gp_lat", "gc_lat"),
    )
    .withColumn(
        "longitude",
        F.coalesce("_lon_ok", "wk_lon", "om_lon", "ov_lon", "gp_lon", "gc_lon"),
    )
    # Backfill address_city from OSM > Overture > GeoNames pincode lookup
    .withColumn(
        "address_city",
        F.coalesce(F.col("address_city"), F.col("om_city"), F.col("ov_city"), F.col("gp_city")),
    )
    # Backfill address_stateorregion from GeoNames pincode > pincode-lookup
    .withColumn(
        "address_stateorregion",
        F.coalesce(F.col("address_stateorregion"), F.col("gp_state"), F.col("pl_state")),
    )
    # New: district from pincode lookup (preferred) or GeoNames
    .withColumn(
        "address_district",
        F.coalesce(F.col("pl_district"), F.col("gp_district")),
    )
    # Provenance: which source provided the coordinates
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
# ── Step 6: Select final silver columns ─────────────────────────────────────
#
# Keep every original column (cleaned in-place) plus the three new enrichment
# columns. Internal join-key and working columns are excluded by name.

ORIGINAL_COLS = [c for c in fac.columns if c not in ("latitude", "longitude")]
ENRICH_COLS   = ["address_district", "state_canonical", "coord_source"]

final = df.select(
    *[F.col(c) for c in ORIGINAL_COLS],
    F.col("latitude").cast("double"),
    F.col("longitude").cast("double"),
    *[F.col(c) for c in ENRICH_COLS],
)

# COMMAND ----------
# ── Step 7: Write silver table ───────────────────────────────────────────────

final.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(OUT)

result = spark.table(OUT)
total  = result.count()
print(f"✓ {OUT}  rows={total:,}")

# Coordinate source breakdown
print("\nCoordinate source breakdown:")
result.groupBy("coord_source").count().orderBy(F.desc("count")).show(truncate=False)

# Remaining null rates
null_lat      = result.filter(F.col("latitude").isNull()).count()
null_state    = result.filter(F.col("state_canonical").isNull()).count()
null_city     = result.filter(F.col("address_city").isNull()).count()
null_district = result.filter(F.col("address_district").isNull()).count()
print(f"NULL latitude after enrichment:   {null_lat:,} / {total:,}  ({100*null_lat/total:.1f}%)")
print(f"NULL state_canonical:              {null_state:,} / {total:,}  ({100*null_state/total:.1f}%)")
print(f"NULL address_city after backfill:  {null_city:,} / {total:,}  ({100*null_city/total:.1f}%)")
print(f"NULL address_district:             {null_district:,} / {total:,}  ({100*null_district/total:.1f}%)")
