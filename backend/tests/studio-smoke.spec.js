import { expect, test } from '@playwright/test';

test.describe('FactLens studio smoke tests', () => {
  test('backend is healthy and provider variables are configured', async ({ request }) => {
    const health = await request.get('/health');
    expect(health.ok()).toBeTruthy();
    await expect(health.json()).resolves.toMatchObject({ status: 'ok' });

    const status = await request.get('/status');
    expect(status.ok()).toBeTruthy();
    const body = await status.json();
    expect(body.providers.groq.configured).toBe(true);
    expect(body.providers.tavily.configured).toBe(true);
    expect(body.providers.newsapi.configured).toBe(true);
  });

  test('studio loads with samples, collapsed developer settings, and disabled follow-ups', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/FactLens Analysis Studio/);
    await expect(page.getByRole('heading', { name: 'Understand the story behind the segment' })).toBeVisible();
    await expect(page.getByText('The web studio cannot automatically capture another browser tab.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check statements' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check public reaction' })).toBeDisabled();

    const developerSettings = page.locator('details.developer-settings');
    await expect(developerSettings).not.toHaveAttribute('open', '');
    await expect(page.locator('.sample-card')).toHaveCount(3);
  });

  test('sample loading, clear form, and empty validation work', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /Transcript with headline/ }).click();
    await expect(page.locator('#transcript')).toHaveValue(/The Supreme Court heard arguments/);
    await expect(page.locator('#page-title')).toHaveValue('Supreme Court hears challenge to social media moderation laws');
    await expect(page.locator('#outlet')).toHaveValue('apnews.com');

    await page.getByRole('button', { name: 'Clear form' }).click();
    await expect(page.locator('#transcript')).toHaveValue('');
    await expect(page.locator('#page-title')).toHaveValue('');

    await page.getByRole('button', { name: 'Build Community Note' }).click();
    await expect(page.getByText('Add a transcript, headline, or visible text before building a note.')).toBeVisible();
  });

  test('developer settings can load provider status without showing key values', async ({ page }) => {
    await page.goto('/');

    await page.getByText('Developer settings').click();
    await page.getByRole('button', { name: 'Refresh provider status' }).click();

    await expect(page.getByRole('cell', { name: 'groq' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'tavily' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'newsapi' })).toBeVisible();
    await expect(page.locator('#api-status')).not.toContainText(/gsk_|tvly-|NEWSAPI_KEY|GROQ_API_KEY|TAVILY_API_KEY/);
  });
});
