import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestRoutes } from './test-utils';

const FACILITY_ROW = {
  facility_id: 123,
  name: 'Apollo Hospital',
  organization_type: 'Private',
  address_city: 'Mumbai',
  address_stateOrRegion: 'Maharashtra',
  address_country: 'India',
};

describe('/api/facilities', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createTestRoutes>;

  beforeEach(() => {
    mockQuery = vi.fn();
    routes = createTestRoutes(mockQuery);
  });

  function mockPage(rows = [FACILITY_ROW], total = 1) {
    mockQuery
      .mockResolvedValueOnce(rows)       // data query
      .mockResolvedValueOnce([{ total }]); // count query
  }

  it('U-FAC-01: returns paginated object with page=1 defaults', async () => {
    mockPage();
    const { body } = await routes.get('/api/facilities');
    expect(Array.isArray(body.facilities)).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(typeof body.totalPages).toBe('number');
    expect(body.syncing).toBe(false);
  });

  it('U-FAC-02: each facility row has exactly the 6 selected columns (facility_id number)', async () => {
    mockPage([FACILITY_ROW]);
    const { body } = await routes.get('/api/facilities');
    const row = body.facilities[0];
    expect(row).toHaveProperty('facility_id');
    expect(typeof row.facility_id).toBe('number');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('organization_type');
    expect(row).toHaveProperty('address_city');
    expect(row).toHaveProperty('address_stateOrRegion');
    expect(row).toHaveProperty('address_country');
    // fields NOT selected
    expect(row).not.toHaveProperty('latitude');
    expect(row).not.toHaveProperty('longitude');
    expect(row).not.toHaveProperty('description');
  });

  it('U-FAC-03: search param produces ILIKE clause in SQL for name and city', async () => {
    mockPage();
    await routes.get('/api/facilities', { search: 'Apollo' });
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(allSql).toContain('ILIKE');
    expect(allSql.toLowerCase()).toContain('apollo');
    expect(allSql.toLowerCase()).toContain('address_city');
  });

  it('U-FAC-04: state param produces address_stateOrRegion = ... clause in SQL', async () => {
    mockPage();
    await routes.get('/api/facilities', { state: 'Maharashtra' });
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(allSql).toContain('address_stateOrRegion');
    expect(allSql).toContain('Maharashtra');
  });

  it('U-FAC-05: page=2 generates OFFSET 50 in SQL', async () => {
    mockPage();
    await routes.get('/api/facilities', { page: '2' });
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(allSql).toContain('OFFSET 50');
  });

  it('U-FAC-06: no search or state yields SQL with no WHERE clause', async () => {
    mockPage();
    await routes.get('/api/facilities');
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(allSql).not.toContain('WHERE');
  });

  it('U-FAC-07: empty result returns { facilities: [], total: 0, totalPages: 0 }', async () => {
    mockPage([], 0);
    const { body } = await routes.get('/api/facilities');
    expect(body.facilities).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.totalPages).toBe(0);
  });

  it('U-FAC-08: single quotes in search are escaped (O\'Brien → O\'\'Brien in SQL)', async () => {
    mockPage();
    await routes.get('/api/facilities', { search: "O'Brien" });
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    // Handler uses .replace(/'/g, "''") before interpolation
    expect(allSql).toContain("O''Brien");
  });

  it('U-FAC-08b: single quotes in state param are escaped', async () => {
    mockPage();
    await routes.get('/api/facilities', { state: "X'); DROP TABLE facilities--" });
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    // The single quote should be doubled, not passed raw
    expect(allSql).not.toContain("X'); DROP TABLE");
    expect(allSql).toContain("X''); DROP TABLE");
  });

  it('U-FAC-09: page beyond totalPages returns HTTP 200 with empty facilities (no over-range error)', async () => {
    mockPage([], 10);
    const { status, body } = await routes.get('/api/facilities', { page: '5000' });
    expect(status).toBe(200);
    expect(body.facilities).toHaveLength(0);
    expect(body.total).toBe(10);
    // SQL contains large OFFSET
    const allSql = mockQuery.mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(allSql).toContain('OFFSET 249950');
  });

  it('U-FAC-10: HTTP 500 on warehouse error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('query timeout'));
    const { status, body } = await routes.get('/api/facilities');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to load facilities' });
  });
});
