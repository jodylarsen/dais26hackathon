# Databricks notebook — copy silver/gold tables from deepak-workspace to this workspace
# Run this on jody-free-workspace; it reads deepak via REST API and writes to local UC catalog

import requests
import os
import json
import pandas as pd
import time
from pyspark.sql.types import (
    StructType, StructField, StringType, LongType, IntegerType, ShortType, ByteType,
    DoubleType, FloatType, BooleanType, DateType, TimestampType, BinaryType
)
from pyspark.sql.functions import col, to_timestamp, to_date

DEEPAK_HOST = "https://dbc-0a01f518-764a.cloud.databricks.com"
DEEPAK_TOKEN = os.environ["DEEPAK_TOKEN"]  # set via env; do not hardcode
DEEPAK_WH = "5b2b29cce22aa2c4"

TABLES = [
    ("workspace", "gold_virtue_foundation", "facilities_gold"),
    ("workspace", "gold_virtue_foundation", "india_post_pincode_directory_gold"),
    ("workspace", "gold_virtue_foundation", "nfhs_5_district_health_indicators_gold"),
    ("workspace", "gold_virtue_foundation_dataset", "anomaly_alerts"),
    ("workspace", "gold_virtue_foundation_dataset", "district_health_context"),
    ("workspace", "gold_virtue_foundation_dataset", "facility_trust_scores"),
    ("workspace", "silver_virtue_foundation", "facilities_bronze"),
    ("workspace", "silver_virtue_foundation", "facilities_silver"),
    ("workspace", "silver_virtue_foundation", "facility_capability_summary"),
    ("workspace", "silver_virtue_foundation", "facility_trust_scores"),
    ("workspace", "silver_virtue_foundation", "india_post_pincode_directory_bronze"),
    ("workspace", "silver_virtue_foundation", "india_post_pincode_directory_silver"),
    ("workspace", "silver_virtue_foundation", "nfhs_5_district_health_indicators_bronze"),
    ("workspace", "silver_virtue_foundation", "nfhs_5_district_health_indicators_silver"),
]

HEADERS = {
    "Authorization": f"Bearer {DEEPAK_TOKEN}",
    "Content-Type": "application/json",
}

SPARK_TYPE_MAP = {
    "STRING": StringType(),
    "BIGINT": LongType(),
    "LONG": LongType(),
    "INT": IntegerType(),
    "INTEGER": IntegerType(),
    "SMALLINT": ShortType(),
    "TINYINT": ByteType(),
    "DOUBLE": DoubleType(),
    "FLOAT": FloatType(),
    "BOOLEAN": BooleanType(),
    "DATE": StringType(),        # read as string, cast after
    "TIMESTAMP": StringType(),   # read as string, cast after
    "TIMESTAMP_NTZ": StringType(),
    "BINARY": BinaryType(),
}


def sql_submit(statement):
    resp = requests.post(
        f"{DEEPAK_HOST}/api/2.0/sql/statements",
        headers=HEADERS,
        json={
            "statement": statement,
            "warehouse_id": DEEPAK_WH,
            "wait_timeout": "50s",
            "format": "JSON_ARRAY",
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def sql_poll(stmt_id):
    for _ in range(600):
        resp = requests.get(
            f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}",
            headers=HEADERS,
            timeout=30,
        )
        r = resp.json()
        state = r.get("status", {}).get("state", "")
        if state in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
            return r
        time.sleep(2)
    raise TimeoutError(f"Statement {stmt_id} did not complete")


def sql_chunk(stmt_id, chunk_index):
    resp = requests.get(
        f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}/result/chunks/{chunk_index}",
        headers=HEADERS,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def sql_run(statement):
    """Submit a SQL statement and return the completed result dict."""
    r = sql_submit(statement)
    state = r.get("status", {}).get("state", "")
    if state == "PENDING" or state == "RUNNING":
        r = sql_poll(r["statement_id"])
    if r.get("status", {}).get("state") != "SUCCEEDED":
        raise RuntimeError(f"SQL failed: {r.get('status')}\nStatement: {statement[:200]}")
    return r


def cast_pdf_column(series, type_name):
    tn = type_name.upper()
    try:
        if tn in ("BIGINT", "LONG"):
            return pd.to_numeric(series, errors="coerce").astype("Int64")
        if tn in ("INT", "INTEGER"):
            return pd.to_numeric(series, errors="coerce").astype("Int32")
        if tn == "SMALLINT":
            return pd.to_numeric(series, errors="coerce").astype("Int16")
        if tn == "TINYINT":
            return pd.to_numeric(series, errors="coerce").astype("Int8")
        if tn in ("DOUBLE", "FLOAT"):
            return pd.to_numeric(series, errors="coerce")
        if tn == "BOOLEAN":
            return series.map(lambda x: (x == "true") if x is not None else None)
    except Exception:
        pass
    return series  # leave as string for other types


def write_batch(cat, sch, tbl, columns, type_names, rows, first):
    pdf = pd.DataFrame(rows, columns=columns)
    for c, t in zip(columns, type_names):
        pdf[c] = cast_pdf_column(pdf[c], t)

    spark_schema = StructType([
        StructField(c, SPARK_TYPE_MAP.get(t.upper(), StringType()), True)
        for c, t in zip(columns, type_names)
    ])
    sdf = spark.createDataFrame(pdf, schema=spark_schema)

    # Cast date/timestamp columns
    for c, t in zip(columns, type_names):
        tn = t.upper()
        if tn in ("TIMESTAMP", "TIMESTAMP_NTZ"):
            sdf = sdf.withColumn(c, to_timestamp(col(c)))
        elif tn == "DATE":
            sdf = sdf.withColumn(c, to_date(col(c)))

    mode = "overwrite" if first else "append"
    (
        sdf.write
        .mode(mode)
        .option("overwriteSchema", "true" if first else "false")
        .saveAsTable(f"{cat}.{sch}.{tbl}")
    )


def copy_table(cat, sch, tbl):
    full_name = f"{cat}.{sch}.{tbl}"
    print(f"\n{'='*60}\nCopying {full_name}")

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {cat}.{sch}")

    r = sql_run(f"SELECT * FROM {full_name}")
    stmt_id = r["statement_id"]
    manifest = r.get("manifest", {})
    schema_cols = manifest.get("schema", {}).get("columns", [])
    total_chunks = manifest.get("total_chunk_count", 1)
    total_rows = manifest.get("total_row_count", 0)

    columns = [c["name"] for c in schema_cols]
    type_names = [c["type_name"] for c in schema_cols]
    print(f"  {total_rows} rows, {total_chunks} chunks, {len(columns)} cols")

    first = True

    # Inline first chunk
    rows = r.get("result", {}).get("data_array", [])
    if rows or total_rows == 0:
        write_batch(cat, sch, tbl, columns, type_names, rows, first)
        first = False
        print(f"  Chunk 0: {len(rows)} rows written")

    # Remaining chunks
    for idx in range(1, total_chunks):
        chunk = sql_chunk(stmt_id, idx)
        rows = chunk.get("data_array", [])
        if rows:
            write_batch(cat, sch, tbl, columns, type_names, rows, first)
            first = False
            print(f"  Chunk {idx}: {len(rows)} rows written")

    print(f"  DONE {full_name}")


errors = []
for cat, sch, tbl in TABLES:
    try:
        copy_table(cat, sch, tbl)
    except Exception as exc:
        import traceback
        msg = f"ERROR {cat}.{sch}.{tbl}: {exc}"
        print(msg)
        traceback.print_exc()
        errors.append(msg)

print("\n\n" + "="*60)
if errors:
    print(f"Completed with {len(errors)} error(s):")
    for e in errors:
        print(f"  {e}")
else:
    print("All tables copied successfully!")
