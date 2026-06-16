# Fix notebook — copy large facility_trust_scores tables from deepak to jody
# Uses disposition=EXTERNAL_LINKS to bypass the 25MB inline result limit

import requests
import os
import json
import time
import pandas as pd
from pyspark.sql.types import (
    StructType, StructField, StringType, LongType, IntegerType, ShortType,
    DoubleType, FloatType, BooleanType, DecimalType, TimestampType, DateType
)
from pyspark.sql.functions import col, to_timestamp, to_date
from decimal import Decimal, InvalidOperation

DEEPAK_HOST = "https://dbc-0a01f518-764a.cloud.databricks.com"
DEEPAK_TOKEN = os.environ["DEEPAK_TOKEN"]  # set via env; do not hardcode
DEEPAK_WH = "5b2b29cce22aa2c4"

TABLES = [
    ("workspace", "silver_virtue_foundation", "facility_trust_scores",
     "workspace", "silver_virtue_foundation", "facility_trust_scores"),
    ("workspace", "gold_virtue_foundation_dataset", "facility_trust_scores",
     "workspace", "gold_virtue_foundation_dataset", "facility_trust_scores"),
]

AUTH_HEADERS = {
    "Authorization": f"Bearer {DEEPAK_TOKEN}",
    "Content-Type": "application/json",
}


def submit_sql(statement, wait=30, use_external=False):
    payload = {
        "statement": statement,
        "warehouse_id": DEEPAK_WH,
        "wait_timeout": f"{wait}s",
        "format": "JSON_ARRAY",
    }
    if use_external:
        payload["disposition"] = "EXTERNAL_LINKS"

    resp = requests.post(
        f"{DEEPAK_HOST}/api/2.0/sql/statements",
        headers=AUTH_HEADERS,
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def poll_sql(stmt_id, max_secs=3600):
    deadline = time.time() + max_secs
    while time.time() < deadline:
        resp = requests.get(
            f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}",
            headers=AUTH_HEADERS,
            timeout=30,
        )
        r = resp.json()
        state = r.get("status", {}).get("state", "")
        if state in ("SUCCEEDED", "FAILED", "CANCELED", "CLOSED"):
            return r
        print(f"  Polling: {state}", flush=True)
        time.sleep(5)
    raise TimeoutError(f"Statement {stmt_id} timed out")


def sql_run(statement, use_external=False):
    r = submit_sql(statement, wait=30, use_external=use_external)
    state = r.get("status", {}).get("state", "")
    if state in ("PENDING", "RUNNING"):
        r = poll_sql(r["statement_id"])
    if r.get("status", {}).get("state") != "SUCCEEDED":
        err = r.get("status", {}).get("error", {})
        raise RuntimeError(f"SQL FAILED: {err.get('message', r.get('status'))}\n{statement[:200]}")
    return r


def download_external_chunk(ext_link):
    """Download a chunk from an EXTERNAL_LINKS pre-signed URL, returns list of rows."""
    url = ext_link["external_link"]
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()
    # Response is a JSON array of arrays
    return json.loads(resp.content)


def get_spark_type(type_name, type_text=""):
    tn = type_name.upper()
    if tn == "DECIMAL":
        try:
            inner = type_text.upper().replace("DECIMAL(", "").replace(")", "")
            parts = inner.split(",")
            return DecimalType(int(parts[0].strip()), int(parts[1].strip()))
        except Exception:
            return DecimalType(38, 18)
    return {
        "STRING": StringType(),
        "LONG": LongType(), "BIGINT": LongType(),
        "INT": IntegerType(), "INTEGER": IntegerType(),
        "SMALLINT": ShortType(),
        "DOUBLE": DoubleType(), "FLOAT": FloatType(),
        "BOOLEAN": BooleanType(),
        # Date/timestamp: read as string first, cast after
        "DATE": StringType(), "TIMESTAMP": StringType(), "TIMESTAMP_NTZ": StringType(),
    }.get(tn, StringType())


def cast_pdf(pdf, columns, col_info):
    """Cast a pandas DataFrame's columns to Python-native types for Spark."""
    for cname, (tn, tt) in zip(columns, col_info):
        tn_up = tn.upper()
        try:
            if tn_up in ("LONG", "BIGINT"):
                pdf[cname] = pd.to_numeric(pdf[cname], errors="coerce").astype("Int64")
            elif tn_up in ("INT", "INTEGER"):
                pdf[cname] = pd.to_numeric(pdf[cname], errors="coerce").astype("Int32")
            elif tn_up == "SMALLINT":
                pdf[cname] = pd.to_numeric(pdf[cname], errors="coerce").astype("Int16")
            elif tn_up in ("DOUBLE", "FLOAT"):
                pdf[cname] = pd.to_numeric(pdf[cname], errors="coerce")
            elif tn_up == "DECIMAL":
                pdf[cname] = pd.to_numeric(pdf[cname], errors="coerce")
            elif tn_up == "BOOLEAN":
                pdf[cname] = pdf[cname].map(
                    lambda x: True if str(x).lower() == "true" else (
                        False if str(x).lower() == "false" else None
                    ) if x is not None else None
                )
        except Exception as e:
            print(f"  Warning: cast error on {cname} ({tn}): {e}")
    return pdf


def write_batch(dst_full, spark_schema, col_info, columns, rows, first):
    if not rows:
        if first:
            # Create empty table
            empty_rdd = spark.sparkContext.emptyRDD()
            sdf = spark.createDataFrame(empty_rdd, schema=spark_schema)
        else:
            return
    else:
        pdf = pd.DataFrame(rows, columns=columns)
        pdf = cast_pdf(pdf, columns, col_info)

        # Use StringType schema to avoid conversion issues, cast after
        str_schema = StructType([StructField(c, StringType(), True) for c in columns])
        pdf_str = pdf.astype(str).where(pdf.notna(), other=None)
        sdf = spark.createDataFrame(pdf_str, schema=str_schema)

        # Cast to proper types
        for cname, (tn, tt) in zip(columns, col_info):
            tn_up = tn.upper()
            if tn_up in ("LONG", "BIGINT"):
                sdf = sdf.withColumn(cname, col(cname).cast("bigint"))
            elif tn_up in ("INT", "INTEGER"):
                sdf = sdf.withColumn(cname, col(cname).cast("int"))
            elif tn_up == "SMALLINT":
                sdf = sdf.withColumn(cname, col(cname).cast("smallint"))
            elif tn_up == "DOUBLE":
                sdf = sdf.withColumn(cname, col(cname).cast("double"))
            elif tn_up == "FLOAT":
                sdf = sdf.withColumn(cname, col(cname).cast("float"))
            elif tn_up == "BOOLEAN":
                sdf = sdf.withColumn(cname, col(cname).cast("boolean"))
            elif tn_up == "DECIMAL":
                sdf = sdf.withColumn(cname, col(cname).cast(tt))
            elif tn_up == "TIMESTAMP":
                sdf = sdf.withColumn(cname, to_timestamp(col(cname)))
            elif tn_up == "DATE":
                sdf = sdf.withColumn(cname, to_date(col(cname)))

    mode = "overwrite" if first else "append"
    (
        sdf.write
        .mode(mode)
        .option("overwriteSchema", "true" if first else "false")
        .saveAsTable(dst_full)
    )


def copy_table(src_cat, src_sch, src_tbl, dst_cat, dst_sch, dst_tbl):
    src = f"{src_cat}.{src_sch}.{src_tbl}"
    dst = f"{dst_cat}.{dst_sch}.{dst_tbl}"
    print(f"\n{'='*60}\nCopying {src} → {dst}", flush=True)

    # Get schema
    r_meta = sql_run(f"SELECT * FROM {src} LIMIT 0")
    cols_info = r_meta.get("manifest", {}).get("schema", {}).get("columns", [])
    columns = [c["name"] for c in cols_info]
    col_info = [(c["type_name"], c.get("type_text", c["type_name"])) for c in cols_info]

    spark_schema = StructType([
        StructField(c["name"], get_spark_type(c["type_name"], c.get("type_text", "")), True)
        for c in cols_info
    ])
    print(f"  Schema: {len(columns)} columns", flush=True)

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {dst_cat}.{dst_sch}")

    # Submit with EXTERNAL_LINKS disposition
    r = submit_sql(f"SELECT * FROM {src}", wait=30, use_external=True)
    state = r.get("status", {}).get("state", "")
    if state in ("PENDING", "RUNNING"):
        r = poll_sql(r["statement_id"])
    if r.get("status", {}).get("state") != "SUCCEEDED":
        err = r.get("status", {}).get("error", {})
        raise RuntimeError(f"SQL FAILED: {err.get('message', r.get('status'))}")

    manifest = r.get("manifest", {})
    total_chunks = manifest.get("total_chunk_count", 1)
    total_rows = manifest.get("total_row_count", 0)
    print(f"  {total_rows} rows, {total_chunks} external chunks", flush=True)

    # First chunk: may be inline or external
    first = True
    result = r.get("result", {})
    inline_rows = result.get("data_array", [])
    ext_links = result.get("external_links", [])

    if inline_rows:
        print(f"  Chunk 0 (inline): {len(inline_rows)} rows", flush=True)
        write_batch(dst, spark_schema, col_info, columns, inline_rows, first)
        first = False
    elif ext_links:
        for lnk in ext_links:
            rows = download_external_chunk(lnk)
            print(f"  Chunk 0 (external): {len(rows)} rows", flush=True)
            write_batch(dst, spark_schema, col_info, columns, rows, first)
            first = False

    # Remaining chunks
    stmt_id = r["statement_id"]
    for chunk_idx in range(1, total_chunks):
        resp = requests.get(
            f"{DEEPAK_HOST}/api/2.0/sql/statements/{stmt_id}/result/chunks/{chunk_idx}",
            headers=AUTH_HEADERS,
            timeout=60,
        )
        resp.raise_for_status()
        chunk_data = resp.json()
        inline_rows = chunk_data.get("data_array", [])
        ext_links = chunk_data.get("external_links", [])

        if inline_rows:
            write_batch(dst, spark_schema, col_info, columns, inline_rows, first)
            print(f"  Chunk {chunk_idx} (inline): {len(inline_rows)} rows", flush=True)
            first = False
        elif ext_links:
            for lnk in ext_links:
                rows = download_external_chunk(lnk)
                write_batch(dst, spark_schema, col_info, columns, rows, first)
                print(f"  Chunk {chunk_idx} (external): {len(rows)} rows", flush=True)
                first = False

    if first:
        # Table was empty
        write_batch(dst, spark_schema, col_info, columns, [], True)

    cnt = spark.sql(f"SELECT COUNT(*) AS n FROM {dst}").collect()[0]["n"]
    print(f"  VERIFIED: {cnt} rows in {dst}", flush=True)
    return cnt


errors = {}
results = {}
for args in TABLES:
    key = f"{args[3]}.{args[4]}.{args[5]}"
    try:
        cnt = copy_table(*args)
        results[key] = cnt
    except Exception as exc:
        import traceback
        errors[key] = str(exc)
        print(f"ERROR {key}: {exc}", flush=True)
        traceback.print_exc()

print("\n" + "="*60)
if results:
    print("Copied:")
    for k, v in results.items():
        print(f"  {k}: {v} rows")
if errors:
    print("Errors:")
    for k, v in errors.items():
        print(f"  {k}: {v[:300]}")
if not errors:
    print("All tables copied successfully!")
