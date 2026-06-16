import { Application } from 'express';

const DESERT_CACHE_TTL_MS = 5 * 60 * 1000;
const desertCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): T | null {
  const entry = desertCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data as T;
}

function setCached(key: string, data: unknown): void {
  desertCache.set(key, { data, expiresAt: Date.now() + DESERT_CACHE_TTL_MS });
}

const SRC = 'dais27hack.virtue_foundation_dataset_silver';

// ── Track 4: module-scope interfaces + state ──────────────────────────────

interface FieldProfileRow {
  key: string; label: string; critical: boolean;
  filled: number; fillRate: number;
}
interface ProfileResult { profile: FieldProfileRow[]; total: number; }

const profileInflight = new Map<string, Promise<ProfileResult>>();

// Test-only reset — called in beforeEach by readiness test files.
export function __resetReadinessCachesForTest(): void {
  desertCache.clear();
  profileInflight.clear();
}

// ── Track 4 cache keys ──
const PROFILE_CACHE_KEY     = 'readiness-profile:facilities';
const ISSUES_CACHE_KEY      = 'readiness-issues:facilities';
const TOP_RECORDS_CACHE_KEY = 'readiness-top-records:facilities';

// ── Single-sourced SQL predicate fragments ──
// GUARDRAIL: no fragment may reference `facility_id` unqualified — it exists in
// both `f` and `d` under COUNTS_SQL's LEFT JOIN → AMBIGUOUS_REFERENCE at runtime.

const DUP_BASE = `facility_id IS NOT NULL`;

// AC3: CHAR(0) = embedded NUL byte. If PF-4(c) finds backslash-zero instead,
// swap to `name LIKE '%\\0%'` or OR both forms.
const NULLBYTE_PRED =
  `(instr(name, CHAR(0)) > 0 OR instr(description, CHAR(0)) > 0)`;

// AC4: STRING branch — lat/long stored as text (shipped routes use CAST(... AS DOUBLE)).
// Includes (0,0) placeholder check per PF-2.
const GEO_MISSING =
  `((latitude IS NULL OR TRIM(latitude) = '' OR longitude IS NULL OR TRIM(longitude) = '')` +
  ` OR (TRIM(latitude) IN ('0','0.0') AND TRIM(longitude) IN ('0','0.0')))`;
const CITY_PRESENT = `(address_city IS NOT NULL AND TRIM(address_city) <> '')`;
const GEO_PRED = `(${GEO_MISSING} AND ${CITY_PRESENT})`;

// AC5: COALESCE(...,0) — deliberate divergence from shipped COALESCE(...,1) trust-weight
// floor. Empty = 0 elements for element-count disagreement (PF-4(b)).
const ELEM = (col: string) =>
  `COALESCE(SIZE(SPLIT(NULLIF(TRIM(${col}), ''), ',')), 0)`;
const SOURCE_MISMATCH_PRED = `(${ELEM('source_types')} <> ${ELEM('source_ids')})`;

const CONTRADICTION_PRED =
  `(capability IS NOT NULL AND TRIM(capability) <> ''` +
  ` AND (equipment IS NULL OR TRIM(equipment) = '')` +
  ` AND (specialties IS NULL OR TRIM(specialties) = ''))`;

// SUSPICIOUS_PRED is a HEAVY signal — every Suspicious-tab row is also Flagged.
const SUSPICIOUS_PRED =
  `(capability IS NOT NULL AND TRIM(capability) <> ''` +
  ` AND (source_types IS NULL OR TRIM(source_types) = ''))`;

const TIEBREAK = `ORDER BY name ASC, facility_id ASC`;

// ── Field definitions — 16 entries (AC1: ≥15 columns) ──
// Remove any entry absent from DESCRIBE before running; keep ≥15 for AC1.
// capability_status: confirm via PF-1/PF-3; remove if absent.
const FIELD_DEFS = [
  { col: 'name',                  label: 'Name',               critical: true,  isNumeric: false },
  { col: 'description',           label: 'Description',        critical: false, isNumeric: false },
  { col: 'capability',            label: 'Capability',         critical: true,  isNumeric: false },
  { col: 'source_types',          label: 'Source Types',       critical: true,  isNumeric: false },
  { col: 'source_ids',            label: 'Source IDs',         critical: false, isNumeric: false },
  { col: 'latitude',              label: 'Latitude',           critical: true,  isNumeric: false },
  { col: 'longitude',             label: 'Longitude',          critical: true,  isNumeric: false },
  { col: 'specialties',           label: 'Specialties',        critical: false, isNumeric: false },
  { col: 'equipment',             label: 'Equipment',          critical: false, isNumeric: false },
  { col: 'procedure',             label: 'Procedure',          critical: false, isNumeric: false },
  { col: 'address_city',          label: 'City',               critical: false, isNumeric: false },
  { col: 'address_stateorregion', label: 'State',              critical: false, isNumeric: false },
  { col: 'address_country',       label: 'Country',            critical: false, isNumeric: false },
  { col: 'organization_type',     label: 'Organization Type',  critical: false, isNumeric: false },
  { col: 'facility_id',           label: 'Facility ID',        critical: true,  isNumeric: true  },
  { col: 'capability_status',     label: 'Capability Status',  critical: false, isNumeric: false },
] as const;

// ── Issue detection list queries (LIMIT 200, deterministic TIEBREAK) ──
const DUPLICATES_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, CAST(COUNT(*) AS INT) AS dup_count, MAX(name) AS sample_name
  FROM ${SRC}.facilities
  WHERE ${DUP_BASE}
  GROUP BY facility_id
  HAVING COUNT(*) > 1
  ORDER BY dup_count DESC, facility_id ASC
  LIMIT 200`;

const NULLBYTES_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, name, description, address_stateorregion
  FROM ${SRC}.facilities
  WHERE ${NULLBYTE_PRED}
  ${TIEBREAK}
  LIMIT 200`;

const GEO_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, name, address_city, address_stateorregion
  FROM ${SRC}.facilities
  WHERE ${GEO_PRED}
  ${TIEBREAK}
  LIMIT 200`;

const SOURCE_MISMATCH_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, name, source_types, source_ids
  FROM ${SRC}.facilities
  WHERE ${SOURCE_MISMATCH_PRED}
  ${TIEBREAK}
  LIMIT 200`;

const CONTRADICTIONS_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, name, capability, address_stateorregion
  FROM ${SRC}.facilities
  WHERE ${CONTRADICTION_PRED}
  ${TIEBREAK}
  LIMIT 200`;

const SUSPICIOUS_SQL = `
  SELECT CAST(facility_id AS INT) AS facility_id, name, capability, address_stateorregion
  FROM ${SRC}.facilities
  WHERE ${SUSPICIOUS_PRED}
  ${TIEBREAK}
  LIMIT 200`;

// LEFT JOIN: avoids IN-subquery-in-CASE (Spark restricts correlated subqueries to Filter).
const COUNTS_SQL = `
  SELECT
    CAST((SELECT COUNT(*) FROM (
       SELECT facility_id FROM ${SRC}.facilities
       WHERE ${DUP_BASE}
       GROUP BY facility_id HAVING COUNT(*) > 1
    )) AS INT) AS duplicate_id_count,
    CAST(COUNT(CASE WHEN ${NULLBYTE_PRED} THEN 1 END) AS INT) AS nullbyte_count,
    CAST(COUNT(CASE WHEN ${GEO_PRED} THEN 1 END) AS INT) AS geo_count,
    CAST(COUNT(CASE WHEN ${SOURCE_MISMATCH_PRED} THEN 1 END) AS INT) AS sourcemismatch_count,
    CAST(COUNT(CASE WHEN ${CONTRADICTION_PRED} THEN 1 END) AS INT) AS contradiction_count,
    CAST(COUNT(CASE WHEN ${SUSPICIOUS_PRED} THEN 1 END) AS INT) AS suspicious_count,
    CAST(COUNT(d.facility_id) AS INT) AS duplicate_row_count,
    CAST(COUNT(CASE WHEN
         (d.facility_id IS NOT NULL)
         OR ${NULLBYTE_PRED}
         OR ${GEO_PRED}
         OR ${SOURCE_MISMATCH_PRED}
         OR ${CONTRADICTION_PRED}
         OR ${SUSPICIOUS_PRED}
         THEN 1 END) AS INT) AS total_issue_count
  FROM ${SRC}.facilities f
  LEFT JOIN (
    SELECT facility_id FROM ${SRC}.facilities
    WHERE ${DUP_BASE}
    GROUP BY facility_id HAVING COUNT(*) > 1
  ) d ON f.facility_id = d.facility_id`;

// Bands: 0 heavy → green, 1 heavy (+2) → amber, 2+ heavy (+4) → red.
const SCORE_HEAVY = `(
  (CASE WHEN ${NULLBYTE_PRED} THEN 2 ELSE 0 END) +
  (CASE WHEN ${GEO_PRED} THEN 2 ELSE 0 END) +
  (CASE WHEN ${SOURCE_MISMATCH_PRED} THEN 2 ELSE 0 END) +
  (CASE WHEN ${CONTRADICTION_PRED} THEN 2 ELSE 0 END) +
  (CASE WHEN ${SUSPICIOUS_PRED} THEN 2 ELSE 0 END)
)`;

const SCORE_LIGHT = `(
  (CASE WHEN name IS NULL OR TRIM(name) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN capability IS NULL OR TRIM(capability) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN specialties IS NULL OR TRIM(specialties) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN equipment IS NULL OR TRIM(equipment) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN source_types IS NULL OR TRIM(source_types) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN latitude IS NULL OR TRIM(latitude) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN longitude IS NULL OR TRIM(longitude) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN address_city IS NULL OR TRIM(address_city) = '' THEN 1 ELSE 0 END) +
  (CASE WHEN address_stateorregion IS NULL OR TRIM(address_stateorregion) = '' THEN 1 ELSE 0 END)
)`;

const TOP_RECORDS_SQL = `
  SELECT
    CAST(facility_id AS INT) AS facility_id,
    name, address_city, address_stateorregion, capability, source_types, source_ids,
    CAST(${SCORE_HEAVY} AS INT) AS heavy_score,
    CAST(${SCORE_HEAVY} + ${SCORE_LIGHT} AS INT) AS issue_score
  FROM ${SRC}.facilities
  ORDER BY heavy_score DESC, issue_score DESC, name ASC, facility_id ASC
  LIMIT 50`;

const FLAGGED_COUNT_SQL = `
  SELECT CAST(COUNT(*) AS INT) AS flagged_count FROM (
    SELECT ${SCORE_HEAVY} AS heavy_score FROM ${SRC}.facilities
  ) WHERE heavy_score > 0`;

interface AppKitWithAnalytics {
  analytics: {
    query(sql: string): Promise<Record<string, unknown>[]>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

export function setupVirtueHealthRoutes(appkit: AppKitWithAnalytics) {
  // ── Track 4: shared profile helper (closures over appkit) ──
  async function computeProfile(): Promise<ProfileResult> {
    const cached = getCached<ProfileResult>(PROFILE_CACHE_KEY);
    if (cached) return cached;

    const existing = profileInflight.get(PROFILE_CACHE_KEY);
    if (existing) return existing;

    const run = (async (): Promise<ProfileResult> => {
      const caseClauses = FIELD_DEFS.map(f => {
        const check = f.isNumeric
          ? `${f.col} IS NOT NULL`
          : `${f.col} IS NOT NULL AND TRIM(${f.col}) <> ''`;
        return `CAST(COUNT(CASE WHEN ${check} THEN 1 END) AS INT) AS ${f.col}_filled`;
      }).join(',\n      ');
      const sql = `SELECT CAST(COUNT(*) AS INT) AS total,\n      ${caseClauses}\n    FROM ${SRC}.facilities`;
      const rows = await appkit.analytics.query(sql);
      const row = rows[0] ?? {};
      const total = Number(row.total ?? 0);
      const profile: FieldProfileRow[] = FIELD_DEFS.map(f => {
        const filled = Number(row[`${f.col}_filled`] ?? 0);
        return { key: f.col, label: f.label, critical: f.critical, filled, fillRate: total > 0 ? filled / total : 0 };
      });
      const result: ProfileResult = { profile, total };
      if (total > 0) setCached(PROFILE_CACHE_KEY, result);
      return result;
    })();

    profileInflight.set(PROFILE_CACHE_KEY, run);
    try {
      return await run;
    } finally {
      profileInflight.delete(PROFILE_CACHE_KEY);
    }
  }

  appkit.server.extend((app) => {
    app.get('/api/summary', async (_req, res) => {
      try {
        const [facilitiesResult, nfhsResult] = await Promise.all([
          appkit.analytics.query(
            `SELECT COUNT(*) AS total_facilities FROM ${SRC}.facilities`,
          ),
          appkit.analytics.query(
            `SELECT
               COUNT(DISTINCT state_ut) AS states_covered,
               COUNT(DISTINCT district_name) AS districts_covered,
               ROUND(AVG(sex_ratio_total_f_per_1000_m), 1) AS avg_sex_ratio
             FROM ${SRC}.nfhs_5_district_health_indicators`,
          ),
        ]);

        const totalFacilities = Number(facilitiesResult[0]?.total_facilities ?? 0);
        const statesCovered = Number(nfhsResult[0]?.states_covered ?? 0);
        const districtsCovered = Number(nfhsResult[0]?.districts_covered ?? 0);
        const avgSexRatio = nfhsResult[0]?.avg_sex_ratio != null ? Number(nfhsResult[0].avg_sex_ratio) : null;

        res.json({ totalFacilities, statesCovered, districtsCovered, avgSexRatio, syncing: false });
      } catch (err) {
        console.error('[summary] Query failed:', err);
        res.status(500).json({ error: 'Failed to load summary' });
      }
    });

    app.get('/api/facilities', async (req, res) => {
      try {
        const search = (req.query.search as string | undefined) ?? '';
        const state = (req.query.state as string | undefined) ?? '';
        const page = Math.max(1, parseInt((req.query.page as string | undefined) ?? '1', 10));
        const pageSize = 50;
        const offset = (page - 1) * pageSize;

        const conditions: string[] = [];
        if (search) conditions.push(`(name ILIKE '%${search.replace(/'/g, "''")}%' OR address_city ILIKE '%${search.replace(/'/g, "''")}%')`);
        if (state) conditions.push(`address_stateorregion = '${state.replace(/'/g, "''")}'`);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [dataResult, countResult] = await Promise.all([
          appkit.analytics.query(
            `SELECT
               facility_id, name, organization_type,
               address_city, address_stateorregion, address_country
             FROM ${SRC}.facilities
             ${where}
             ORDER BY name ASC
             LIMIT ${pageSize} OFFSET ${offset}`,
          ),
          appkit.analytics.query(
            `SELECT COUNT(*) AS total FROM ${SRC}.facilities ${where}`,
          ),
        ]);

        const total = Number(countResult[0]?.total ?? 0);
        res.json({
          facilities: dataResult,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
          syncing: false,
        });
      } catch (err) {
        console.error('[facilities] Query failed:', err);
        res.status(500).json({ error: 'Failed to load facilities' });
      }
    });

    app.get('/api/facilities/states', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(
          `SELECT DISTINCT address_stateorregion AS state
           FROM ${SRC}.facilities
           WHERE address_stateorregion IS NOT NULL AND address_stateorregion <> ''
           ORDER BY address_stateorregion ASC`,
        );
        res.json({ states: result.map((r) => r.state as string), syncing: false });
      } catch (err) {
        console.error('[facilities/states] Query failed:', err);
        res.status(500).json({ error: 'Failed to load states' });
      }
    });

    app.get('/api/districts', async (req, res) => {
      try {
        const state = (req.query.state as string | undefined) ?? '';
        const where = state ? `WHERE state_ut = '${state.replace(/'/g, "''")}'` : '';

        const result = await appkit.analytics.query(
          `SELECT
             district_name, state_ut,
             households_surveyed, hh_electricity_pct,
             hh_improved_water_pct, hh_use_improved_sanitation_pct,
             child_u5_whose_birth_was_civil_reg_pct
           FROM ${SRC}.nfhs_5_district_health_indicators
           ${where}
           ORDER BY state_ut ASC, district_name ASC`,
        );

        res.json({ districts: result, syncing: false });
      } catch (err) {
        console.error('[districts] Query failed:', err);
        res.status(500).json({ error: 'Failed to load districts' });
      }
    });

    app.get('/api/districts/states', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(
          `SELECT DISTINCT state_ut AS state
           FROM ${SRC}.nfhs_5_district_health_indicators
           WHERE state_ut IS NOT NULL
           ORDER BY state_ut ASC`,
        );
        res.json({ states: result.map((r) => r.state as string), syncing: false });
      } catch (err) {
        console.error('[districts/states] Query failed:', err);
        res.status(500).json({ error: 'Failed to load district states' });
      }
    });

    // ── Track 2: Medical Desert Planner ──────────────────────────────────────

    app.get('/api/desert/heatmap-points', async (req, res) => {
      try {
        const capability = (req.query.capability as string | undefined) ?? '';
        const cacheKey = `heatmap-points:${capability}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) { res.json({ points: cached, syncing: false }); return; }

        const capClause = capability
          ? `AND capability ILIKE '%${capability.replace(/'/g, "''")}%'`
          : '';

        const result = await appkit.analytics.query(
          `SELECT
             facility_id,
             CAST(latitude AS DOUBLE)  AS latitude,
             CAST(longitude AS DOUBLE) AS longitude,
             LEAST(
               COALESCE(
                 SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')),
                 1
               ) / 3.0,
               1.0
             ) AS trust_weight,
             capability,
             address_stateorregion
           FROM ${SRC}.facilities
           WHERE
             latitude IS NOT NULL AND longitude IS NOT NULL
             AND CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5
             AND CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5
             ${capClause}`,
        );

        setCached(cacheKey, result);
        res.json({ points: result, syncing: false });
      } catch (err) {
        console.error('[desert/heatmap-points] Query failed:', err);
        res.status(500).json({ error: 'Failed to load heatmap points' });
      }
    });

    app.get('/api/desert/state-gaps', async (req, res) => {
      try {
        const capability = (req.query.capability as string | undefined) ?? '';
        const cacheKey = `state-gaps:${capability}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) { res.json({ gaps: cached, syncing: false }); return; }

        const capClause = capability
          ? `AND capability ILIKE '%${capability.replace(/'/g, "''")}%'`
          : '';

        const result = await appkit.analytics.query(
          `WITH facility_state AS (
             SELECT
               LOWER(TRIM(address_stateorregion)) AS state_key,
               address_stateorregion,
               COUNT(*) AS facility_count,
               AVG(
                 LEAST(
                   COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0,
                   1.0
                 )
               ) AS avg_trust_weight,
               COUNT(DISTINCT source_types) AS source_type_variants
             FROM ${SRC}.facilities
             WHERE address_stateorregion IS NOT NULL AND address_stateorregion <> ''
               ${capClause}
             GROUP BY LOWER(TRIM(address_stateorregion)), address_stateorregion
           ),
           nfhs_state AS (
             SELECT
               LOWER(TRIM(state_ut)) AS state_key,
               state_ut,
               COUNT(DISTINCT district_name) AS district_count,
               ROUND(AVG(hh_electricity_pct), 1)                        AS avg_electricity,
               ROUND(AVG(hh_improved_water_pct), 1)                     AS avg_water,
               ROUND(AVG(hh_use_improved_sanitation_pct), 1)            AS avg_sanitation,
               ROUND(AVG(child_u5_whose_birth_was_civil_reg_pct), 1)    AS avg_birth_reg,
               ROUND((
                 (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
                 + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
                 + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
                 + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
               ) / 4.0, 1) AS demand_index
             FROM ${SRC}.nfhs_5_district_health_indicators
             GROUP BY LOWER(TRIM(state_ut)), state_ut
           )
           SELECT
             COALESCE(ns.state_ut, fs.address_stateorregion) AS state,
             COALESCE(fs.facility_count, 0) AS facility_count,
             ROUND(COALESCE(fs.avg_trust_weight, 0), 3) AS avg_trust_weight,
             COALESCE(fs.source_type_variants, 0) AS source_type_variants,
             ns.demand_index,
             ns.district_count,
             ns.avg_electricity,
             ns.avg_water,
             ns.avg_sanitation,
             ns.avg_birth_reg,
             ROUND(COALESCE(fs.facility_count, 0) * COALESCE(fs.avg_trust_weight, 0.0) / 10.0, 2) AS supply_score,
             ROUND(
               COALESCE(ns.demand_index, 50) /
               GREATEST(
                 COALESCE(fs.facility_count, 0) * COALESCE(fs.avg_trust_weight, 0.0) / 10.0,
                 0.1
               ),
               2
             ) AS gap_score
           FROM nfhs_state ns
           FULL OUTER JOIN facility_state fs ON ns.state_key = fs.state_key
           ORDER BY gap_score DESC NULLS LAST`,
        );

        const gaps = result.map((row) => {
          const variants = Number(row.source_type_variants ?? 0);
          const confidence: 'high' | 'medium' | 'low' =
            variants >= 3 ? 'high' : variants >= 1 ? 'medium' : 'low';
          return { ...row, confidence };
        });

        setCached(cacheKey, gaps);
        res.json({ gaps, syncing: false });
      } catch (err) {
        console.error('[desert/state-gaps] Query failed:', err);
        res.status(500).json({ error: 'Failed to load state gaps' });
      }
    });

    // ── Track 4: Data Readiness Desk ─────────────────────────────────────────

    app.get('/api/data-readiness/quality-metrics', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
                  AND CAST(latitude AS DOUBLE) BETWEEN 6.0 AND 37.5
                  AND CAST(longitude AS DOUBLE) BETWEEN 68.0 AND 97.5 THEN 1 ELSE 0 END) AS valid_gps,
             SUM(CASE WHEN organization_type IS NOT NULL AND TRIM(organization_type) <> '' THEN 1 ELSE 0 END) AS has_org_type,
             SUM(CASE WHEN capability IS NOT NULL AND TRIM(capability) <> '' THEN 1 ELSE 0 END) AS has_capability,
             SUM(CASE WHEN address_city IS NOT NULL AND TRIM(address_city) <> '' THEN 1 ELSE 0 END) AS has_city,
             SUM(CASE WHEN address_stateorregion IS NOT NULL AND TRIM(address_stateorregion) <> '' THEN 1 ELSE 0 END) AS has_state,
             SUM(CASE WHEN source_types IS NOT NULL AND TRIM(source_types) <> ''
                  AND SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')) >= 2 THEN 1 ELSE 0 END) AS multi_source
           FROM ${SRC}.facilities`,
        );
        const row = result[0] ?? {};
        res.json({
          metrics: {
            total:          Number(row.total          ?? 0),
            valid_gps:      Number(row.valid_gps      ?? 0),
            has_org_type:   Number(row.has_org_type   ?? 0),
            has_capability: Number(row.has_capability ?? 0),
            has_city:       Number(row.has_city       ?? 0),
            has_state:      Number(row.has_state      ?? 0),
            multi_source:   Number(row.multi_source   ?? 0),
          },
        });
      } catch (err) {
        console.error('[data-readiness/quality-metrics] Query failed:', err);
        res.status(500).json({ error: 'Failed to load quality metrics' });
      }
    });

    app.get('/api/desert/capability-summary', async (_req, res) => {
      try {
        const cacheKey = 'capability-summary';
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) { res.json({ summary: cached, syncing: false }); return; }

        const result = await appkit.analytics.query(
          `SELECT
             COALESCE(NULLIF(TRIM(capability), ''), 'Unknown') AS capability,
             COUNT(*) AS facility_count,
             ROUND(
               AVG(LEAST(COALESCE(SIZE(SPLIT(NULLIF(TRIM(source_types), ''), ',')), 1) / 3.0, 1.0)),
               2
             ) AS avg_trust_weight,
             COUNT(DISTINCT address_stateorregion) AS state_count
           FROM ${SRC}.facilities
           WHERE capability IS NOT NULL AND TRIM(capability) <> ''
           GROUP BY COALESCE(NULLIF(TRIM(capability), ''), 'Unknown')
           ORDER BY facility_count DESC
           LIMIT 20`,
        );

        setCached(cacheKey, result);
        res.json({ summary: result, syncing: false });
      } catch (err) {
        console.error('[desert/capability-summary] Query failed:', err);
        res.status(500).json({ error: 'Failed to load capability summary' });
      }
    });

    // ── Track 4: Data Readiness Desk ──────────────────────────────────────────

    app.get('/api/readiness/profile', async (_req, res) => {
      try {
        const { profile, total } = await computeProfile();
        res.json({ profile, total, syncing: false });
      } catch (err) {
        console.error('[readiness/profile] Query failed:', err);
        res.status(500).json({ error: 'Failed to load readiness profile' });
      }
    });

    app.get('/api/readiness/issues', async (_req, res) => {
      try {
        const cached = getCached<Record<string, unknown>>(ISSUES_CACHE_KEY);
        if (cached) { res.json({ ...cached, syncing: false }); return; }

        // COUNTS_SQL and computeProfile are all-or-nothing; if either rejects → 500.
        // The six list queries are independently degradable via allSettled.
        const [countRows, profileResult] = await Promise.all([
          appkit.analytics.query(COUNTS_SQL),
          computeProfile(),
        ]);

        const listSettled = await Promise.allSettled([
          appkit.analytics.query(DUPLICATES_SQL),       // 0
          appkit.analytics.query(NULLBYTES_SQL),        // 1
          appkit.analytics.query(GEO_SQL),              // 2
          appkit.analytics.query(SOURCE_MISMATCH_SQL),  // 3
          appkit.analytics.query(CONTRADICTIONS_SQL),   // 4
          appkit.analytics.query(SUSPICIOUS_SQL),       // 5
        ]);

        const listOf = (i: number): Record<string, unknown>[] => {
          const r = listSettled[i];
          if (r.status === 'fulfilled') return r.value;
          console.error(`[readiness/issues] list query ${i} failed:`, r.reason);
          return [];
        };

        const listErrors = {
          duplicates: listSettled[0].status === 'rejected',
          nullBytes: listSettled[1].status === 'rejected',
          geoContradictions: listSettled[2].status === 'rejected',
          sourceMismatch: listSettled[3].status === 'rejected',
          contradictions: listSettled[4].status === 'rejected',
          suspicious: listSettled[5].status === 'rejected',
        };
        const anyListFailed = Object.values(listErrors).some(Boolean);

        const c = countRows[0] ?? {};
        const sparseFields = profileResult.profile
          .filter(f => f.fillRate < 0.5)
          .map(f => ({ key: f.key, label: f.label, fillRate: f.fillRate }));

        const num = (v: unknown) => Number(v ?? 0);
        const coerceId = <T extends Record<string, unknown>>(r: T) =>
          ({ ...r, facility_id: num(r.facility_id) });

        const body = {
          duplicates:       listOf(0).map(r => ({ ...coerceId(r), dup_count: num(r.dup_count) })),
          nullBytes:        listOf(1).map(coerceId),
          geoContradictions:listOf(2).map(coerceId),
          sourceMismatch:   listOf(3).map(coerceId),
          contradictions:   listOf(4).map(coerceId),
          suspicious:       listOf(5).map(coerceId),
          listErrors,
          sparseFields,
          issueCounts: {
            duplicate:     num(c.duplicate_id_count),
            duplicateRows: num(c.duplicate_row_count),
            nullByte:      num(c.nullbyte_count),
            geo:           num(c.geo_count),
            sourceMismatch:num(c.sourcemismatch_count),
            contradiction: num(c.contradiction_count),
            suspicious:    num(c.suspicious_count),
            total:         num(c.total_issue_count),
          },
        };

        // Cache only when non-empty and all lists succeeded (findings 2, 3, 13).
        if (profileResult.total > 0 && !anyListFailed) {
          setCached(ISSUES_CACHE_KEY, body);
        }

        res.json({ ...body, syncing: false });
      } catch (err) {
        console.error('[readiness/issues] Query failed:', err);
        res.status(500).json({ error: 'Failed to load readiness issues' });
      }
    });

    app.get('/api/readiness/top-records', async (_req, res) => {
      try {
        const cached = getCached<{ records: unknown[]; flaggedTotal: number }>(TOP_RECORDS_CACHE_KEY);
        if (cached) { res.json({ ...cached, syncing: false }); return; }

        const [recordRows, flaggedRows] = await Promise.all([
          appkit.analytics.query(TOP_RECORDS_SQL),
          appkit.analytics.query(FLAGGED_COUNT_SQL),
        ]);
        const num = (v: unknown) => Number(v ?? 0);
        const records = recordRows.map(r => ({
          ...r,
          facility_id: num(r.facility_id),
          issue_score: num(r.issue_score),
          heavy_score: num(r.heavy_score),
        }));
        const flaggedTotal = num(flaggedRows[0]?.flagged_count);

        // Do not cache an empty result — prevents freezing a false "all clean" state.
        if (records.length > 0) setCached(TOP_RECORDS_CACHE_KEY, { records, flaggedTotal });

        res.json({ records, flaggedTotal, syncing: false });
      } catch (err) {
        console.error('[readiness/top-records] Query failed:', err);
        res.status(500).json({ error: 'Failed to load top records' });
      }
    });
  });
}
