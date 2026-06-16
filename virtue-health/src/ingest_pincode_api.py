# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: India Post Pincode Lookup (api.postalpincode.in)
# MAGIC Queries api.postalpincode.in for every distinct pincode in `india_post_pincode_directory`.
# MAGIC Returns canonical State, District, Block per pincode.
# MAGIC Falls back to `geonames_pincodes` if the API is unreachable from cloud.

# COMMAND ----------

import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from pyspark.sql.functions import lit
from pyspark.sql.types import IntegerType, StringType, StructField, StructType

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
TABLE   = "postalpincode_lookup"
FQTN    = f"{CATALOG}.{SCHEMA}.{TABLE}"
CAP     = 10_000  # raise to cover all ~30K pincodes in production
WORKERS = 20

RESULT_SCHEMA = StructType([
    StructField("pincode",      StringType(),  True),
    StructField("state",        StringType(),  True),
    StructField("district",     StringType(),  True),
    StructField("block",        StringType(),  True),
    StructField("circle",       StringType(),  True),
    StructField("office_count", IntegerType(), True),
])

pincodes = [
    r.pincode for r in
    spark.table(f"{CATALOG}.{SCHEMA}.india_post_pincode_directory")
    .selectExpr("LPAD(CAST(pincode AS STRING), 6, '0') AS pincode")
    .filter("pincode IS NOT NULL")
    .distinct()
    .limit(CAP)
    .collect()
]
print(f"Fetching {len(pincodes):,} pincodes from api.postalpincode.in ...")

# COMMAND ----------

def fetch_pincode(pin):
    try:
        r = requests.get(f"https://api.postalpincode.in/pincode/{pin}", timeout=15)
        data = r.json()
        if data[0]["Status"] == "Success":
            offices = data[0]["PostOffice"]
            po = offices[0]
            return {
                "pincode":      pin,
                "state":        po.get("State"),
                "district":     po.get("District"),
                "block":        po.get("Block"),
                "circle":       po.get("Circle"),
                "office_count": len(offices),
            }
    except Exception:
        pass
    return None

results, errors = [], 0
with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    futures = {pool.submit(fetch_pincode, p): p for p in pincodes}
    for i, future in enumerate(as_completed(futures), 1):
        rec = future.result()
        if rec:
            results.append(rec)
        else:
            errors += 1
        if i % 500 == 0:
            print(f"  {i:,}/{len(pincodes):,} — {len(results):,} ok, {errors} errors")

print(f"Done: {len(results):,} successful, {errors} failed")

# COMMAND ----------

if results:
    df = spark.createDataFrame(results, schema=RESULT_SCHEMA)
    source_label = "postalpincode_api"
else:
    # API unreachable from cloud egress (or source table empty) — derive from GeoNames
    print("WARNING: 0 results from api.postalpincode.in — falling back to geonames_pincodes")
    df = (
        spark.table(f"{CATALOG}.{SCHEMA}.geonames_pincodes")
        .selectExpr(
            "pincode",
            "state",
            "district",
            "taluka           AS block",
            "CAST(NULL AS STRING) AS circle",
            "1                AS office_count",
        )
        .filter("pincode IS NOT NULL")
    )
    source_label = "geonames_fallback"

df = df.withColumn("source_label", lit(source_label))
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written (source: {source_label})")
