# Databricks notebook source

# COMMAND ----------
# MAGIC %md
# MAGIC ## Ingest: OpenStreetMap Healthcare Facilities (Overpass API)
# MAGIC Queries an Overpass API mirror for all healthcare amenities in India.
# MAGIC Falls back to `overture_india_places` if all mirrors block cloud egress IPs.

# COMMAND ----------

import requests
from pyspark.sql.functions import lit
from pyspark.sql.types import DoubleType, StringType, StructField, StructType

CATALOG = "dais27hack"
SCHEMA  = "virtue_foundation_dataset_silver"
TABLE   = "osm_india_facilities"
FQTN    = f"{CATALOG}.{SCHEMA}.{TABLE}"
BBOX    = "6.0,68.0,37.5,97.5"  # S,W,N,E — India bounding box

# Try mirrors in order; openstreetmap.fr and others block cloud/datacenter egress IPs
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]

QUERY = f"""
[out:json][timeout:300][maxsize:2147483648];
(
  node["amenity"~"^(hospital|clinic|doctors|pharmacy|dentist|health_centre)$"]({BBOX});
  way["amenity"~"^(hospital|clinic|doctors|pharmacy|dentist|health_centre)$"]({BBOX});
  node["healthcare"]({BBOX});
  way["healthcare"]({BBOX});
);
out center tags;
"""

# COMMAND ----------

elements = None
for mirror in OVERPASS_MIRRORS:
    try:
        print(f"Trying {mirror} ...")
        resp = requests.post(mirror, data={"data": QUERY}, timeout=360)
        resp.raise_for_status()
        elements = resp.json().get("elements", [])
        print(f"✓ Got {len(elements):,} OSM elements from {mirror}")
        break
    except Exception as e:
        print(f"  ✗ {mirror}: {e}")

# COMMAND ----------

OSM_SCHEMA = StructType([
    StructField("osm_id",     StringType(), False),
    StructField("osm_type",   StringType(), True),
    StructField("latitude",   DoubleType(), True),
    StructField("longitude",  DoubleType(), True),
    StructField("name",       StringType(), True),
    StructField("name_en",    StringType(), True),
    StructField("amenity",    StringType(), True),
    StructField("healthcare", StringType(), True),
    StructField("operator",   StringType(), True),
    StructField("beds",       StringType(), True),
    StructField("emergency",  StringType(), True),
    StructField("addr_city",  StringType(), True),
    StructField("addr_state", StringType(), True),
])

if elements is not None:
    rows = []
    for el in elements:
        tags = el.get("tags", {})
        lat  = el.get("lat") or el.get("center", {}).get("lat")
        lon  = el.get("lon") or el.get("center", {}).get("lon")
        rows.append((
            str(el["id"]),
            el.get("type"),
            float(lat) if lat is not None else None,
            float(lon) if lon is not None else None,
            tags.get("name"),
            tags.get("name:en"),
            tags.get("amenity"),
            tags.get("healthcare"),
            tags.get("operator"),
            tags.get("beds"),
            tags.get("emergency"),
            tags.get("addr:city"),
            tags.get("addr:state"),
        ))
    df = spark.createDataFrame(rows, schema=OSM_SCHEMA)
    source_label = "overpass"
else:
    # All Overpass mirrors blocked from cloud egress — derive from Overture Maps (OSM-based)
    OVERTURE_FQTN = f"{CATALOG}.{SCHEMA}.overture_india_places"
    print(f"All Overpass mirrors blocked — building {TABLE} from {OVERTURE_FQTN}")
    df = (
        spark.table(OVERTURE_FQTN)
        .selectExpr(
            "id                          AS osm_id",
            "'overture'                  AS osm_type",
            "latitude",
            "longitude",
            "name",
            "name                        AS name_en",
            "category_primary            AS amenity",
            "category_primary            AS healthcare",
            "CAST(NULL AS STRING)        AS operator",
            "CAST(NULL AS STRING)        AS beds",
            "CAST(NULL AS STRING)        AS emergency",
            "city                        AS addr_city",
            "state                       AS addr_state",
        )
    )
    source_label = "overture_fallback"

df = df.withColumn("source_label", lit(source_label))
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(FQTN)

count = spark.table(FQTN).count()
print(f"✓ {FQTN} — {count:,} rows written (source: {source_label})")
