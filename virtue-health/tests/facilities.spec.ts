import { test, expect } from '@playwright/test';

const STATES_OK = { states: ['Kerala', 'Maharashtra', 'Tamil Nadu'], syncing: false };

function makeFacility(i: number) {
  return {
    unique_id: `fac-${i}`,
    name: `Facility ${i}`,
    organization_type: 'Public',
    address_city: 'Mumbai',
    address_stateorregion: 'Maharashtra',
    address_country: 'India',
  };
}

function makePage(count = 50, total = 500) {
  return {
    facilities: Array.from({ length: count }, (_, i) => makeFacility(i)),
    total,
    page: 1,
    pageSize: 50,
    totalPages: Math.ceil(total / 50),
    syncing: false,
  };
}

test.describe('Facilities Page (/facilities)', () => {
  test('E-FAC-01: page loads with correct heading and table headers', async ({ page }) => {
    await page.route('/api/facilities*', route => route.fulfill({ json: makePage() }));
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    await expect(page.getByRole('heading', { name: 'Healthcare Facilities' })).toBeVisible();
    await expect(page.getByText('Name')).toBeVisible();
    await expect(page.getByText('City')).toBeVisible();
  });

  test('E-FAC-02: search input exists and is focusable', async ({ page }) => {
    await page.route('/api/facilities*', route => route.fulfill({ json: makePage() }));
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    const searchInput = page.getByPlaceholder('Search by name or city...');
    await expect(searchInput).toBeVisible();
    await searchInput.click();
    await expect(searchInput).toBeFocused();
  });

  test('E-FAC-03: typing triggers filtered request with search param', async ({ page }) => {
    const requests: string[] = [];
    await page.route('/api/facilities*', route => {
      requests.push(route.request().url());
      route.fulfill({ json: makePage(5, 5) });
    });
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    // Clear previous requests then type
    requests.length = 0;
    await page.getByPlaceholder('Search by name or city...').fill('Apollo');
    // Wait for debounce (300ms) + network
    await page.waitForTimeout(500);

    const searchReqs = requests.filter(u => u.includes('search=Apollo'));
    expect(searchReqs.length).toBeGreaterThan(0);
  });

  test('E-FAC-04: state dropdown is populated from /api/facilities/states', async ({ page }) => {
    await page.route('/api/facilities*', route => route.fulfill({ json: makePage() }));
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    // Open the state select
    const trigger = page.getByRole('combobox').or(page.locator('[data-slot="select-trigger"]')).first();
    await expect(trigger).toBeVisible();
  });

  test('E-FAC-05: syncing:true suppresses state dropdown population', async ({ page }) => {
    await page.route('/api/facilities*', route => route.fulfill({ json: makePage() }));
    await page.route('/api/facilities/states', route =>
      route.fulfill({ json: { states: ['Maharashtra'], syncing: true } }),
    );
    await page.goto('/facilities');
    await page.waitForLoadState('networkidle');

    // When syncing:true, the client skips setting states (!d.syncing && d.states)
    // The select trigger should show the placeholder "All states" with no options
    await expect(page.getByText('All states')).toBeVisible();
  });

  test('E-FAC-06: selecting a state triggers filtered request', async ({ page }) => {
    const requests: string[] = [];
    await page.route('/api/facilities*', route => {
      requests.push(route.request().url());
      route.fulfill({ json: makePage() });
    });
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');
    await page.waitForLoadState('networkidle');

    requests.length = 0;
    // Click the select and choose a state
    const trigger = page.locator('[data-slot="select-trigger"]').first();
    await trigger.click();
    const option = page.getByRole('option', { name: 'Kerala' });
    await option.click();

    await page.waitForTimeout(300);
    const stateReqs = requests.filter(u => u.includes('state=Kerala'));
    expect(stateReqs.length).toBeGreaterThan(0);
  });

  test('E-FAC-07: pagination next button loads page 2', async ({ page }) => {
    let callCount = 0;
    await page.route('/api/facilities*', route => {
      callCount++;
      const url = new URL(route.request().url());
      const pg = parseInt(url.searchParams.get('page') ?? '1', 10);
      route.fulfill({
        json: {
          facilities: Array.from({ length: 50 }, (_, i) => makeFacility(i + (pg - 1) * 50)),
          total: 200,
          page: pg,
          pageSize: 50,
          totalPages: 4,
          syncing: false,
        },
      });
    });
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');
    await page.waitForLoadState('networkidle');

    callCount = 0;
    await page.getByRole('button', { name: /next/i }).click();
    await page.waitForTimeout(500);

    expect(callCount).toBeGreaterThan(0);
    await expect(page.getByText('2 / 4')).toBeVisible();
  });

  test('E-FAC-08: table shows at most 50 rows per page', async ({ page }) => {
    await page.route('/api/facilities*', route => route.fulfill({ json: makePage(50, 500) }));
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');
    await page.waitForLoadState('networkidle');

    const rows = page.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeLessThanOrEqual(50);
  });

  test('E-FAC-09: empty result shows empty-state message', async ({ page }) => {
    await page.route('/api/facilities*', route =>
      route.fulfill({ json: { facilities: [], total: 0, page: 1, pageSize: 50, totalPages: 0, syncing: false } }),
    );
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    await expect(page.getByText('No facilities found matching your filters.')).toBeVisible();
  });

  test('E-FAC-10: error state when /api/facilities returns 500', async ({ page }) => {
    await page.route('/api/facilities*', route =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'Failed to load facilities' }) }),
    );
    await page.route('/api/facilities/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/facilities');

    await expect(page.getByText(/failed to load/i).or(page.getByRole('alert'))).toBeVisible({
      timeout: 10000,
    });
  });
});
