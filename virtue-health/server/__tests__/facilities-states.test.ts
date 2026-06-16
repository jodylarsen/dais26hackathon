import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

describe('/api/facilities/states', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  it('U-FST-01: returns { states: string[], syncing: false }', async () => {
    mockQuery.mockResolvedValueOnce([
      { state: 'Maharashtra' },
      { state: 'Kerala' },
      { state: 'Tamil Nadu' },
    ]);
    const { body } = await routes.get('/api/facilities/states');
    expect(Array.isArray(body.states)).toBe(true);
    expect(body.states.every((s: unknown) => typeof s === 'string')).toBe(true);
    expect(body.syncing).toBe(false);
  });

  it('U-FST-02: SQL uses DISTINCT and excludes null/empty states', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/facilities/states');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('DISTINCT');
    expect(sql).toContain('address_stateOrRegion IS NOT NULL');
    expect(sql).toContain("address_stateOrRegion <> ''");
  });

  it('U-FST-03: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('warehouse down'));
    const { status, body } = await routes.get('/api/facilities/states');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load states' });
  });
});
