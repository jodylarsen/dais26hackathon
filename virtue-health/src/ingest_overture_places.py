# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: Overture Maps Places — India Healthcare
# MAGIC Reads the Overture Maps 2026-05-20.0 places Parquet from the public S3 bucket,
# MAGIC filters to India's bounding box + healthcare categories, and writes `overture_india_places`.
# MAGIC Runs serverless — no credential config needed for the public bucket.

# COMMAND ----------

# Public S3 bucket — no credential config needed on serverless
# (spark.hadoop.* confs are blocked; the workspace IAM role handles public bucket access)

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
TABLE   = "overture_india_places"
FQTN    = f"{CATALOG}.{SCHEMA}.{TABLE}"
S3_PATH = "s3://overturemaps-us-west-2/release/2026-05-20.0/theme=places/type=place/"

LAT_MIN, LAT_MAX = 6.0, 37.5
LON_MIN, LON_MAX = 68.0, 97.5

HEALTH_KEYWORDS = [
    "health", "hospital", "clinic", "medical",
    "pharmacy", "dentist", "doctor", "nursing", "diagnostic",
]

# COMMAND ----------

# Sample schema to verify column names for this release
raw = spark.read.format("parquet").load(S3_PATH)
raw.printSchema()

# COMMAND ----------

category_filter = " OR ".join(
    f"lower(categories.primary) LIKE '%{kw}%'" for kw in HEALTH_KEYWORDS
)

df = (
    raw
    .filter(f"bbox.ymin >= {LAT_MIN} AND bbox.ymax <= {LAT_MAX}")
    .filter(f"bbox.xmin >= {LON_MIN} AND bbox.xmax <= {LON_MAX}")
    .filter(category_filter)
    .selectExpr(
        "id",
        "names.primary              AS name",
        "categories.primary         AS category_primary",
        "CAST(bbox.xmin AS DOUBLE)  AS longitude",
        "CAST(bbox.ymin AS DOUBLE)  AS latitude",
        "confidence",
        "addresses[0].country       AS country",
        "addresses[0].region        AS state",
        "addresses[0].locality      AS city",
        "sources[0].dataset         AS source_dataset",
    )
)

df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
