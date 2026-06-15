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

interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

function isRelationNotFound(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return msg.includes('does not exist') || msg.includes('42P01');
}

export function setupVirtueHealthRoutes(appkit: AppKitWithLakebase) {
  appkit.server.extend((app) => {
    app.get('/api/summary', async (_req, res) => {
      try {
        const [facilitiesResult, nfhsResult] = await Promise.all([
          appkit.lakebase.query(
            `SELECT COUNT(*)::int AS total_facilities FROM hackathon.facilities`,
          ),
          appkit.lakebase.query(
            `SELECT
               COUNT(DISTINCT state_ut)::int AS states_covered,
               COUNT(DISTINCT district_name)::int AS districts_covered,
               ROUND(AVG(sex_ratio_total_f_per_1000_m)::numeric, 1)::float AS avg_sex_ratio
             FROM hackathon.nfhs_5_district_health_indicators`,
          ),
        ]);

        const totalFacilities = (facilitiesResult.rows[0]?.total_facilities as number) ?? 0;
        const statesCovered = (nfhsResult.rows[0]?.states_covered as number) ?? 0;
        const districtsCovered = (nfhsResult.rows[0]?.districts_covered as number) ?? 0;
        const avgSexRatio = (nfhsResult.rows[0]?.avg_sex_ratio as number) ?? null;

        res.json({
          totalFacilities,
          statesCovered,
          districtsCovered,
          avgSexRatio,
          syncing: false,
        });
      } catch (err) {
        if (isRelationNotFound(err)) {
          res.json({ syncing: true });
        } else {
          console.error('[summary] Query failed:', err);
          res.status(500).json({ error: 'Failed to load summary' });
        }
      }
    });

    app.get('/api/facilities', async (req, res) => {
      try {
        const search = (req.query.search as string | undefined) ?? '';
        const state = (req.query.state as string | undefined) ?? '';
        const page = Math.max(1, parseInt((req.query.page as string | undefined) ?? '1', 10));
        const pageSize = 50;
        const offset = (page - 1) * pageSize;

        const params: unknown[] = [];
        const conditions: string[] = [];

        if (search) {
          params.push(`%${search}%`);
          conditions.push(
            `(name ILIKE $${params.length} OR address_city ILIKE $${params.length})`,
          );
        }

        if (state) {
          params.push(state);
          conditions.push(`address_stateorregion = $${params.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(pageSize);
        const limitParam = `$${params.length}`;
        params.push(offset);
        const offsetParam = `$${params.length}`;

        const [dataResult, countResult] = await Promise.all([
          appkit.lakebase.query(
            `SELECT
               unique_id,
               name,
               organization_type,
               address_city,
               address_stateorregion,
               address_country
             FROM hackathon.facilities
             ${whereClause}
             ORDER BY name ASC
             LIMIT ${limitParam} OFFSET ${offsetParam}`,
            params,
          ),
          appkit.lakebase.query(
            `SELECT COUNT(*)::int AS total FROM hackathon.facilities ${whereClause}`,
            params.slice(0, params.length - 2),
          ),
        ]);

        const total = (countResult.rows[0]?.total as number) ?? 0;

        res.json({
          facilities: dataResult.rows,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
          syncing: false,
        });
      } catch (err) {
        if (isRelationNotFound(err)) {
          res.json({ syncing: true });
        } else {
          console.error('[facilities] Query failed:', err);
          res.status(500).json({ error: 'Failed to load facilities' });
        }
      }
    });

    app.get('/api/facilities/states', async (_req, res) => {
      try {
        const result = await appkit.lakebase.query(
          `SELECT DISTINCT address_stateorregion AS state
           FROM hackathon.facilities
           WHERE address_stateorregion IS NOT NULL AND address_stateorregion <> ''
           ORDER BY address_stateorregion ASC`,
        );
        res.json({ states: result.rows.map((r) => r.state as string), syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) {
          res.json({ syncing: true, states: [] });
        } else {
          console.error('[facilities/states] Query failed:', err);
          res.status(500).json({ error: 'Failed to load states' });
        }
      }
    });

    app.get('/api/districts', async (req, res) => {
      try {
        const state = (req.query.state as string | undefined) ?? '';
        const params: unknown[] = [];

        let whereClause = '';
        if (state) {
          params.push(state);
          whereClause = `WHERE state_ut = $1`;
        }

        const result = await appkit.lakebase.query(
          `SELECT
             district_name,
             state_ut,
             households_surveyed,
             hh_electricity_pct,
             hh_improved_water_pct,
             hh_use_improved_sanitation_pct,
             child_u5_whose_birth_was_civil_reg_pct
           FROM hackathon.nfhs_5_district_health_indicators
           ${whereClause}
           ORDER BY state_ut ASC, district_name ASC`,
          params,
        );

        res.json({ districts: result.rows, syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) {
          res.json({ syncing: true, districts: [] });
        } else {
          console.error('[districts] Query failed:', err);
          res.status(500).json({ error: 'Failed to load districts' });
        }
      }
    });

    // ── Track 2: Medical Desert Planner ──────────────────────────────────────

    app.get('/api/desert/heatmap-points', async (req, res) => {
      try {
        const capability = (req.query.capability as string | undefined) ?? '';
        const cacheKey = `heatmap-points:${capability}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) {
          res.json({ points: cached, syncing: false });
          return;
        }

        const params: unknown[] = [];
        const capClause = capability
          ? (params.push(`%${capability}%`), `AND capability ILIKE $${params.length}`)
          : '';

        const result = await appkit.lakebase.query(
          `SELECT
             unique_id,
             CAST(latitude AS float)  AS latitude,
             CAST(longitude AS float) AS longitude,
             LEAST(
               COALESCE(
                 ARRAY_LENGTH(STRING_TO_ARRAY(NULLIF(TRIM(source_types), ''), ','), 1),
                 1
               )::float / 3.0,
               1.0
             ) AS trust_weight,
             capability,
             address_stateorregion
           FROM hackathon.facilities
           WHERE
             latitude IS NOT NULL
             AND longitude IS NOT NULL
             AND CAST(latitude AS float) BETWEEN 6.0 AND 37.5
             AND CAST(longitude AS float) BETWEEN 68.0 AND 97.5
             ${capClause}`,
          params,
        );

        setCached(cacheKey, result.rows);
        res.json({ points: result.rows, syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) res.json({ points: [], syncing: true });
        else {
          console.error('[desert/heatmap-points] Query failed:', err);
          res.status(500).json({ error: 'Failed to load heatmap points' });
        }
      }
    });

    app.get('/api/desert/state-gaps', async (req, res) => {
      try {
        const capability = (req.query.capability as string | undefined) ?? '';
        const cacheKey = `state-gaps:${capability}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) {
          res.json({ gaps: cached, syncing: false });
          return;
        }

        const params: unknown[] = [];
        const capClause = capability
          ? (params.push(`%${capability}%`), `AND capability ILIKE $${params.length}`)
          : '';

        const result = await appkit.lakebase.query(
          `WITH facility_state AS (
             SELECT
               LOWER(TRIM(address_stateorregion)) AS state_key,
               address_stateorregion,
               COUNT(*)::int AS facility_count,
               AVG(
                 LEAST(
                   COALESCE(
                     ARRAY_LENGTH(STRING_TO_ARRAY(NULLIF(TRIM(source_types), ''), ','), 1),
                     1
                   )::float / 3.0,
                   1.0
                 )
               ) AS avg_trust_weight,
               COUNT(DISTINCT source_types)::int AS source_type_variants
             FROM hackathon.facilities
             WHERE address_stateorregion IS NOT NULL AND address_stateorregion <> ''
               ${capClause}
             GROUP BY LOWER(TRIM(address_stateorregion)), address_stateorregion
           ),
           nfhs_state AS (
             SELECT
               LOWER(TRIM(state_ut)) AS state_key,
               state_ut,
               COUNT(DISTINCT district_name)::int AS district_count,
               AVG(hh_electricity_pct) AS avg_electricity,
               AVG(hh_improved_water_pct) AS avg_water,
               AVG(hh_use_improved_sanitation_pct) AS avg_sanitation,
               AVG(child_u5_whose_birth_was_civil_reg_pct) AS avg_birth_reg,
               ROUND((
                 (100.0 - COALESCE(AVG(hh_electricity_pct), 50))
                 + (100.0 - COALESCE(AVG(hh_improved_water_pct), 50))
                 + (100.0 - COALESCE(AVG(hh_use_improved_sanitation_pct), 50))
                 + (100.0 - COALESCE(AVG(child_u5_whose_birth_was_civil_reg_pct), 50))
               ) / 4.0, 1)::float AS demand_index
             FROM hackathon.nfhs_5_district_health_indicators
             GROUP BY LOWER(TRIM(state_ut)), state_ut
           )
           SELECT
             COALESCE(ns.state_ut, fs.address_stateorregion) AS state,
             COALESCE(fs.facility_count, 0)::int AS facility_count,
             ROUND(COALESCE(fs.avg_trust_weight, 0)::numeric, 3)::float AS avg_trust_weight,
             COALESCE(fs.source_type_variants, 0)::int AS source_type_variants,
             ns.demand_index,
             ns.district_count,
             ROUND((COALESCE(fs.facility_count, 0)::float * COALESCE(fs.avg_trust_weight, 0.0)) / 10.0, 2)::float AS supply_score,
             ROUND(
               COALESCE(ns.demand_index, 50) /
               GREATEST(
                 (COALESCE(fs.facility_count, 0)::float * COALESCE(fs.avg_trust_weight, 0.0)) / 10.0,
                 0.1
               ),
               2
             )::float AS gap_score
           FROM nfhs_state ns
           FULL OUTER JOIN facility_state fs ON ns.state_key = fs.state_key
           ORDER BY gap_score DESC NULLS LAST`,
          params,
        );

        const gaps = result.rows.map((row) => {
          const variants = (row.source_type_variants as number) ?? 0;
          const confidence: 'high' | 'medium' | 'low' =
            variants >= 3 ? 'high' : variants >= 1 ? 'medium' : 'low';
          return { ...row, confidence };
        });

        setCached(cacheKey, gaps);
        res.json({ gaps, syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) res.json({ gaps: [], syncing: true });
        else {
          console.error('[desert/state-gaps] Query failed:', err);
          res.status(500).json({ error: 'Failed to load state gaps' });
        }
      }
    });

    app.get('/api/desert/capability-summary', async (_req, res) => {
      try {
        const cacheKey = 'capability-summary';
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) {
          res.json({ summary: cached, syncing: false });
          return;
        }

        const result = await appkit.lakebase.query(
          `SELECT
             COALESCE(NULLIF(TRIM(capability), ''), 'Unknown') AS capability,
             COUNT(*)::int AS facility_count,
             ROUND(
               AVG(
                 LEAST(
                   COALESCE(
                     ARRAY_LENGTH(STRING_TO_ARRAY(NULLIF(TRIM(source_types), ''), ','), 1),
                     1
                   )::float / 3.0,
                   1.0
                 )
               )::numeric,
               2
             )::float AS avg_trust_weight,
             COUNT(DISTINCT address_stateorregion)::int AS state_count
           FROM hackathon.facilities
           WHERE capability IS NOT NULL AND TRIM(capability) <> ''
           GROUP BY COALESCE(NULLIF(TRIM(capability), ''), 'Unknown')
           ORDER BY facility_count DESC
           LIMIT 20`,
        );

        setCached(cacheKey, result.rows);
        res.json({ summary: result.rows, syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) res.json({ summary: [], syncing: true });
        else {
          console.error('[desert/capability-summary] Query failed:', err);
          res.status(500).json({ error: 'Failed to load capability summary' });
        }
      }
    });

    app.get('/api/districts/states', async (_req, res) => {
      try {
        const result = await appkit.lakebase.query(
          `SELECT DISTINCT state_ut AS state
           FROM hackathon.nfhs_5_district_health_indicators
           WHERE state_ut IS NOT NULL
           ORDER BY state_ut ASC`,
        );
        res.json({ states: result.rows.map((r) => r.state as string), syncing: false });
      } catch (err) {
        if (isRelationNotFound(err)) {
          res.json({ syncing: true, states: [] });
        } else {
          console.error('[districts/states] Query failed:', err);
          res.status(500).json({ error: 'Failed to load district states' });
        }
      }
    });
  });
}
