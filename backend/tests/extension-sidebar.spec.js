import { expect, test } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sidebarUrl = pathToFileURL(path.resolve(testDir, '../../extension/sidebar/sidebar.html')).href;

test('renders framing analysis and labels outlet history separately', async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(listener) {
            globalThis.__factlensMessageListener = listener;
          },
        },
        sendMessage() {
          return Promise.resolve({ type: 'STATUS', payload: 'idle' });
        },
        openOptionsPage() {},
      },
    };
  });
  await page.goto(sidebarUrl);

  await page.evaluate(() => {
    globalThis.__factlensMessageListener({
      type: 'COVERAGE',
      payload: {
        available: true,
        story: 'Officials announce public policy update',
        query: 'official public policy update',
        confidence: 'high',
        matched_on: ['audio transcript', "other outlets' headlines"],
        low_confidence: false,
        articles: [],
        coverage: null,
        missing_context: [],
        outlet_bias: { name: 'Example News', rating: 'center' },
        framing_analysis: {
          direction: 'mixed',
          framing_intensity: 44,
          reliability: 82,
          dimensions: {
            loaded_language: 25,
            source_balance: 61,
            evidence_quality: 82,
            missing_context: 40,
            fact_opinion_separation: 91,
          },
          evidence: [{
            dimension: 'source_balance',
            excerpt: '<b>A short exact excerpt</b>',
            explanation: '<script>Explanation stays text.</script>',
          }],
          confidence: { score: 72, label: 'medium', comparison_sources: 2 },
          analyzed_at: '2026-08-14T18:00:00.000Z',
          methodology_version: '1.0',
        },
      },
    });
  });

  await expect(page.getByText('Outlet history: Example News (center)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Experimental segment framing' })).toBeVisible();
  await expect(page.getByText(/not yet human-calibrated/)).toBeVisible();
  await expect(page.getByText('44/100')).toBeVisible();
  await expect(page.getByText('82/100')).toHaveCount(2);
  await page.getByText('Review 1 evidence excerpt').click();
  await expect(page.getByText('<b>A short exact excerpt</b>')).toBeVisible();
  await expect(page.getByText('<script>Explanation stays text.</script>')).toBeVisible();
  await expect(page.locator('script', { hasText: 'Explanation stays text.' })).toHaveCount(0);
  await expect(page.getByText(/Method 1\.0 \| 2 comparison sources/)).toBeVisible();
});
