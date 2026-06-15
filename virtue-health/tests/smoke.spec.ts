import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── App configuration ─────────────────────────────────────────────────────────
const APP_CONFIG = {
  name: 'virtue-health',
} as const;

// ── Tests ───────────────────────────────────────────────────────────────────

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test('smoke test - app loads and displays overview page', async ({ page }) => {
  await page.goto('/');

  // Header brand name
  await expect(page.getByRole('heading', { name: 'Virtue Health' })).toBeVisible();

  // Overview page heading
  await expect(
    page.getByRole('heading', { name: 'India Healthcare Overview' }),
  ).toBeVisible();

  // KPI card titles
  await expect(page.getByText('Total Facilities')).toBeVisible();
  await expect(page.getByText('States Covered')).toBeVisible();
  await expect(page.getByText('Districts Covered')).toBeVisible();

  // Nav links
  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Facilities' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Districts' })).toBeVisible();
});

test('smoke test - facilities page loads', async ({ page }) => {
  await page.goto('/facilities');

  await expect(
    page.getByRole('heading', { name: 'Healthcare Facilities' }),
  ).toBeVisible();

  // Table headers
  await expect(page.getByText('Name')).toBeVisible();
  await expect(page.getByText('City')).toBeVisible();
});

test('smoke test - districts page loads', async ({ page }) => {
  await page.goto('/districts');

  await expect(
    page.getByRole('heading', { name: 'District Health Indicators' }),
  ).toBeVisible();

  // Table header
  await expect(page.getByText('District')).toBeVisible();
  await expect(page.getByText('Electricity')).toBeVisible();
});

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  // Create temp directory for test artifacts
  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  // Capture console logs and errors (including React errors)
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();

    // Skip empty lines and formatting placeholders
    if (!text.trim() || /^%[osd]$/.test(text.trim())) {
      return;
    }

    // Get stack trace for errors if available
    const location = msg.location();
    const locationStr = location.url
      ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}`
      : '';

    consoleLogs.push(`[${type}] ${text}${locationStr}`);

    // Separately track error messages (React errors appear here)
    if (type === 'error') {
      consoleErrors.push(`${text}${locationStr}`);
    }
  });

  // Capture page errors with full stack trace
  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    console.error('Page error detected:', errorDetails);
  });

  // Capture failed requests
  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  // Always capture artifacts, even if test fails
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors);
  }
  if (pageErrors.length > 0) {
    console.log('Page errors detected:', pageErrors);
  }
  if (failedRequests.length > 0) {
    console.log('Failed requests detected:', failedRequests);
  }

  await page.close();
});

// Expose APP_CONFIG for reference (no unused variable lint warning)
void APP_CONFIG;
