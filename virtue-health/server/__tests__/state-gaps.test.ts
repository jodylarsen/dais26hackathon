import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

function makeGapRow(overrides: Record<string, unknown> = {}) {
  return {
    state: 'Maharashtra',
    facility_count: 200,
    avg_trust_weight: 0.667,
    source_type_variants: 3,
    demand_index: 45.2,
    district_count: 36,
    supply_score: 13.34,
    gap_score: 3.39,
    ...overrides,
  };
}

describe('/api/desert/state-gaps', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  it('U-SG-01: returns { gaps: [...], syncing: false } with full field set', async () => {
    mockQuery.mockResolvedValueOnce([makeGapRow()]);
    const { body } = await routes.get('/api/desert/state-gaps', { capability: 'sg01-fields-test' });
    expect(Array.isArray(body.gaps)).toBe(true);
    expect(body.syncing).toBe(false);
    const row = body.gaps[0];
    expect(row).toHaveProperty('state');
    expect(row).toHaveProperty('facility_count');
    expect(row).toHaveProperty('avg_trust_weight');
    expect(row).toHaveProperty('source_type_variants');
    expect(row).toHaveProperty('demand_index');
    expect(row).toHaveProperty('district_count');
    expect(row).toHaveProperty('supply_score');
    expect(row).toHaveProperty('gap_score');
    expect(row).toHaveProperty('confidence');
  });

  it('U-SG-02: confidence derives from source_type_variants (all 3 boundaries)', async () => {
    mockQuery
      .mockResolvedValueOnce([makeGapRow({ source_type_variants: 3 })])   // high
      .mockResolvedValueOnce([makeGapRow({ source_type_variants: 1 })])   // medium
      .mockResolvedValueOnce([makeGapRow({ source_type_variants: 0 })]);  // low

    const { body: b1 } = await routes.get('/api/desert/state-gaps', { capability: 'sg02-high' });
    const { body: b2 } = await routes.get('/api/desert/state-gaps', { capability: 'sg02-med' });
    const { body: b3 } = await routes.get('/api/desert/state-gaps', { capability: 'sg02-low' });

    expect(b1.gaps[0].confidence).toBe('high');
    expect(b2.gaps[0].confidence).toBe('medium');
    expect(b3.gaps[0].confidence).toBe('low');
  });

  it('U-SG-02b: variants=2 → confidence medium', async () => {
    mockQuery.mockResolvedValueOnce([makeGapRow({ source_type_variants: 2 })]);
    const { body } = await routes.get('/api/desert/state-gaps', { capability: 'sg02b-test' });
    expect(body.gaps[0].confidence).toBe('medium');
  });

  it('U-SG-03: gap_score denominator is floored at 0.1 (zero supply → gap_score = demand/0.1)', async () => {
    // supply = facility_count * avg_trust_weight / 10.0 = 0 * 0 / 10 = 0
    // gap_score = ROUND(demand / GREATEST(0, 0.1)) = ROUND(1.0 / 0.1) = 10.0
    // The SQL computes this; we test that the JS handler returns what SQL provides.
    const row = makeGapRow({ facility_count: 0, avg_trust_weight: 0, demand_index: 1, supply_score: 0, gap_score: 10.0 });
    mockQuery.mockResolvedValueOnce([row]);
    const { body } = await routes.get('/api/desert/state-gaps', { capability: 'sg03-test' });
    expect(body.gaps[0].gap_score).toBe(10.0);
  });

  it('U-SG-04: demand_index null is tolerated (JS handler passes SQL row through)', async () => {
    const row = makeGapRow({ demand_index: null, gap_score: 5.0 });
    mockQuery.mockResolvedValueOnce([row]);
    const { body } = await routes.get('/api/desert/state-gaps', { capability: 'sg04-test' });
    expect(body.gaps[0].demand_index).toBeNull();
    expect(body.gaps[0].gap_score).toBe(5.0);
  });

  it('U-SG-05: cache key is scoped per capability value', async () => {
    mockQuery.mockResolvedValue([makeGapRow()]);
    await routes.get('/api/desert/state-gaps', { capability: 'sg05-cap-a' });
    await routes.get('/api/desert/state-gaps', { capability: 'sg05-cap-b' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('U-SG-06: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('warehouse timeout'));
    const { status, body } = await routes.get('/api/desert/state-gaps', { capability: 'sg06-error-unique' });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load state gaps' });
  });
});
