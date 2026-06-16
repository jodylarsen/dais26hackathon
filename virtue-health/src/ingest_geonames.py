# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: GeoNames India Postal Codes
# MAGIC Downloads `IN.zip` (~42K pincodes with lat/lon centroids) from geonames.org
# MAGIC and writes `dais27hack.virtue_foundation_dataset_silver.geonames_pincodes`.
# MAGIC No credentials required. Full replace on each run.

# COMMAND ----------

import io
import urllib.request
import zipfile
from pyspark.sql.types import DoubleType, IntegerType, StringType, StructField, StructType

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
TABLE   = "geonames_pincodes"
FQTN    = f"{CATALOG}.{SCHEMA}.{TABLE}"
URL     = "https://download.geonames.org/export/zip/IN.zip"

print(f"Downloading {URL} ...")
with urllib.request.urlopen(URL) as resp:
    zip_bytes = io.BytesIO(resp.read())
print("Download complete.")

# COMMAND ----------

# GeoNames tab-separated columns (IN.txt):
# 0 country_code  1 postal_code  2 place_name
# 3 admin_name1 (state)  4 admin_code1
# 5 admin_name2 (district)  6 admin_code2
# 7 admin_name3 (taluka)   8 admin_code3
# 9 latitude  10 longitude  11 accuracy (1=estimated, 4=geonames, 6=centroid)

rows, skipped = [], 0
with zipfile.ZipFile(zip_bytes) as z:
    with z.open("IN.txt") as f:
        for line in f.read().decode("utf-8").strip().split("\n"):
            parts = line.split("\t")
            if len(parts) < 11:
                skipped += 1
                continue
            try:
                rows.append((
                    parts[1].zfill(6),
                    parts[2] or None,
                    parts[3] or None,
                    parts[5] or None,
                    parts[7] or None,
                    float(parts[9]),
                    float(parts[10]),
                    int(parts[11]) if len(parts) > 11 and parts[11].strip().isdigit() else None,
                ))
            except (ValueError, IndexError):
                skipped += 1

print(f"Parsed {len(rows):,} rows, skipped {skipped}")

# COMMAND ----------

SCHEMA_DEF = StructType([
    StructField("pincode",    StringType(),  False),
    StructField("place_name", StringType(),  True),
    StructField("state",      StringType(),  True),
    StructField("district",   StringType(),  True),
    StructField("taluka",     StringType(),  True),
    StructField("latitude",   DoubleType(),  True),
    StructField("longitude",  DoubleType(),  True),
    StructField("accuracy",   IntegerType(), True),
])

df = spark.createDataFrame(rows, schema=SCHEMA_DEF)
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
