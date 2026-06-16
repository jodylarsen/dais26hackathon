# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: NHM HMIS State-Level Coverage
# MAGIC
# MAGIC **Manual prerequisite — upload the file before running this job:**
# MAGIC 1. Download the HMIS Annual Report Excel from nhm.gov.in
# MAGIC    (if hmis.nhp.gov.in is unreachable, try nhm.gov.in → Data & Reports → HMIS)
# MAGIC 2. Upload to the Unity Catalog Volume:
# MAGIC    ```
# MAGIC    /Volumes/dais27hack/virtue_foundation_dataset_silver/enrichment_uploads/hmis_coverage.xlsx
# MAGIC    ```
# MAGIC 3. Adjust `HEADER_ROW` below if the Excel has multi-row headers (common in HMIS reports).
# MAGIC 4. Run this job.
# MAGIC
# MAGIC Writes `dais27hack.virtue_foundation_dataset_silver.hmis_coverage` with state-level
# MAGIC DH / SDH / CHC / PHC / Sub-centre counts for coverage-gap analysis.

# COMMAND ----------

import pandas as pd

CATALOG     = "dais27hack"
SCHEMA      = "virtue_foundation_dataset_silver"
TABLE       = "hmis_coverage"
FQTN        = f"{CATALOG}.{SCHEMA}.{TABLE}"
VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/enrichment_uploads/hmis_coverage.xlsx"
HEADER_ROW  = 0  # adjust if HMIS Excel uses multi-row headers (try 1, 2, 3)

print(f"Reading {VOLUME_PATH}")
pdf = pd.read_excel(VOLUME_PATH, engine="openpyxl", header=HEADER_ROW)
print(f"Shape: {pdf.shape}")
print(f"Columns (first 10): {list(pdf.columns[:10])}")
pdf.head(3)

# COMMAND ----------

pdf.columns = [
    str(c).lower().strip().replace(" ", "_").replace("/", "_").replace(".", "_")
    for c in pdf.columns
]
pdf = pdf.dropna(how="all")

df = spark.createDataFrame(pdf)
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
print("Next: compare state counts vs facilities table to compute coverage gap %")
