import { expect, test } from '@playwright/test';

test.describe('FactLens studio live analysis', () => {
  test.skip(process.env.FACTLENS_RUN_LIVE !== '1', 'Run npm run test:studio:live to spend provider calls.');

  test('builds a note and runs follow-up analysis from the deployed studio', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/studio.html');
    await page.getByRole('button', { name: /Transcript with headline/ }).click();

    await page.getByRole('button', { name: 'Build Community Note' }).click();
    await expect(page.getByText('Community Note ready.')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Identified story' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Experimental framing analysis' })).toBeVisible();
    await expect(page.getByText('Framing intensity')).toBeVisible();
    await expect(page.getByText('Reliability', { exact: true })).toBeVisible();
    await expect(page.getByText(/Method 1\.0 \| \d+ comparison source/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Missing context' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Other coverage' })).toBeVisible();

    const claims = page.getByRole('button', { name: 'Check statements' });
    await expect(claims).toBeEnabled();
    await claims.click();
    await expect(page.getByText('Statement check complete.')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Statement checks' })).toBeVisible();

    const discussion = page.getByRole('button', { name: 'Check public reaction' });
    await expect(discussion).toBeEnabled();
    await discussion.click();
    await expect(page.getByText('Public reaction check complete.')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Public reaction' })).toBeVisible();
  });
});
