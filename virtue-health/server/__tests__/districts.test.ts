import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

const DISTRICT_ROW = {
  district_name: 'Ernakulam',
  state_ut: 'Kerala',
  households_surveyed: 2400,
  hh_electricity_pct: 98.2,
  hh_improved_water_pct: 91.5,
  hh_use_improved_sanitation_pct: 87.3,
  child_u5_whose_birth_was_civil_reg_pct: 95.1,
};

describe('/api/districts', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  it('U-DST-01: returns { districts: [...], syncing: false } with state param', async () => {
    mockQuery.mockResolvedValueOnce([DISTRICT_ROW]);
    const { body } = await routes.get('/api/districts', { state: 'Kerala' });
    expect(Array.isArray(body.districts)).toBe(true);
    expect(body.syncing).toBe(false);
  });

  it('U-DST-02: without state param SQL has no WHERE clause', async () => {
    mockQuery.mockResolvedValueOnce([DISTRICT_ROW]);
    await routes.get('/api/districts');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/WHERE\s+state_ut/);
  });

  it('U-DST-03: with state param SQL filters by state_ut (with escaping)', async () => {
    mockQuery.mockResolvedValueOnce([DISTRICT_ROW]);
    await routes.get('/api/districts', { state: "Tamil Nadu" });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('state_ut');
    expect(sql).toContain('Tamil Nadu');
  });

  it('U-DST-03b: single quotes in state param are escaped', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await routes.get('/api/districts', { state: "O'Malley" });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("O''Malley");
  });

  it('U-DST-04: each row has exactly the 7 selected columns', async () => {
    mockQuery.mockResolvedValueOnce([DISTRICT_ROW]);
    const { body } = await routes.get('/api/districts');
    const row = body.districts[0];
    expect(row).toHaveProperty('district_name');
    expect(row).toHaveProperty('state_ut');
    expect(row).toHaveProperty('households_surveyed');
    expect(row).toHaveProperty('hh_electricity_pct');
    expect(row).toHaveProperty('hh_improved_water_pct');
    expect(row).toHaveProperty('hh_use_improved_sanitation_pct');
    expect(row).toHaveProperty('child_u5_whose_birth_was_civil_reg_pct');
    // immunization/maternal/anemia columns are NOT selected
    expect(row).not.toHaveProperty('children_fully_vaccinated_pct');
    expect(row).not.toHaveProperty('anaemia_women_pct');
  });

  it('U-DST-05: SQL has no LIMIT or OFFSET (no pagination)', async () => {
    mockQuery.mockResolvedValueOnce([DISTRICT_ROW]);
    await routes.get('/api/districts');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('OFFSET');
  });

  it('U-DST-06: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));
    const { status, body } = await routes.get('/api/districts');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load districts' });
  });
});
