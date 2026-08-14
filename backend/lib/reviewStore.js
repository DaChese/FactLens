import { createHash, randomUUID } from 'crypto';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.env.FACTLENS_DATA_DIR
  ? path.resolve(process.env.FACTLENS_DATA_DIR)
  : path.resolve(__dirname, '../runtime');
const auditsFile = path.join(runtimeDir, 'analysis-audits.jsonl');
const reviewsFile = path.join(runtimeDir, 'blind-reviews.jsonl');
const reviewQueue = new Map();
const REVIEW_QUEUE_TTL_MS = Number(process.env.REVIEW_QUEUE_TTL_MS) || 24 * 60 * 60 * 1000;
let reviewWriteQueue = Promise.resolve();

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function appendJsonLine(file, value) {
  await mkdir(runtimeDir, { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJsonLines(file) {
  try {
    const body = await readFile(file, 'utf8');
    return body.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function enqueueAnalysis({ transcript, story, analysis }) {
  const sampleId = randomUUID();
  const transcriptHash = hash(transcript.trim());
  const createdAt = new Date().toISOString();
  const displayStory = String(story || '').slice(0, 200);
  const audit = {
    sample_id: sampleId,
    transcript_hash: transcriptHash,
    automated_analysis: {
      direction: analysis.direction,
      framing_intensity: analysis.framing_intensity,
      reliability: analysis.reliability,
      dimensions: analysis.dimensions,
      completeness: analysis.confidence,
      analyzed_at: analysis.analyzed_at,
      methodology_version: analysis.methodology_version,
    },
    created_at: createdAt,
  };

  // The raw transcript is intentionally memory-only and disappears on restart.
  reviewQueue.set(sampleId, {
    sample_id: sampleId,
    transcript,
    story: displayStory,
    created_at: createdAt,
  });
  await appendJsonLine(auditsFile, audit);
  return { sample_id: sampleId, transcript_hash: transcriptHash };
}

export async function getReviewSample(reviewerSession) {
  const now = Date.now();
  for (const [sampleId, sample] of reviewQueue) {
    if (now - Date.parse(sample.created_at) > REVIEW_QUEUE_TTL_MS) reviewQueue.delete(sampleId);
  }
  const completed = new Set(
    (await readJsonLines(reviewsFile))
      .filter(review => review.reviewer_hash === hash(reviewerSession))
      .map(review => review.sample_id),
  );
  return [...reviewQueue.values()].find(sample => !completed.has(sample.sample_id)) ?? null;
}

export async function submitReview(sampleId, reviewerSession, review) {
  const sample = reviewQueue.get(sampleId);
  if (!sample || Date.now() - Date.parse(sample.created_at) > REVIEW_QUEUE_TTL_MS) {
    reviewQueue.delete(sampleId);
    return { status: 'missing' };
  }

  const operation = reviewWriteQueue.then(async () => {
    const reviewerHash = hash(reviewerSession);
    const reviews = await readJsonLines(reviewsFile);
    if (reviews.some(item => item.sample_id === sampleId && item.reviewer_hash === reviewerHash)) {
      return { status: 'duplicate' };
    }
    await appendJsonLine(reviewsFile, {
      sample_id: sampleId,
      transcript_hash: hash(sample.transcript.trim()),
      reviewer_hash: reviewerHash,
      ...review,
      submitted_at: new Date().toISOString(),
    });
    return { status: 'created' };
  });
  reviewWriteQueue = operation.catch(() => {});
  return operation;
}

export async function hasReviewerSubmitted(sampleId, reviewerSession) {
  const reviewerHash = hash(reviewerSession);
  const reviews = await readJsonLines(reviewsFile);
  return reviews.some(review => review.sample_id === sampleId && review.reviewer_hash === reviewerHash);
}

function mean(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export async function getReviewSummary(sampleId) {
  const [reviews, audits] = await Promise.all([readJsonLines(reviewsFile), readJsonLines(auditsFile)]);
  const sampleReviews = reviews.filter(review => review.sample_id === sampleId);
  const audit = audits.find(item => item.sample_id === sampleId) ?? null;
  const directionCounts = {};
  const stanceCounts = {};
  for (const review of sampleReviews) {
    directionCounts[review.direction] = (directionCounts[review.direction] || 0) + 1;
    stanceCounts[review.reviewer_stance] = (stanceCounts[review.reviewer_stance] || 0) + 1;
  }
  const topDirectionCount = Math.max(0, ...Object.values(directionCounts));

  return {
    sample_id: sampleId,
    review_count: sampleReviews.length,
    reviewer_stances: stanceCounts,
    direction_counts: directionCounts,
    direction_agreement: sampleReviews.length ? Number((topDirectionCount / sampleReviews.length).toFixed(2)) : null,
    mean_framing_intensity: mean(sampleReviews.map(review => review.framing_intensity)),
    mean_reliability: mean(sampleReviews.map(review => review.reliability)),
    automated_analysis: audit?.automated_analysis ?? null,
  };
}

export async function getReviewStats() {
  const [reviews, audits] = await Promise.all([readJsonLines(reviewsFile), readJsonLines(auditsFile)]);
  const reviewedSamples = new Set(reviews.map(review => review.sample_id));
  return {
    queued_in_memory: reviewQueue.size,
    persisted_audits: audits.length,
    persisted_reviews: reviews.length,
    reviewed_samples: reviewedSamples.size,
  };
}
