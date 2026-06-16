import { describe, it, expect, vi, beforeEach } from 'vitest';

// capability-summary uses a fixed cache key with no param, so the module-level desertCache
// persists across tests within a file. Use vi.resetModules() + dynamic import per test
// to get a fresh cache for each test.

const SUMMARY_ROW = {
  capability: 'Primary Care',
  facility_count: 1200,
  avg_trust_weight: 0.65,
  state_count: 22,
};

async function freshRoutes(mockQuery: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  const { createTestRoutes } = await import('./test-utils');
  return createTestRoutes(mockQuery);
}

describe('/api/desert/capability-summary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('U-CS-01: returns { summary: [...], syncing: false } with at most 20 entries', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...SUMMARY_ROW,
      capability: `Cap-${i}`,
      facility_count: 1000 - i * 10,
    }));
    const mockQuery = vi.fn().mockResolvedValueOnce(rows);
    const routes = await freshRoutes(mockQuery);
    const { body } = await routes.get('/api/desert/capability-summary');
    expect(Array.isArray(body.summary)).toBe(true);
    expect(body.summary.length).toBeLessThanOrEqual(20);
    expect(body.syncing).toBe(false);
  });

  it('U-CS-02: each summary entry has required fields', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce([SUMMARY_ROW]);
    const routes = await freshRoutes(mockQuery);
    const { body } = await routes.get('/api/desert/capability-summary');
    const entry = body.summary[0];
    expect(entry).toHaveProperty('capability');
    expect(entry).toHaveProperty('facility_count');
    expect(entry).toHaveProperty('avg_trust_weight');
    expect(entry).toHaveProperty('state_count');
  });

  it('U-CS-03: raw capability grouping — composite string stays as one bucket (no comma split)', async () => {
    const compositeRow = { ...SUMMARY_ROW, capability: 'Emergency,Surgery,ICU', facility_count: 50 };
    const mockQuery = vi.fn().mockResolvedValueOnce([compositeRow]);
    const routes = await freshRoutes(mockQuery);
    const { body } = await routes.get('/api/desert/capability-summary');
    // The handler returns what SQL provides — no comma splitting
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0].capability).toBe('Emergency,Surgery,ICU');
  });

  it('U-CS-04: cache hit — second request uses cache, query called once', async () => {
    const mockQuery = vi.fn().mockResolvedValueOnce([SUMMARY_ROW]);
    const routes = await freshRoutes(mockQuery);
    // First call — hits warehouse, populates cache
    await routes.get('/api/desert/capability-summary');
    // Second call — must hit cache (same module instance, same fixed key)
    await routes.get('/api/desert/capability-summary');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('U-CS-05: HTTP 500 on warehouse error', async () => {
    const mockQuery = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    const routes = await freshRoutes(mockQuery);
    const { status, body } = await routes.get('/api/desert/capability-summary');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load capability summary' });
  });
});
