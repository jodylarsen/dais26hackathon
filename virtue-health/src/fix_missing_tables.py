# Targeted fix notebook — re-copy 3 tables that had issues
# Run on jody-free-workspace

import requests
import os
import json
import pandas as pd
import time
from pyspark.sql import Row
from pyspark.sql.types import (
    StructType, StructField, StringType, LongType, IntegerType, ShortType,
    DoubleType, FloatType, BooleanType, DecimalType
)
from pyspark.sql.functions import col, to_timestamp, to_date
from decimal import Decimal, InvalidOperation

DEEPAK_HOST = "https://dbc-0a01f518-764a.cloud.databricks.com"
DEEPAK_TOKEN = os.environ["DEEPAK_TOKEN"]  # set via env; do not hardcode
DEEPAK_WH = "5b2b29cce22aa2c4"

# Tables to fix
TABLES = [
    ("workspace", "gold_virtue_foundation", "facilities_gold"),
    ("workspace", "silver_virtue_foundation", "facility_trust_scores"),
    ("workspace", "gold_virtue_foundation_dataset", "facility_trust_scores"),
]

HEADERS = {
    "Authorization": f"Bearer {DEEPAK_TOKEN}",
    "Content-Type": "application/json",
}

# Map type_name from API to Spark type
def get_spark_type(type_name, type_text):
    tn = type_name.upper()
    if tn == "DECIMAL":
        # parse precision/scale from type_text like "DECIMAL(15,2)"
        try:
            parts = type_text.replace("DECIMAL(", "").replace(")", "").split(",")
            return DecimalType(int(parts[0]), int(parts[1]))
        except Exception:
            return DecimalType(38, 18)
    return {
        "STRING": StringType(),
        "LONG": LongType(),
        "BIGINT": LongType(),
        "INT": IntegerType(),
        "INTEGER": IntegerType(),
        "SMALLINT": ShortType(),
        "DOUBLE": DoubleType(),
        "FLOAT": FloatType(),
        "BOOLEAN": BooleanType(),
        "DATE": StringType(),       # cast later
        "TIMESTAMP": StringType(),  # cast later
        "TIMESTAMP_NTZ": StringType(),
    }.get(tn, StringType())


def sql_submit(statement):
    resp = requests.post(
        f"{DEEPAK_HOST}/api/2.0/sql/statements",
        headers=HEADERS,
        json={
            "statement": statement,
            "warehouse_id": DEEPAK_WH,
            "wait_timeout": "30s",
            "format": "JSON_ARRAY",
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def sql_poll(stmt_id, max_secs=1800):
    deadline = time.time() + max_secs
    while time.time() < deadline:
        resp = requests.get(
            f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}",
            headers=HEADERS,
            timeout=30,
        )
        r = resp.json()
        state = r.get("status", {}).get("state", "")
        if state in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
            return r
        time.sleep(3)
    raise TimeoutError(f"Statement {stmt_id} timed out after {max_secs}s")


def sql_run(statement):
    r = sql_submit(statement)
    state = r.get("status", {}).get("state", "")
    if state in ("PENDING", "RUNNING"):
        r = sql_poll(r["statement_id"])
    if r.get("status", {}).get("state") != "SUCCEEDED":
        raise RuntimeError(f"SQL FAILED: {r.get('status')} | {statement[:200]}")
    return r


def fetch_chunk(stmt_id, chunk_index):
    resp = requests.get(
        f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}/result/chunks/{chunk_index}",
        headers=HEADERS,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json().get("data_array", [])


def safe_decimal(val, scale):
    if val is None:
        return None
    try:
        return Decimal(str(val)).quantize(Decimal(10) ** -scale)
    except InvalidOperation:
        return None


def make_row(raw_row, columns, schema_info):
    """Convert a list of string values to a Row with proper Python types."""
    d = {}
    for i, (col_name, (type_name, type_text)) in enumerate(zip(columns, schema_info)):
        val = raw_row[i] if i < len(raw_row) else None
        tn = type_name.upper()
        try:
            if val is None or val == "":
                d[col_name] = None
            elif tn in ("LONG", "BIGINT"):
                d[col_name] = int(val)
            elif tn in ("INT", "INTEGER"):
                d[col_name] = int(val)
            elif tn == "SMALLINT":
                d[col_name] = int(val)
            elif tn in ("DOUBLE", "FLOAT"):
                d[col_name] = float(val)
            elif tn == "DECIMAL":
                try:
                    parts = type_text.replace("DECIMAL(", "").replace(")", "").split(",")
                    scale = int(parts[1]) if len(parts) > 1 else 2
                except Exception:
                    scale = 2
                d[col_name] = safe_decimal(val, scale)
            elif tn == "BOOLEAN":
                d[col_name] = (str(val).lower() == "true")
            else:
                d[col_name] = str(val) if val is not None else None
        except Exception:
            d[col_name] = None
    return Row(**d)


def write_rows_to_table(cat, sch, tbl, spark_schema, schema_info, columns, rows, first):
    if not rows and not first:
        return
    row_objs = [make_row(r, columns, schema_info) for r in rows]
    sdf = spark.createDataFrame(row_objs, schema=spark_schema)

    # Cast date/timestamp string columns
    for col_name, (type_name, _) in zip(columns, schema_info):
        tn = type_name.upper()
        if tn in ("TIMESTAMP", "TIMESTAMP_NTZ"):
            sdf = sdf.withColumn(col_name, to_timestamp(col(col_name)))
        elif tn == "DATE":
            sdf = sdf.withColumn(col_name, to_date(col(col_name)))

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
    cols_info = manifest.get("schema", {}).get("columns", [])
    total_chunks = manifest.get("total_chunk_count", 1)
    total_rows = manifest.get("total_row_count", 0)

    columns = [c["name"] for c in cols_info]
    schema_info = [(c["type_name"], c.get("type_text", c["type_name"])) for c in cols_info]

    spark_schema = StructType([
        StructField(c["name"], get_spark_type(c["type_name"], c.get("type_text", c["type_name"])), True)
        for c in cols_info
    ])

    print(f"  {total_rows} rows, {total_chunks} chunks")

    first = True

    # First chunk (inline)
    inline_rows = r.get("result", {}).get("data_array", [])
    write_rows_to_table(cat, sch, tbl, spark_schema, schema_info, columns, inline_rows, first)
    print(f"  Chunk 0: {len(inline_rows)} rows → {full_name} (overwrite)")
    first = False

    # Remaining chunks
    for idx in range(1, total_chunks):
        chunk_rows = fetch_chunk(stmt_id, idx)
        if chunk_rows:
            write_rows_to_table(cat, sch, tbl, spark_schema, schema_info, columns, chunk_rows, first)
            print(f"  Chunk {idx}: {len(chunk_rows)} rows appended")

    # Verify
    actual = spark.sql(f"SELECT COUNT(*) AS n FROM {full_name}").collect()[0]["n"]
    print(f"  VERIFIED: {actual} rows in {full_name}")


errors = []
for cat, sch, tbl in TABLES:
    try:
        copy_table(cat, sch, tbl)
    except Exception as exc:
        import traceback
        msg = f"FAILED {cat}.{sch}.{tbl}: {exc}"
        print(msg)
        traceback.print_exc()
        errors.append(msg)

print("\n" + "="*60)
print("ERRORS:" if errors else "All 3 tables fixed!")
for e in errors:
    print(f"  {e}")
