# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: Wikidata Indian Hospitals (SPARQL)
# MAGIC Queries query.wikidata.org for Indian hospitals (Q16917) with GPS coordinates (P625).
# MAGIC No credentials required. ~2,500 results expected. Full replace on each run.

# COMMAND ----------

import requests
from pyspark.sql.types import DoubleType, StringType, StructField, StructType

CATALOG    = "dais27hack"
SCHEMA     = "virtue_foundation_dataset_silver"
TABLE      = "wikidata_hospitals"
FQTN       = f"{CATALOG}.{SCHEMA}.{TABLE}"
SPARQL_URL = "https://query.wikidata.org/sparql"

QUERY = """
SELECT ?item ?itemLabel ?lat ?lon WHERE {
  ?item wdt:P31  wd:Q16917 .
  ?item wdt:P17  wd:Q668   .
  ?item p:P625   ?coord    .
  ?coord psv:P625 ?val     .
  ?val wikibase:geoLatitude  ?lat .
  ?val wikibase:geoLongitude ?lon .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 10000
"""

print("Querying Wikidata SPARQL ...")
resp = requests.get(
    SPARQL_URL,
    params={"query": QUERY, "format": "json"},
    headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": "virtue-health-hackathon/1.0 (jody.larsen@gmail.com)",
    },
    timeout=90,
)
resp.raise_for_status()
bindings = resp.json()["results"]["bindings"]
print(f"Got {len(bindings):,} results")

# COMMAND ----------

rows = [
    (
        b["item"]["value"].split("/")[-1],
        b.get("itemLabel", {}).get("value"),
        float(b["lat"]["value"]),
        float(b["lon"]["value"]),
    )
    for b in bindings
]

SCHEMA_DEF = StructType([
    StructField("wikidata_id", StringType(), False),
    StructField("name",        StringType(), True),
    StructField("latitude",    DoubleType(), False),
    StructField("longitude",   DoubleType(), False),
])

df = spark.createDataFrame(rows, schema=SCHEMA_DEF)
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written")
