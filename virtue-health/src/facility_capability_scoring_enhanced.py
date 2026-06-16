# Databricks notebook source
# DBTITLE 1,Overview
# MAGIC %md
# MAGIC # Facility Capability Confidence Scoring — Enhanced Pipeline
# MAGIC
# MAGIC Merges John Leaf's regional + text-evidence approach with Deepak Mutkule's
# MAGIC richer operational signals. Outputs to the same Unity Catalog table consumed
# MAGIC by the Virtue Health app.
# MAGIC
# MAGIC **Output:** `dais27hack.virtue_foundation_dataset_silver.facility_capability_scoring_table`
# MAGIC
# MAGIC **Source tables (all dais27hack silver/bronze):**
# MAGIC * `virtue_foundation_dataset_silver.facilities` — primary source with `facility_id`
# MAGIC * `virtue_foundation_dataset_silver.capability_id` — master capability list
# MAGIC * `virtue_foundation_dataset_silver.nfhs_5_district_health_indicators` — district health demand
# MAGIC * `virtue_foundation_dataset_bronze.india_post_pincode_directory` — pincode → district mapping

# COMMAND ----------

# DBTITLE 1,Scoring Design
# MAGIC %md
# MAGIC ## Scoring Components (Total: 100 points)
# MAGIC
# MAGIC ### 1. Data Quality & Completeness (25 pts)
# MAGIC * **Address completeness** (10 pts): all 4 fields = 10, missing 1 = 6, missing 2+ = 2
# MAGIC * **Contact info** (7 pts): phone+email+website = 7, any 2 = 4, any 1 = 1
# MAGIC * **NFHS district match** (5 pts): pincode resolves to a surveyed district
# MAGIC * **Affiliated staff present** (3 pts): `affiliated_staff_presence` flag — Deepak signal
# MAGIC
# MAGIC ### 2. Capability Evidence (30 pts)  ← Deepak enhancement
# MAGIC Previously: binary keyword-in-N-fields (0/10/20/30).
# MAGIC Now: keyword text check + depth of specialties/equipment/procedures.
# MAGIC * **Keyword in description** (5 pts): capability term found in description
# MAGIC * **Specialty depth** (13 pts): `min(specialty_count / 10, 1.0) * 13`
# MAGIC * **Equipment + procedure depth** (12 pts): `min((equip_count + proc_count) / 15, 1.0) * 12`
# MAGIC
# MAGIC ### 3. Organizational Capacity (20 pts)  ← Deepak adds doctor count
# MAGIC * **Bed capacity** (8 pts): `min(capacity / 200, 1.0) * 8`
# MAGIC * **Doctor count** (7 pts): `min(numberDoctors / 50, 1.0) * 7`  — Deepak signal
# MAGIC * **Facts count** (5 pts): `min(facts / 20, 1.0) * 5`
# MAGIC
# MAGIC ### 4. Regional Health Infrastructure (15 pts)  ← unchanged from John
# MAGIC * NFHS composite: avg of 4 normalized indicators × 15
# MAGIC
# MAGIC ### 5. Digital Presence (10 pts)  ← Deepak enhancement
# MAGIC Previously: Facebook-only binary (0 or 10).
# MAGIC Now: multi-signal social score.
# MAGIC * **Platform count** (5 pts): `min(distinct_social_media_presence_count / 3, 1.0) * 5`
# MAGIC * **Custom logo** (2 pts): `custom_logo_presence` flag
# MAGIC * **Social engagement** (3 pts): `min(n_followers / 1000, 1.0) * 3`
# MAGIC
# MAGIC ### Confidence Tiers
# MAGIC | Score | Rating |
# MAGIC |---|---|
# MAGIC | 75–100 | Strong Evidence |
# MAGIC | 50–74  | Partial Evidence |
# MAGIC | 25–49  | Weak Evidence |
# MAGIC | 0–24   | No Evidence |

# COMMAND ----------

# DBTITLE 1,Imports
from pyspark.sql import functions as F
from pyspark.sql.functions import (
    col, trim, lower, udf, explode, regexp_replace, when,
    row_number, coalesce, lit, least, split, size, nullif,
)
from pyspark.sql.types import ArrayType, StringType
from pyspark.sql.window import Window

SILVER = 'dais27hack.virtue_foundation_dataset_silver'
BRONZE = 'dais27hack.virtue_foundation_dataset_bronze'
OUT_TABLE = f'{SILVER}.facility_capability_scoring_table'

# COMMAND ----------

# DBTITLE 1,Load Silver Facilities (India only)
facilities_silver = (
    spark.table(f'{SILVER}.facilities')
    .filter(col('address_country') == 'India')
)
print(f'India facilities: {facilities_silver.count():,}')

# COMMAND ----------

# DBTITLE 1,Match LLM-Extracted Capabilities Against Master List
master_caps = [
    row.capability
    for row in spark.table(f'{SILVER}.capability_id').select('capability').collect()
]
print(f'Master capabilities: {len(master_caps)}')

def match_capabilities(capability_text):
    if not capability_text:
        return []
    text_lower = capability_text.lower()
    matched = []
    for cap in master_caps:
        if cap.lower() in text_lower:
            matched.append(cap)
    return matched

match_udf = udf(match_capabilities, ArrayType(StringType()))

# Columns to carry through from the base facilities row
BASE_COLS = [
    'facility_id', 'unique_id', 'name',
    'address_line1', 'address_line2', 'address_line3',
    'address_city', 'address_stateOrRegion', 'address_zipOrPostcode',
    'address_country', 'address_countryCode',
]

facilities_with_caps = (
    facilities_silver
    .withColumn('capabilities_matched', match_udf(col('capability')))
    .select(
        *BASE_COLS,
        explode(col('capabilities_matched')).alias('capability'),
    )
    .withColumn('capability', trim(regexp_replace(col('capability'), r"['\"]", '')))
    .withColumn(
        'capability',
        when(
            col('capability').rlike('(?i)diagnostic.*imaging.*(ct|mri)'),
            'Diagnostic Imaging (CT and MRI)',
        ).otherwise(col('capability')),
    )
    .filter(col('capability').isNotNull() & (col('capability') != ''))
)

print(f'Facility-capability pairs: {facilities_with_caps.count():,}')

# COMMAND ----------

# DBTITLE 1,Join NFHS Survey Data via Pincode
pincodes = spark.table(f'{BRONZE}.india_post_pincode_directory')
nfhs = spark.table(f'{SILVER}.nfhs_5_district_health_indicators')

pincode_nfhs = pincodes.join(
    nfhs,
    (lower(trim(pincodes.district)) == lower(trim(nfhs.district_name)))
    & (lower(trim(pincodes.statename)) == lower(trim(nfhs.state_ut))),
    how='left',
)

# Join facilities to pincode+NFHS
facilities_surveyed = facilities_with_caps.join(
    pincode_nfhs,
    (F.expr('TRY_CAST(address_zipOrPostcode AS BIGINT)') == F.col('pincode'))
    & (lower(trim(col('address_stateOrRegion'))) == lower(trim(F.col('statename')))),
    how='left',
)

# Drop pincode-side duplicates, keep one row per (facility_id, capability)
_drop = ['circlename', 'regionname', 'divisionname', 'officename',
         'officetype', 'delivery', 'district', 'statename', 'latitude', 'longitude']
facilities_surveyed = facilities_surveyed.drop(*_drop)

dedup_window = Window.partitionBy('facility_id', 'capability').orderBy('pincode')
facilities_surveyed = (
    facilities_surveyed
    .withColumn('_rn', row_number().over(dedup_window))
    .filter(col('_rn') == 1)
    .drop('_rn')
)

print(f'After NFHS join + dedup: {facilities_surveyed.count():,}')

# COMMAND ----------

# DBTITLE 1,Enrich with Full Facility Detail Columns
DETAIL_COLS = [
    'facility_id',
    'description', 'specialties', 'equipment', 'procedure',
    'numberDoctors', 'capacity',
    'number_of_facts_about_the_organization',
    # Deepak signals
    'distinct_social_media_presence_count',
    'affiliated_staff_presence',
    'custom_logo_presence',
    'engagement_metrics_n_followers',
    'engagement_metrics_n_likes',
    'engagement_metrics_n_engagements',
    # Contact
    'phone_numbers', 'email', 'websites',
]

facility_detail = spark.table(f'{SILVER}.facilities').select(
    *[c for c in DETAIL_COLS if c in spark.table(f'{SILVER}.facilities').columns]
)

facilities_enriched = facilities_surveyed.join(
    facility_detail, on='facility_id', how='left',
)
print(f'Enriched columns: {len(facilities_enriched.columns)}')

# COMMAND ----------

# DBTITLE 1,Component 1 — Data Quality & Completeness (25 pts)

# Address completeness (10 pts)
addr_count = (
    when(col('address_line1').isNotNull(), 1).otherwise(0)
    + when(col('address_city').isNotNull(), 1).otherwise(0)
    + when(col('address_stateOrRegion').isNotNull(), 1).otherwise(0)
    + when(col('address_zipOrPostcode').isNotNull(), 1).otherwise(0)
)
location_score = (
    when(addr_count == 4, 10)
    .when(addr_count == 3, 6)
    .when(addr_count >= 2, 2)
    .otherwise(0)
)

# Contact info (7 pts)
contact_count = (
    when(col('phone_numbers').isNotNull(), 1).otherwise(0)
    + when(col('email').isNotNull(), 1).otherwise(0)
    + when(col('websites').isNotNull(), 1).otherwise(0)
)
contact_score = (
    when(contact_count >= 3, 7)
    .when(contact_count == 2, 4)
    .when(contact_count == 1, 1)
    .otherwise(0)
)

# NFHS district match (5 pts)
nfhs_match_score = when(col('district_name').isNotNull(), 5).otherwise(0)

# Affiliated staff present (3 pts) — Deepak signal
staff_flag = coalesce(col('affiliated_staff_presence').cast('int'), lit(0))
staff_score = (
    when(staff_flag == 1, 3)
    .otherwise(0)
)

data_quality_score = location_score + contact_score + nfhs_match_score + staff_score

# COMMAND ----------

# DBTITLE 1,Component 2 — Capability Evidence (30 pts)
# Deepak enhancement: structured depth counts instead of pure binary text presence.

def _safe_count(array_col):
    """Count elements in a comma-delimited string column; returns 0 if null/empty."""
    return coalesce(
        size(split(nullif(trim(array_col.cast('string')), ''), ',')),
        lit(0),
    )

specialty_count  = _safe_count(col('specialties'))
equipment_count  = _safe_count(col('equipment'))
procedure_count  = _safe_count(col('procedure'))

def _text_has_cap(text_col):
    return (
        col(text_col).isNotNull()
        & (lower(col(text_col)).contains(lower(col('capability'))))
    )

# Keyword in description (5 pts)
keyword_score = when(_text_has_cap('description'), 5).otherwise(0)

# Specialty depth (13 pts): min(count/10, 1.0) * 13
specialty_depth_score = least(specialty_count / 10.0, lit(1.0)) * 13

# Equipment + procedure depth (12 pts): min((e+p)/15, 1.0) * 12
equip_proc_score = least((equipment_count + procedure_count) / 15.0, lit(1.0)) * 12

capability_evidence_score = keyword_score + specialty_depth_score + equip_proc_score

# COMMAND ----------

# DBTITLE 1,Component 3 — Organizational Capacity (20 pts)
# Deepak enhancement: adds numberDoctors as a separate scored signal.

capacity_val = (
    when(
        col('capacity').isNotNull() & (col('capacity').cast('string') != 'null'),
        col('capacity').cast('double'),
    ).otherwise(0.0)
)
# Bed capacity (8 pts)
bed_score = least(capacity_val / 200.0, lit(1.0)) * 8

# Doctor count (7 pts) — Deepak signal (column is numberDoctors in silver)
doctor_val = (
    when(
        col('numberDoctors').isNotNull() & (col('numberDoctors').cast('string') != 'null'),
        col('numberDoctors').cast('double'),
    ).otherwise(0.0)
)
doctor_score = least(doctor_val / 50.0, lit(1.0)) * 7

# Facts count (5 pts)
facts_val = (
    when(
        col('number_of_facts_about_the_organization').isNotNull()
        & (col('number_of_facts_about_the_organization').cast('string') != 'null'),
        col('number_of_facts_about_the_organization').cast('double'),
    ).otherwise(0.0)
)
facts_score = least(facts_val / 20.0, lit(1.0)) * 5

organizational_capacity_score = bed_score + doctor_score + facts_score

# COMMAND ----------

# DBTITLE 1,Component 4 — Regional Health Infrastructure (15 pts)
# Unchanged from John: NFHS composite of 4 indicators.

nfhs_indicators = [
    coalesce(col('women_age_15_49_who_are_literate_pct'), lit(0)) / 100.0,
    coalesce(col('children_with_diarrhoea_2wk_taken_to_a_health_facility_or_h_pct'), lit(0)) / 100.0,
    coalesce(col('institutional_birth_5y_pct'), lit(0)) / 100.0,
    coalesce(col('mothers_who_had_an_anc_visit_in_the_first_trimester_lb5y_pct'), lit(0)) / 100.0,
]
nfhs_composite = sum(nfhs_indicators) / 4.0
regional_health_score = nfhs_composite * 15

# COMMAND ----------

# DBTITLE 1,Component 5 — Digital Presence (10 pts)
# Deepak enhancement: replaces Facebook-only binary with multi-signal score.

# Social platform count (5 pts)
platforms = coalesce(col('distinct_social_media_presence_count').cast('double'), lit(0.0))
platform_score = least(platforms / 3.0, lit(1.0)) * 5

# Custom logo (2 pts) — Deepak signal
logo_score = (
    when(col('custom_logo_presence').cast('int') == 1, 2)
    .otherwise(0)
)

# Social engagement via follower count (3 pts) — Deepak signal
followers = coalesce(col('engagement_metrics_n_followers').cast('double'), lit(0.0))
engagement_score = least(followers / 1000.0, lit(1.0)) * 3

digital_presence_score = platform_score + logo_score + engagement_score

# COMMAND ----------

# DBTITLE 1,Compute Final Score and Save
total_confidence_score = least(
    data_quality_score
    + capability_evidence_score
    + organizational_capacity_score
    + regional_health_score
    + digital_presence_score,
    lit(100.0),
)

confidence_rating = (
    when(total_confidence_score >= 75, 'Strong Evidence')
    .when(total_confidence_score >= 50, 'Partial Evidence')
    .when(total_confidence_score >= 25, 'Weak Evidence')
    .otherwise('No Evidence')
)

final_scored_table = (
    facilities_enriched
    .withColumn('confidence_score',              total_confidence_score)
    .withColumn('confidence_rating',             confidence_rating)
    .withColumn('data_quality_score',            data_quality_score)
    .withColumn('capability_evidence_score',     capability_evidence_score)
    .withColumn('organizational_capacity_score', organizational_capacity_score)
    .withColumn('regional_health_score',         regional_health_score)
    .withColumn('digital_presence_score',        digital_presence_score)
    .select(
        'facility_id',
        'capability',
        F.round('confidence_score',              2).alias('confidence_score'),
        'confidence_rating',
        F.round('data_quality_score',            2).alias('data_quality_score'),
        F.round('capability_evidence_score',     2).alias('capability_evidence_score'),
        F.round('organizational_capacity_score', 2).alias('organizational_capacity_score'),
        F.round('regional_health_score',         2).alias('regional_health_score'),
        F.round('digital_presence_score',        2).alias('digital_presence_score'),
    )
)

# COMMAND ----------

# DBTITLE 1,Score Distribution Summary
total = final_scored_table.count()
print(f'\nTotal facility-capability records: {total:,}')

final_scored_table.groupBy('confidence_rating').agg(
    F.count('*').alias('count'),
    F.round(F.avg('confidence_score'), 2).alias('avg_score'),
    F.round(F.min('confidence_score'), 2).alias('min_score'),
    F.round(F.max('confidence_score'), 2).alias('max_score'),
).orderBy(F.desc('avg_score')).show()

print('\nTop 20 highest-scoring facility-capability pairs:')
final_scored_table.orderBy(F.desc('confidence_score')).limit(20).show(truncate=False)

# COMMAND ----------

# DBTITLE 1,Write to Unity Catalog
(
    final_scored_table
    .write
    .mode('overwrite')
    .option('overwriteSchema', 'true')
    .format('delta')
    .saveAsTable(OUT_TABLE)
)

print(f'\n✓ Saved {total:,} rows → {OUT_TABLE}')
