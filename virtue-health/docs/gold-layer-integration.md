# Gold Layer Integration & Enhanced Capability Scoring

## Overview

During the DAIS 2026 hackathon session, two parallel workstreams were brought together:

1. **Gold data layer** — Deepak Mutkule's pre-computed gold and silver tables (from `deepak-workspace`) were copied into the shared `jody-free-workspace` via `src/copy_silver_gold_tables.py`, making them available alongside the existing `dais27hack` catalog.
2. **Enhanced scoring notebook** — John Leaf's `facility_capability_scoring_final` notebook was merged with Deepak's `Facility Trust Desk - Implementation Guide` to produce a single, improved scoring pipeline: `src/facility_capability_scoring_enhanced.py`.

Three targeted improvements were also made to the app's backend API routes.

---

## Gold Tables Now Available

The copy script transferred 14 tables across two schemas from Deepak's workspace. All are now queryable from `workspace.*` within `jody-free-workspace`.

### `workspace.gold_virtue_foundation.facilities_gold`

The richest addition. Extends the base facility record with:

| Column group | Columns | Benefit |
|---|---|---|
| Validated geo | `is_valid_location`, `latitude_validated`, `longitude_validated` | Heatmap shows only geo-verified facilities; eliminates (0,0) noise |
| Capability flags | `has_icu`, `has_maternity`, `has_emergency`, `has_oncology`, `has_trauma`, `has_nicu` | Boolean pre-filters — instant capability search without text scanning |
| Trust sub-scores | `ts_branding`, `ts_social`, `ts_activity`, `ts_engagement`, `ts_estab`, `ts_info`, `ts_staff` | Seven granular trust dimensions for detailed facility breakdown |
| Facility summary | `trust_score_overall`, `trust_signal`, `facility_size` | Headline score + size class for list ranking |
| Data quality | `has_valid_name`, `has_complete_address`, `has_valid_year_established` | Structural validity flags usable in Track 4 |
| Social engagement | `post_metrics_post_count`, `engagement_metrics_n_followers/likes/engagements` | Signals beyond simple platform presence |

### `workspace.gold_virtue_foundation.nfhs_5_district_health_indicators_gold`

The NFHS dataset with pre-computed composite scores layered on top:

- `infrastructure_quality_score`, `maternal_health_score`, `child_health_score`, `women_health_score`, `health_system_access_score`
- `overall_health_quality_score`, `health_quality_level`, `care_gap_classification`

Track 2 (Medical Desert Planner) can color districts directly by `care_gap_classification` rather than computing demand from raw percentages at query time.

### `workspace.gold_virtue_foundation_dataset.district_health_context`

A pre-joined, district-level aggregation combining facility counts with NFHS demand indicators:

- `facility_count_total`, `avg_trust_score`, `demand_supply_gap_score`
- Per-category facility counts: `icu_facility_count`, `maternity_facility_count`, `emergency_facility_count`, `nicu_facility_count`, `oncology_facility_count`, `dialysis_facility_count`
- Demand indicators: `institutional_birth_5y_pct`, `hh_electricity_pct`, `hh_member_covered_health_insurance_pct`

This table replaced the 40-line state-gaps CTE query (see API changes below).

### `workspace.gold_virtue_foundation_dataset.anomaly_alerts`

Pre-computed facility anomaly detections from Deepak's pipeline:

- `facility_id`, `facility_name`, `alert_type`, `severity`, `description`, `detected_date`

Used to supplement Track 4's issue detection with pre-computed signals in addition to the app's own SQL-based checks.

### `workspace.silver_virtue_foundation.facility_capability_summary`

A wide, facility-level summary with per-capability scores pre-pivoted for Deepak's 8 fixed medical categories (ICU, Emergency, Maternity, Oncology, Trauma, NICU, Cardiology, Surgery). Useful for Track 3's Referral Copilot ranked-list queries against the eight key clinical categories.

---

## Enhanced Capability Scoring Notebook

**File:** `src/facility_capability_scoring_enhanced.py`  
**Replaces:** John Leaf's `facility_capability_scoring_final`  
**Output:** `dais27hack.virtue_foundation_dataset_silver.facility_capability_scoring_table` (same table, same schema — drop-in replacement)

### Design Principle

John's approach and Deepak's approach address different questions:

- **John** asks: *Is there textual evidence that this specific capability exists at this facility, in a region with good health infrastructure?*
- **Deepak** asks: *How operationally substantial is this facility — does it have deep specialties, real staff, multiple data sources?*

The enhanced notebook keeps John's five-component structure (0–100 scale, LLM-extracted capabilities, NFHS regional score) and replaces or augments three components with Deepak's richer operational signals. It does **not** union two separate scoring runs — it is one unified algorithm.

### Scoring Comparison

#### Component 1 · Data Quality & Completeness (25 pts)

| Signal | John | Enhanced |
|---|---|---|
| Address completeness (4 fields) | 10 pts | 10 pts — unchanged |
| Contact info (phone/email/website) | 8 pts | 7 pts |
| NFHS district match | 7 pts | 5 pts |
| Affiliated staff present (`affiliated_staff_presence`) | — | **3 pts** (new) |

`affiliated_staff_presence` is a boolean in the silver table indicating whether verified staff records are linked to the facility. It is a strong legitimacy signal from Deepak's pipeline.

#### Component 2 · Capability Evidence (30 pts)

This is the most significant change. John's original implementation checked whether the capability keyword appeared in 1, 2, or 3 text fields and awarded 10/20/30 points as a step function — all-or-nothing blocks with no gradient. Deepak's approach uses the actual count of listed specialties, equipment, and procedures as continuous signals of facility depth.

| Signal | John | Enhanced |
|---|---|---|
| Keyword in description | 10/20/30 binary blocks | **5 pts** keyword bonus |
| Specialty depth (`specialty_count`) | — | **13 pts**: `min(count/10, 1.0) × 13` |
| Equipment + procedure depth | — | **12 pts**: `min((equip+proc)/15, 1.0) × 12` |

A facility claiming "ICU" that also lists 15 specialties and 20 pieces of equipment scores far higher than one that only has the word "ICU" in its description. The text keyword check is preserved as a 5-point bonus rather than the sole evidence signal.

#### Component 3 · Organizational Capacity (20 pts)

| Signal | John | Enhanced |
|---|---|---|
| Bed capacity (`capacity`) | 13 pts: `min(cap/200, 1.0) × 13` | **8 pts**: `min(cap/200, 1.0) × 8` |
| Doctor count (`numberDoctors`) | — | **7 pts**: `min(docs/50, 1.0) × 7` (new) |
| Facts count | 7 pts: `min(facts/20, 1.0) × 7` | **5 pts**: `min(facts/20, 1.0) × 5` |

> **Bug fixed:** John's notebook listed `number_of_doctors` in its SELECT — that column does not exist in the silver table. The actual column name is `numberDoctors`. John's doctor signal was silently never loading. The enhanced notebook uses the correct column name.

#### Component 4 · Regional Health Infrastructure (15 pts)

Unchanged from John. NFHS composite of four normalized district-level indicators:
- Women's literacy rate (15–49 yrs)
- Children with diarrhea taken to health facility
- Institutional birth rate (last 5 years)
- Mothers with first-trimester ANC visit

This component is John's strongest unique contribution. Deepak's approach omits regional health context entirely; the enhanced notebook preserves it at full weight.

#### Component 5 · Digital Presence (10 pts)

John awarded 10 points if a Facebook link was present and 0 otherwise — a single binary signal.

| Signal | John | Enhanced |
|---|---|---|
| Social platform count (`distinct_social_media_presence_count`) | Facebook binary (0 or 10) | **5 pts**: `min(count/3, 1.0) × 5` |
| Custom logo (`custom_logo_presence`) | — | **2 pts** (new) |
| Follower engagement (`engagement_metrics_n_followers`) | — | **3 pts**: `min(followers/1000, 1.0) × 3` (new) |

A facility active on three platforms with thousands of followers and a professional logo scores 10 pts. One with only a Facebook link scores ~1.7 pts instead of 10. The original scoring was highly gameable and rewarded Facebook presence above everything else.

### Confidence Tiers (unchanged)

| Score | Rating |
|---|---|
| 75–100 | Strong Evidence |
| 50–74 | Partial Evidence |
| 25–49 | Weak Evidence |
| 0–24 | No Evidence |

### Source Table Change

| | John's original | Enhanced |
|---|---|---|
| Source | `dais27hack.virtue_foundation_dataset_bronze.facilities` | `dais27hack.virtue_foundation_dataset_silver.facilities` |

Silver is preferable: it has the same LLM-extracted `capability` field, includes `facility_id`, and carries all the Deepak-sourced columns (`affiliated_staff_presence`, `distinct_social_media_presence_count`, `custom_logo_presence`, `engagement_metrics_*`). Bronze required a second join back to silver to get these columns.

---

## API Route Changes

Three changes were made to `server/routes/virtue-health-routes.ts`.

### 1. Trust Score Scale Fix (`/api/facilities/:id`)

The `FacilityDetailDialog` renders trust score bars as `(score / 10) × 100%` — it expects a 0–10 scale. John's `confidence_score` is 0–100. The server was returning the raw value, so any score above 10 would fill the bar 100% and the scale legend ("Score 0–10") was wrong.

**Fix:** The query now divides by 10: `ROUND(confidence_score / 10.0, 1) AS trust_score`.

### 2. State Gaps — Gold Path (`/api/desert/state-gaps`)

When no capability filter is active (the default view), the endpoint now queries `workspace.gold_virtue_foundation_dataset.district_health_context` aggregated to state level, joined with `nfhs_5_district_health_indicators_gold` for the infrastructure metrics. The pre-computed `demand_supply_gap_score` replaces the ad-hoc formula.

When a capability filter is active, the original CTE query against the silver facilities table is preserved — the gold table is pre-computed across all capabilities and cannot be filtered post-hoc.

**Benefit:** The default state-gaps view (the most common path) is substantially faster and uses Deepak's validated gap scores rather than a proxy formula.

### 3. Anomaly Alerts in Readiness Issues (`/api/readiness/issues`)

The `/api/readiness/issues` response now includes an `anomalyAlerts` field alongside the existing `suspicious`, `contradictions`, etc. arrays. It is populated from `workspace.gold_virtue_foundation_dataset.anomaly_alerts`, ordered by severity (HIGH first) then date. The query runs in parallel with the existing six issue-detection queries and fails gracefully (returns empty array) if the table is unavailable.

The existing `suspicious` array from SQL-predicate scanning is preserved unchanged — `anomalyAlerts` is additive.

---

## What Remains to Wire Up

The following gold table signals are available but not yet surfaced in the app UI:

- **`facilities_gold.ts_*` sub-scores** — the seven trust signal dimensions could be shown as a breakdown panel in `FacilityDetailDialog` (replace the generic progress bars with labeled sub-score rows).
- **`facilities_gold.has_icu / has_maternity / ...` boolean flags** — could power instant capability filter checkboxes in the facility list without requiring a `facility_capability_scoring_table` join.
- **`nfhs_5_district_health_indicators_gold.care_gap_classification`** — could drive district polygon fill color on the desert heatmap.
- **`anomalyAlerts` in the frontend** — `useReadinessData.ts` and the Track 4 UI need a new tab to display the pre-computed alerts alongside the existing issue tabs.
- **`facility_capability_summary` for Track 3** — the Referral Copilot currently does not exist as a route; this pre-pivoted table would make ranking by the 8 key clinical categories fast.
