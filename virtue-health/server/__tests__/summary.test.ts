import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

describe('/api/summary', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  function mockSuccess(
    totalFacilities = 10088,
    nfhs = { states_covered: 28, districts_covered: 640, avg_sex_ratio: 945.2 },
  ) {
    mockQuery
      .mockResolvedValueOnce([{ total_facilities: totalFacilities }])
      .mockResolvedValueOnce([nfhs]);
  }

  it('U-SUM-01: returns all KPI fields with valid warehouse data', async () => {
    mockSuccess();
    const { body } = await routes.get('/api/summary');
    expect(body).toHaveProperty('totalFacilities');
    expect(body).toHaveProperty('statesCovered');
    expect(body).toHaveProperty('districtsCovered');
    expect(body).toHaveProperty('avgSexRatio');
    expect(body).toHaveProperty('syncing');
  });

  it('U-SUM-02: returns HTTP 200 on success', async () => {
    mockSuccess();
    const { status } = await routes.get('/api/summary');
    expect(status).toBe(200);
  });

  it('U-SUM-03: returns HTTP 500 when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('warehouse unavailable'));
    const { status, body } = await routes.get('/api/summary');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load summary' });
  });

  it('U-SUM-04: avgSexRatio is a number when source value is non-null', async () => {
    mockSuccess(10088, { states_covered: 28, districts_covered: 640, avg_sex_ratio: 945.2 });
    const { body } = await routes.get('/api/summary');
    expect(typeof body.avgSexRatio).toBe('number');
    expect(body.avgSexRatio).toBe(945.2);
  });

  it('U-SUM-05: avgSexRatio is null when source value is null', async () => {
    mockSuccess(10088, { states_covered: 28, districts_covered: 640, avg_sex_ratio: null });
    const { body } = await routes.get('/api/summary');
    expect(body.avgSexRatio).toBeNull();
  });

  it('U-SUM-06: statesCovered and districtsCovered derive from NFHS, not facilities count', async () => {
    mockQuery
      .mockResolvedValueOnce([{ total_facilities: 99999 }])
      .mockResolvedValueOnce([{ states_covered: 28, districts_covered: 640, avg_sex_ratio: null }]);
    const { body } = await routes.get('/api/summary');
    expect(body.totalFacilities).toBe(99999);
    expect(body.statesCovered).toBe(28);
    expect(body.districtsCovered).toBe(640);
  });

  it('U-SUM-07: syncing is present and false', async () => {
    mockSuccess();
    const { body } = await routes.get('/api/summary');
    expect(body.syncing).toBe(false);
  });
});
