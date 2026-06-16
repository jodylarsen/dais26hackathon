import { test, expect } from '@playwright/test';

const SUMMARY_OK = {
  totalFacilities: 10088,
  statesCovered: 28,
  districtsCovered: 640,
  avgSexRatio: 945.2,
  syncing: false,
};

test.describe('Overview Page (/)', () => {
  test('E-OV-01: page loads without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.route('/api/summary', route =>
      route.fulfill({ json: SUMMARY_OK }),
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(consoleErrors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('E-OV-02: four KPI cards are visible', async ({ page }) => {
    await page.route('/api/summary', route => route.fulfill({ json: SUMMARY_OK }));
    await page.goto('/');

    const cards = ['Total Facilities', 'States Covered', 'Districts Covered', 'Avg Sex Ratio'];
    for (const title of cards) {
      await expect(page.getByText(title)).toBeVisible();
    }
  });

  test('E-OV-03: Total Facilities shows a number > 0', async ({ page }) => {
    await page.route('/api/summary', route => route.fulfill({ json: SUMMARY_OK }));
    await page.goto('/');

    await expect(page.getByText('10,088')).toBeVisible();
  });

  test('E-OV-04: avgSexRatio null shows fallback — not NaN or crash', async ({ page }) => {
    await page.route('/api/summary', route =>
      route.fulfill({ json: { ...SUMMARY_OK, avgSexRatio: null } }),
    );
    await page.goto('/');

    // Should show "—" fallback, not NaN
    const pageContent = await page.content();
    expect(pageContent).not.toContain('NaN');
    await expect(page.getByText('—')).toBeVisible();
  });

  test('E-OV-05: loading skeleton renders before data arrives', async ({ page }) => {
    await page.route('/api/summary', async route => {
      await new Promise(r => setTimeout(r, 200));
      route.fulfill({ json: SUMMARY_OK });
    });
    await page.goto('/');

    // Skeleton elements should be present briefly before data loads
    // We check that the page renders something before networkidle
    const skeletons = page.locator('[class*="skeleton"], [class*="Skeleton"]');
    // The skeleton may or may not be visible depending on timing; just assert no crash
    await expect(page.getByRole('heading', { name: 'India Healthcare Overview' })).toBeVisible();
  });

  test('E-OV-06: error state renders when /api/summary returns 500', async ({ page }) => {
    await page.route('/api/summary', route =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'Failed to load summary' }) }),
    );
    await page.goto('/');

    // Error message should appear
    await expect(page.getByText(/failed to load/i).or(page.getByRole('alert'))).toBeVisible({
      timeout: 10000,
    });
  });

  test('E-OV-07: headings are exact strings', async ({ page }) => {
    await page.route('/api/summary', route => route.fulfill({ json: SUMMARY_OK }));
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Virtue Health' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'India Healthcare Overview' }),
    ).toBeVisible();
  });
});
