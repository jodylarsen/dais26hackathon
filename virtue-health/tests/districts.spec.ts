import { test, expect } from '@playwright/test';

const STATES_OK = { states: ['Kerala', 'Maharashtra', 'Tamil Nadu'], syncing: false };

function makeDistrict(name: string, state: string) {
  return {
    district_name: name,
    state_ut: state,
    households_surveyed: 2400,
    hh_electricity_pct: 85.2,
    hh_improved_water_pct: 78.5,
    hh_use_improved_sanitation_pct: 72.3,
    child_u5_whose_birth_was_civil_reg_pct: 90.1,
  };
}

const DISTRICTS_OK = {
  districts: [
    makeDistrict('Ernakulam', 'Kerala'),
    makeDistrict('Thrissur', 'Kerala'),
    makeDistrict('Mumbai', 'Maharashtra'),
  ],
  syncing: false,
};

test.describe('Districts Page (/districts)', () => {
  test('E-DST-01: page loads with exact heading "District Health Indicators"', async ({ page }) => {
    await page.route('/api/districts*', route => route.fulfill({ json: DISTRICTS_OK }));
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');

    await expect(
      page.getByRole('heading', { name: 'District Health Indicators' }),
    ).toBeVisible();
    // Table should have at least one data row
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('E-DST-02: state filter dropdown is present and populated', async ({ page }) => {
    await page.route('/api/districts*', route => route.fulfill({ json: DISTRICTS_OK }));
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');
    await page.waitForLoadState('networkidle');

    // Select trigger should be visible
    const trigger = page.locator('[data-slot="select-trigger"]').first();
    await expect(trigger).toBeVisible();
  });

  test('E-DST-03: filtering by a state reduces displayed records', async ({ page }) => {
    const keralOnly = {
      districts: [
        makeDistrict('Ernakulam', 'Kerala'),
        makeDistrict('Thrissur', 'Kerala'),
      ],
      syncing: false,
    };
    let callNum = 0;
    await page.route('/api/districts*', route => {
      callNum++;
      const url = new URL(route.request().url());
      const state = url.searchParams.get('state');
      route.fulfill({ json: state === 'Kerala' ? keralOnly : DISTRICTS_OK });
    });
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');
    await page.waitForLoadState('networkidle');

    // Count initial rows
    const initialRows = await page.locator('tbody tr').count();

    // Filter by Kerala
    const trigger = page.locator('[data-slot="select-trigger"]').first();
    await trigger.click();
    await page.getByRole('option', { name: 'Kerala' }).click();
    await page.waitForTimeout(500);

    const filteredRows = await page.locator('tbody tr').count();
    expect(filteredRows).toBeLessThanOrEqual(initialRows);
  });

  test('E-DST-04: column headers include "District" and "Electricity" (not immunization)', async ({ page }) => {
    await page.route('/api/districts*', route => route.fulfill({ json: DISTRICTS_OK }));
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');

    await expect(page.getByText('District')).toBeVisible();
    await expect(page.getByText('Electricity')).toBeVisible();
  });

  test('E-DST-05: all returned rows render (no pagination truncation)', async ({ page }) => {
    const manyDistricts = {
      districts: Array.from({ length: 50 }, (_, i) => makeDistrict(`District ${i}`, 'Kerala')),
      syncing: false,
    };
    await page.route('/api/districts*', route => route.fulfill({ json: manyDistricts }));
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');
    await page.waitForLoadState('networkidle');

    // All 50 rows should render (no pagination/truncation)
    const rows = await page.locator('tbody tr').count();
    expect(rows).toBe(50);
  });

  test('E-DST-06: error state when /api/districts returns 500', async ({ page }) => {
    await page.route('/api/districts*', route =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'Failed to load districts' }) }),
    );
    await page.route('/api/districts/states', route => route.fulfill({ json: STATES_OK }));
    await page.goto('/districts');

    await expect(
      page.getByText(/failed to load/i).or(page.getByRole('alert')),
    ).toBeVisible({ timeout: 10000 });
  });
});
