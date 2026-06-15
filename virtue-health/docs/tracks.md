# Tracks

Four apps, all backed by the same Lakebase database (`projects/virtue-health`, catalog `virtue-pg`, schema `hackathon`).

---

## Track 1: Facility Trust Desk

**Question:** Can this facility actually do what it claims?

**App name:** `facility-trust-desk`

For each facility and claimed capability (ICU, maternity, emergency, oncology, trauma, NICU, etc.), produce a trust signal:

| Signal | Meaning |
|---|---|
| Strong evidence | Multiple independent sources corroborate the claim |
| Partial evidence | Some corroboration, gaps remain |
| Weak / suspicious | Claim present but data quality or consistency is low |
| No claim | Capability not asserted in the data |

**Primary data:** `hackathon.facilities` — `capability`, `specialties`, `equipment`, `procedure`, `source_types`, `source_ids`

---

## Track 2: Medical Desert Planner

**Question:** Where are the highest-risk gaps in care, and how confident are we that those gaps are real?

**App name:** `medical-desert-planner`

Aggregates trust-weighted facility evidence across geography (state → district → city → PIN code). Helps planners distinguish genuine care gaps from data-poor regions where absence of evidence ≠ evidence of absence.

**Primary data:**
- `hackathon.facilities` — geographic fields, capability claims, trust signals from Track 1
- `hackathon.nfhs_5_district_health_indicators` — district-level health demand indicators
- `hackathon.india_post_pincode_directory` — geographic resolution for PIN codes

---

## Track 3: Referral Copilot

**Question:** Where should a patient or coordinator actually go?

**App name:** `referral-copilot`

A user enters a location and a care need (e.g. "dialysis near Jaipur", "emergency surgery near Patna") and receives a shortlist of candidate facilities ranked by proximity and evidence strength, with trust signals attached to each result.

**Primary data:**
- `hackathon.facilities` — location (`latitude`, `longitude`, `address_*`), capabilities, contact info
- `hackathon.india_post_pincode_directory` — PIN-to-lat/lon resolution for location input
- Trust signals from Track 1 attached to each result

---

## Track 4: Data Readiness Desk

**Question:** What needs to be fixed before this dataset can be trusted for planning?

**App name:** `data-readiness-desk`

A data quality workbench for profiling, reviewing, and improving the facility dataset. Surfaces:
- Contradictions (e.g. capability claimed but no supporting equipment/staff)
- Suspicious claims (outliers, implausible combinations)
- Sparse fields (high-value columns with low fill rates)
- High-leverage records most in need of human review

**Primary data:** `hackathon.facilities` — all columns; completeness and consistency scoring applied client-side or via server-side profiling queries

---

## Shared Infrastructure

| Resource | Value |
|---|---|
| Lakebase project | `projects/virtue-health` |
| UC catalog | `virtue-pg` |
| Postgres schema | `hackathon` |
| Endpoint host | `ep-solitary-poetry-d8v1iwpc.database.us-east-2.cloud.databricks.com` |
| App SP client ID | `5ccf106a-7211-489d-a075-5ca82e07b0ae` |
| Source catalog | `dais27hack.virtue_foundation_dataset_silver` |
