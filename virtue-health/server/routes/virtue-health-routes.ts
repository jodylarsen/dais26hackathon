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

interface AppKitWithAnalytics {
  analytics: {
    query(sql: string): Promise<Record<string, unknown>[]>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

export function setupVirtueHealthRoutes(appkit: AppKitWithAnalytics) {
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
  });
}
