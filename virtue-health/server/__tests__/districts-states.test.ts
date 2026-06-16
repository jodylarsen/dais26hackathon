import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

describe('/api/districts/states', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  it('U-DSS-01: returns { states: string[], syncing: false }', async () => {
    mockQuery.mockResolvedValueOnce([
      { state: 'Kerala' },
      { state: 'Maharashtra' },
    ]);
    const { body } = await routes.get('/api/districts/states');
    expect(Array.isArray(body.states)).toBe(true);
    expect(body.states.every((s: unknown) => typeof s === 'string')).toBe(true);
    expect(body.syncing).toBe(false);
    expect(body.states).toContain('Kerala');
  });

  it('U-DSS-02: SQL uses DISTINCT state_ut', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/districts/states');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('DISTINCT state_ut');
  });

  it('U-DSS-03: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    const { status, body } = await routes.get('/api/districts/states');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load district states' });
  });
});
