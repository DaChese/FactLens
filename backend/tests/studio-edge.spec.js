import { expect, test } from '@playwright/test';

async function loadStudio(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#transcript').fill('A short segment about a public policy update with enough words to analyze.');
  await page.locator('#page-title').fill('Officials announce public policy update');
}

test.describe('FactLens studio edge cases', () => {
  test('shows low-confidence matches without pretending coverage is verified', async ({ page }) => {
    await page.route('**/coverage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          story: 'Ambiguous official update',
          query: 'official public policy update',
          confidence: 'low',
          matched_on: [],
          low_confidence: true,
          articles: [],
          coverage: null,
          missing_context: [],
          outlet_bias: null,
        }),
      });
    });

    await loadStudio(page);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('Story match status: low confidence.')).toBeVisible();
    await expect(page.getByText('Coverage is withheld for low-confidence matches.')).toBeVisible();
    await expect(page.getByText('The story match was not confident enough to show missing context.')).toBeVisible();
  });

  test('handles missing NewsAPI coverage without breaking follow-up state', async ({ page }) => {
    await page.route('**/coverage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: false,
          story: null,
          query: null,
          articles: [],
          coverage: null,
          missing_context: [],
          outlet_bias: null,
        }),
      });
    });

    await loadStudio(page);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('Coverage comparison unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check statements' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check public reaction' })).toBeDisabled();
  });

  test('turns provider and rate-limit failures into readable messages', async ({ page }) => {
    await page.route('**/coverage', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'NewsAPI budget limit reached' }),
      });
    });

    await loadStudio(page);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('Rate limit reached. Wait a minute, then try again.')).toBeVisible();
    await expect(page.getByText('Could not build the note.')).toBeVisible();
  });

  test('shows network failures from a bad backend request', async ({ page }) => {
    await page.route('**/coverage', async (route) => {
      await route.abort('failed');
    });

    await loadStudio(page);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('Network failure. Check that the backend URL is correct and the Railway service is awake.')).toBeVisible();
  });

  test('renders unusual response text and source URLs safely', async ({ page }) => {
    await page.route('**/coverage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          story: '<script>window.__factlensUnsafe = true</script> Policy update',
          query: 'policy update',
          confidence: 'medium',
          matched_on: ['audio transcript'],
          low_confidence: false,
          articles: [
            {
              title: 'Safe article title',
              outlet: 'Trusted Outlet',
              url: 'https://example.com/story',
              bias: 'center',
            },
            {
              title: 'Unsafe URL should not become a link',
              outlet: 'Bad URL',
              url: 'javascript:alert(1)',
              bias: 'unrated',
            },
          ],
          coverage: { total: 2, left: 0, 'lean-left': 0, center: 1, 'lean-right': 0, right: 0, unrated: 1 },
          missing_context: [
            { text: '<b>Markup should render as text</b>', outlet: 'Trusted Outlet', url: 'https://example.com/context' },
          ],
          outlet_bias: { name: 'Watched Outlet', rating: 'center' },
        }),
      });
    });

    await loadStudio(page);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('<script>window.__factlensUnsafe = true</script> Policy update')).toBeVisible();
    await expect(page.getByText('<b>Markup should render as text</b>')).toBeVisible();
    await expect(page.locator('script', { hasText: 'window.__factlensUnsafe' })).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Safe article title' })).toHaveAttribute('href', 'https://example.com/story');
  });

  test('sends provider overrides as headers without rendering the secret values', async ({ page }) => {
    const secret = {
      groq: 'gsk_test_secret',
      tavily: 'tvly-test-secret',
      news: 'news-test-secret',
    };

    await page.route('**/coverage', async (route) => {
      const headers = route.request().headers();
      expect(headers['x-groq-key']).toBe(secret.groq);
      expect(headers['x-tavily-key']).toBe(secret.tavily);
      expect(headers['x-newsapi-key']).toBe(secret.news);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          story: 'Provider override test',
          query: 'provider override test',
          confidence: 'medium',
          matched_on: ['audio transcript'],
          low_confidence: false,
          articles: [],
          coverage: { total: 0, left: 0, 'lean-left': 0, center: 0, 'lean-right': 0, right: 0, unrated: 0 },
          missing_context: [],
          outlet_bias: null,
        }),
      });
    });

    await loadStudio(page);
    await page.getByText('Developer settings').click();
    await page.locator('#groq-key').fill(secret.groq);
    await page.locator('#tavily-key').fill(secret.tavily);
    await page.locator('#news-key').fill(secret.news);
    await page.getByRole('button', { name: 'Build Community Note' }).click();

    await expect(page.getByText('Provider override test', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(secret.groq);
    await expect(page.locator('body')).not.toContainText(secret.tavily);
    await expect(page.locator('body')).not.toContainText(secret.news);
  });
});
