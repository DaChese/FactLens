import { expect, test } from '@playwright/test';

test.describe('FactLens product page', () => {
  test('presents the product, method, APIs, and next-gen TV roadmap', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/FactLens \| Context for live news/);
    await expect(page.getByRole('heading', { name: 'FactLens', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A second layer for live reporting' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Signals, safeguards, and visible uncertainty' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A roadmap beyond the browser tab' })).toBeVisible();
    await expect(page.getByText('Groq', { exact: true })).toBeVisible();
    await expect(page.getByText('NewsAPI', { exact: true })).toBeVisible();
    await expect(page.getByText('Tavily', { exact: true })).toBeVisible();
    await expect(page.getByText('Connected TV overlay', { exact: true })).toBeVisible();
  });

  test('installer exposes a downloadable extension package and transparent steps', async ({ page, request }) => {
    await page.goto('/install.html', { waitUntil: 'domcontentloaded' });
    const download = page.getByRole('link', { name: 'Download extension package' });
    await expect(download).toHaveAttribute('href', 'downloads/factlens-extension.zip');
    await expect(page.getByText(/Chrome blocks websites from silently installing/)).toBeVisible();
    const archive = await request.get('/downloads/factlens-extension.zip');
    expect(archive.ok()).toBeTruthy();
    expect((await archive.body()).length).toBeGreaterThan(10_000);
  });

  test('keeps hero and navigation usable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'FactLens', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Get extension' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download extension' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBeFalsy();
  });
});
