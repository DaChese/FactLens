import { expect, test } from '@playwright/test';

test.describe('Blind review API', () => {
  test('reports calibration counts without exposing transcript text', async ({ request }) => {
    const response = await request.get('/reviews/stats');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({
      queued_in_memory: expect.any(Number),
      persisted_audits: expect.any(Number),
      persisted_reviews: expect.any(Number),
      reviewed_samples: expect.any(Number),
    }));
    expect(JSON.stringify(body)).not.toContain('transcript');
  });

  test('requires an anonymous reviewer session', async ({ request }) => {
    const response = await request.get('/reviews/queue');
    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: /reviewer session/i });
  });

  test('fails closed when panel access is missing', async ({ request }) => {
    const response = await request.post('/reviews/missing-sample', {
      headers: { 'X-Reviewer-Session': 'test-reviewer-session-123456' },
      data: {
        reviewer_stance: 'center',
        direction: 'unclear',
        framing_intensity: 50,
        reliability: 50,
        confidence: 50,
        dimensions: {
          loaded_language: 50,
          source_balance: 50,
          evidence_quality: 50,
          missing_context: 50,
          fact_opinion_separation: 50,
        },
      },
    });
    expect([401, 503]).toContain(response.status());
  });

  test('does not reveal summaries before a locked submission', async ({ request }) => {
    const response = await request.get('/reviews/summary/unreviewed-sample', {
      headers: { 'X-Reviewer-Session': 'test-reviewer-session-123456' },
    });
    expect([401, 503]).toContain(response.status());
  });
});
