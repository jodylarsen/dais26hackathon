# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: AERB Licensed Facilities
# MAGIC
# MAGIC **Manual prerequisite — upload the file before running this job:**
# MAGIC 1. Download the AERB licensed facility list from aerb.gov.in (Excel or CSV)
# MAGIC 2. Upload to the Unity Catalog Volume:
# MAGIC    ```
# MAGIC    /Volumes/dais27hack/virtue_foundation_dataset_silver/enrichment_uploads/aerb_licensed.xlsx
# MAGIC    ```
# MAGIC    (`.xls` and `.csv` are also accepted)
# MAGIC 3. Run this job.
# MAGIC
# MAGIC Writes `dais27hack.virtue_foundation_dataset_silver.aerb_licensed`.

# COMMAND ----------

import pandas as pd
from pathlib import Path

CATALOG    = "dais27hack"
SCHEMA     = "virtue_foundation_dataset_silver"
TABLE      = "aerb_licensed"
FQTN       = f"{CATALOG}.{SCHEMA}.{TABLE}"
VOLUME_DIR = f"/Volumes/{CATALOG}/{SCHEMA}/enrichment_uploads"

pdf = None
for ext in ("xlsx", "xls", "csv"):
    path = f"{VOLUME_DIR}/aerb_licensed.{ext}"
    if Path(path).exists():
        print(f"Found {path}")
        pdf = (
            pd.read_excel(path, engine="openpyxl") if ext in ("xlsx", "xls")
            else pd.read_csv(path)
        )
        break

if pdf is None:
    raise FileNotFoundError(
        f"Upload aerb_licensed.xlsx (or .xls/.csv) to {VOLUME_DIR} first"
    )

print(f"Shape: {pdf.shape}  Columns: {list(pdf.columns)}")

# COMMAND ----------

pdf.columns = [c.lower().strip().replace(" ", "_").replace("/", "_") for c in pdf.columns]
pdf = pdf.dropna(how="all")

df = spark.createDataFrame(pdf)
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
print("Next: JOIN to facilities on name+state to append 'aerb' to source_types")
