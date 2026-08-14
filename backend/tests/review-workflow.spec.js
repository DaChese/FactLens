import { expect, test } from '@playwright/test';

test('completes a blind review without revealing automated scores first', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('factlensReviewerAccess', 'test-panel-token'));
  let submitted = null;
  await page.route('**/reviews/queue', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sample: {
        sample_id: 'sample-1',
        transcript: 'The agency said the rule begins Monday.',
        created_at: '2026-08-14T18:00:00.000Z',
      },
    }),
  }));
  await page.route('**/reviews/sample-1', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/reviews/summary/sample-1', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sample_id: 'sample-1',
      review_count: 3,
      direction_agreement: 0.67,
      mean_reliability: 81,
      automated_analysis: { direction: 'center', reliability: 88 },
    }),
  }));

  await page.goto('/review.html');
  await expect(page.getByText('The agency said the rule begins Monday.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Automated');
  await page.locator('#reviewer-stance').selectOption('center');
  await page.locator('#direction').selectOption('center');
  await page.locator('#reliability').fill('81');
  await page.getByRole('button', { name: 'Submit locked review' }).click();

  await expect(page.getByRole('heading', { name: 'Calibration snapshot' })).toBeVisible();
  await expect(page.getByText('67%')).toBeVisible();
  expect(submitted.reviewer_stance).toBe('center');
  expect(submitted.direction).toBe('center');
  expect(submitted.reliability).toBe(81);
  expect(Object.keys(submitted.dimensions)).toHaveLength(5);
});

test('shows an empty review queue clearly', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('factlensReviewerAccess', 'test-panel-token'));
  await page.route('**/reviews/queue', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sample: null }),
  }));
  await page.goto('/review.html');
  await expect(page.getByRole('heading', { name: 'No samples available' })).toBeVisible();
  await expect(page.getByText('Queue empty.')).toBeVisible();
});
