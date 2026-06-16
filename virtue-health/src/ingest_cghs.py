# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: CGHS Empanelled Hospitals
# MAGIC
# MAGIC **Manual prerequisite — upload the file before running this job:**
# MAGIC 1. Download the CGHS empanelled hospital list from cghs.gov.in (quarterly Excel)
# MAGIC 2. Upload to the Unity Catalog Volume:
# MAGIC    ```
# MAGIC    /Volumes/dais27hack/virtue_foundation_dataset_silver/enrichment_uploads/cghs_empanelled.xlsx
# MAGIC    ```
# MAGIC 3. Run this job (or trigger via Databricks UI).
# MAGIC
# MAGIC Writes `dais27hack.virtue_foundation_dataset_silver.cghs_empanelled`.

# COMMAND ----------

import pandas as pd

CATALOG     = "dais27hack"
SCHEMA      = "virtue_foundation_dataset_silver"
TABLE       = "cghs_empanelled"
FQTN        = f"{CATALOG}.{SCHEMA}.{TABLE}"
VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/enrichment_uploads/cghs_empanelled.xlsx"

print(f"Reading {VOLUME_PATH}")
pdf = pd.read_excel(VOLUME_PATH, engine="openpyxl")
print(f"Shape: {pdf.shape}")
print(f"Columns: {list(pdf.columns)}")
pdf.head(3)

# COMMAND ----------

pdf.columns = [c.lower().strip().replace(" ", "_").replace("/", "_") for c in pdf.columns]
pdf = pdf.dropna(how="all")

df = spark.createDataFrame(pdf)
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
print("Next: JOIN to facilities on name+state to append 'cghs' to source_types")
