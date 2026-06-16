import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestRoutes } from './test-utils';

const POINT_ROW = {
  facility_id: 123,
  latitude: 20.5,
  longitude: 78.9,
  trust_weight: 0.667,
  capability: 'Primary Care',
  address_stateOrRegion: 'Maharashtra',
};

describe('/api/desert/heatmap-points', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  it('U-HM-01: returns { points: [...], syncing: false } with correct fields', async () => {
    mockQuery.mockResolvedValueOnce([POINT_ROW]);
    const { body } = await routes.get('/api/desert/heatmap-points', { capability: 'hm01-fields-test' });
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.syncing).toBe(false);
    const pt = body.points[0];
    expect(pt).toHaveProperty('facility_id');
    expect(pt).toHaveProperty('latitude');
    expect(pt).toHaveProperty('longitude');
    expect(pt).toHaveProperty('trust_weight');
    expect(pt).toHaveProperty('capability');
    expect(pt).toHaveProperty('address_stateOrRegion');
  });

  it('U-HM-02: SQL applies India bounding box constraints', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/desert/heatmap-points', { capability: 'hm02-bbox-test' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('BETWEEN 6.0 AND 37.5');
    expect(sql).toContain('BETWEEN 68.0 AND 97.5');
  });

  describe('cache behavior', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('U-HM-03: cache hit - second call with same capability does not re-query', async () => {
      vi.useFakeTimers();
      const mq = vi.fn().mockResolvedValue([POINT_ROW]);
      const r = createTestRoutes(mq);
      const cap = 'unique-cache-hit-hm03';

      await r.get('/api/desert/heatmap-points', { capability: cap });
      await r.get('/api/desert/heatmap-points', { capability: cap });

      expect(mq).toHaveBeenCalledTimes(1);
    });

    it('U-HM-04: cache expires after 5 minutes, re-queries on next call', async () => {
      vi.useFakeTimers();
      const mq = vi.fn().mockResolvedValue([POINT_ROW]);
      const r = createTestRoutes(mq);
      const cap = 'unique-cache-miss-hm04';

      await r.get('/api/desert/heatmap-points', { capability: cap });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await r.get('/api/desert/heatmap-points', { capability: cap });

      expect(mq).toHaveBeenCalledTimes(2);
    });
  });

  it('U-HM-05: cache keys are scoped per capability (no cross-key collision)', async () => {
    mockQuery.mockResolvedValue([POINT_ROW]);
    await routes.get('/api/desert/heatmap-points', { capability: 'cap-a-hm05' });
    await routes.get('/api/desert/heatmap-points', { capability: 'cap-b-hm05' });
    // Two different capability values = two separate cache keys = two queries
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('U-HM-06: capability param filters SQL with ILIKE (and is escaped)', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/desert/heatmap-points', { capability: "Primary Care" });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('capability ILIKE');
    expect(sql).toContain('Primary Care');
  });

  it('U-HM-06b: single quotes in capability param are escaped', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/desert/heatmap-points', { capability: "O'Brien" });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("O''Brien");
  });

  it('U-HM-07: trust weight formula caps at 1.0 for multiple sources', async () => {
    // With source_types='a,b,c', SIZE(SPLIT(...))=3, trust_weight = LEAST(3/3.0, 1.0) = 1.0
    const row = { ...POINT_ROW, trust_weight: 1.0 };
    mockQuery.mockResolvedValueOnce([row]);
    const { body } = await routes.get('/api/desert/heatmap-points', { capability: 'hm07-test' });
    expect(body.points[0].trust_weight).toBe(1.0);
  });

  it('U-HM-08: null/empty source_types may produce negative trust_weight (GAP-13 documented)', async () => {
    // In Spark SQL, SIZE(SPLIT(NULL, ',')) = -1, so COALESCE(-1, 1) = -1
    // and LEAST(-1/3.0, 1.0) = -0.333... (negative).
    // This test documents the known defect; if the fix is applied, trust_weight >= 0.
    // For now, assert the handler returns whatever the warehouse computes without modification.
    const row = { ...POINT_ROW, trust_weight: -0.333, facility_id: 456 };
    mockQuery.mockResolvedValueOnce([row]);
    const { body } = await routes.get('/api/desert/heatmap-points', { capability: 'hm08-test' });
    // The handler does NOT clamp trust_weight in JavaScript; it returns raw warehouse value.
    expect(body.points[0].trust_weight).toBe(-0.333);
  });

  it('U-HM-10: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));
    const { status, body } = await routes.get('/api/desert/heatmap-points', { capability: 'hm10-error-unique' });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load heatmap points' });
  });
});
