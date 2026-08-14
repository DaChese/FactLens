import { readFile, rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, '../test-results/review-store');
process.env.FACTLENS_DATA_DIR = testDir;
await rm(testDir, { recursive: true, force: true });

const store = await import('../lib/reviewStore.js');
const analysis = {
  direction: 'center',
  framing_intensity: 20,
  reliability: 85,
  dimensions: {},
  evidence: [{ dimension: 'loaded_language', excerpt: 'Private raw transcript.', explanation: 'Sensitive excerpt.' }],
  confidence: { score: 70, label: 'medium', comparison_sources: 2 },
  analyzed_at: new Date().toISOString(),
  methodology_version: '1.0',
};
const queued = await store.enqueueAnalysis({ transcript: 'Private raw transcript.', story: 'Test story', analysis });
const sample = await store.getReviewSample('reviewer-session-123456');
if (sample?.sample_id !== queued.sample_id) throw new Error('Queued sample was not returned.');

const review = {
  reviewer_stance: 'center',
  direction: 'center',
  framing_intensity: 25,
  reliability: 80,
  confidence: 75,
  dimensions: {
    loaded_language: 10,
    source_balance: 20,
    evidence_quality: 80,
    missing_context: 20,
    fact_opinion_separation: 90,
  },
};
if ((await store.submitReview(sample.sample_id, 'reviewer-session-123456', review)).status !== 'created') {
  throw new Error('Review was not created.');
}
if ((await store.submitReview(sample.sample_id, 'reviewer-session-123456', review)).status !== 'duplicate') {
  throw new Error('Duplicate review was not rejected.');
}
const summary = await store.getReviewSummary(sample.sample_id);
if (summary.review_count !== 1 || summary.direction_agreement !== 1) throw new Error('Review summary is incorrect.');

const auditText = await readFile(path.join(testDir, 'analysis-audits.jsonl'), 'utf8');
const reviewText = await readFile(path.join(testDir, 'blind-reviews.jsonl'), 'utf8');
if (auditText.includes('Private raw transcript.') || reviewText.includes('Private raw transcript.')) {
  throw new Error('Raw transcript was persisted.');
}
const second = await store.enqueueAnalysis({ transcript: 'Second private transcript.', story: 'Private story title', analysis });
const concurrent = await Promise.all([
  store.submitReview(second.sample_id, 'concurrent-reviewer-123456', review),
  store.submitReview(second.sample_id, 'concurrent-reviewer-123456', review),
]);
if (concurrent.filter(result => result.status === 'created').length !== 1
  || concurrent.filter(result => result.status === 'duplicate').length !== 1) {
  throw new Error('Concurrent duplicate reviews were not serialized.');
}
if (!auditText.includes(queued.transcript_hash)) throw new Error('Transcript hash was not persisted.');
console.log('PASS review store privacy, duplicate prevention, and summary');
