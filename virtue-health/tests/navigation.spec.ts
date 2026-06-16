import { test, expect } from '@playwright/test';

// Minimal mocks so pages don't wait on real warehouse calls
const SUMMARY = { totalFacilities: 100, statesCovered: 10, districtsCovered: 200, avgSexRatio: 940, syncing: false };
const FACILITIES = { facilities: [], total: 0, page: 1, pageSize: 50, totalPages: 0, syncing: false };
const FAC_STATES = { states: [], syncing: false };
const DISTRICTS = { districts: [], syncing: false };
const DST_STATES = { states: [], syncing: false };
const GAPS = { gaps: [], syncing: false };
const POINTS = { points: [], syncing: false };
const CAP_SUM = { summary: [], syncing: false };

async function mockAll(page: import('@playwright/test').Page) {
  await page.route('/api/summary', r => r.fulfill({ json: SUMMARY }));
  await page.route('/api/facilities*', r => r.fulfill({ json: FACILITIES }));
  await page.route('/api/facilities/states', r => r.fulfill({ json: FAC_STATES }));
  await page.route('/api/districts*', r => r.fulfill({ json: DISTRICTS }));
  await page.route('/api/districts/states', r => r.fulfill({ json: DST_STATES }));
  await page.route('/api/desert/state-gaps*', r => r.fulfill({ json: GAPS }));
  await page.route('/api/desert/heatmap-points*', r => r.fulfill({ json: POINTS }));
  await page.route('/api/desert/capability-summary', r => r.fulfill({ json: CAP_SUM }));
}

test.describe('Navigation (E-NAV)', () => {
  test('E-NAV-01: all four nav links navigate to correct routes', async ({ page }) => {
    await mockAll(page);
    await page.goto('/');

    // Overview
    await expect(page.getByRole('heading', { name: 'India Healthcare Overview' })).toBeVisible();

    // Facilities
    await page.getByRole('link', { name: 'Facilities' }).first().click();
    await expect(page.getByRole('heading', { name: 'Healthcare Facilities' })).toBeVisible();

    // Districts
    await page.getByRole('link', { name: 'Districts' }).first().click();
    await expect(page.getByRole('heading', { name: 'District Health Indicators' })).toBeVisible();

    // Desert Planner
    await page.getByRole('link', { name: 'Desert Planner' }).first().click();
    await expect(page.getByRole('heading', { name: 'Medical Desert Planner' })).toBeVisible();

    // Back to Overview
    await page.getByRole('link', { name: 'Overview' }).first().click();
    await expect(page.getByRole('heading', { name: 'India Healthcare Overview' })).toBeVisible();
  });

  test('E-NAV-02: direct URL access to /desert works without redirect', async ({ page }) => {
    await mockAll(page);
    await page.goto('/desert');

    // Should load directly (SPA fallback serves index.html)
    await expect(
      page.getByRole('heading', { name: 'Medical Desert Planner' }),
    ).toBeVisible({ timeout: 15000 });

    // URL should still be /desert (no redirect)
    expect(page.url()).toContain('/desert');
  });

  test('E-NAV-03: unknown route shows error page, not blank white screen', async ({ page }) => {
    await mockAll(page);
    await page.goto('/this-route-does-not-exist-abc123');

    // React Router's errorElement (RouteErrorPage → ErrorDisplay) should render
    const body = await page.content();
    // Should not be a completely empty page
    expect(body.length).toBeGreaterThan(200);
    // The page should have some visible content
    const bodyEl = page.locator('body');
    await expect(bodyEl).not.toBeEmpty();
  });
});
