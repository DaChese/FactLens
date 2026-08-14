import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { getReviewSample, getReviewStats, getReviewSummary, hasReviewerSubmitted, submitReview } from '../lib/reviewStore.js';

const router = Router();
const DIRECTIONS = ['left', 'lean-left', 'center', 'lean-right', 'right', 'mixed', 'unclear'];
const STANCES = ['left', 'center', 'right', 'prefer-not-to-say'];
const DIMENSIONS = ['loaded_language', 'source_balance', 'evidence_quality', 'missing_context', 'fact_opinion_separation'];

function validScore(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
}

function hasPanelAccess(req) {
  const expected = process.env.REVIEWER_ACCESS_TOKEN;
  if (!expected) return false;
  const supplied = req.get('X-Reviewer-Access') || '';
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requirePanelAccess(req, res) {
  if (!process.env.REVIEWER_ACCESS_TOKEN) {
    res.status(503).json({ error: 'Blind review is disabled until a panel access token is configured.' });
    return false;
  }
  if (!hasPanelAccess(req)) {
    res.status(401).json({ error: 'A valid panel access token is required.' });
    return false;
  }
  return true;
}

router.get('/queue', async (req, res, next) => {
  try {
    const session = req.get('X-Reviewer-Session');
    if (!session || session.length < 16) return res.status(400).json({ error: 'A reviewer session is required.' });
    if (!requirePanelAccess(req, res)) return;
    const sample = await getReviewSample(session);
    res.json({ sample });
  } catch (error) {
    next(error);
  }
});

router.post('/:sampleId', async (req, res, next) => {
  try {
    const session = req.get('X-Reviewer-Session');
    if (!session || session.length < 16) return res.status(400).json({ error: 'A reviewer session is required.' });
    if (!requirePanelAccess(req, res)) return;
    const { reviewer_stance, direction, framing_intensity, reliability, confidence, dimensions = {} } = req.body;
    if (!STANCES.includes(reviewer_stance)) return res.status(400).json({ error: 'Invalid reviewer stance.' });
    if (!DIRECTIONS.includes(direction)) return res.status(400).json({ error: 'Invalid direction.' });
    if (![framing_intensity, reliability, confidence].every(validScore)) {
      return res.status(400).json({ error: 'Scores must be between 0 and 100.' });
    }
    if (!DIMENSIONS.every(name => validScore(dimensions[name]))) {
      return res.status(400).json({ error: 'Every rubric dimension must be scored from 0 to 100.' });
    }

    const result = await submitReview(req.params.sampleId, session, {
      reviewer_stance,
      direction,
      framing_intensity: Math.round(Number(framing_intensity)),
      reliability: Math.round(Number(reliability)),
      confidence: Math.round(Number(confidence)),
      dimensions: Object.fromEntries(DIMENSIONS.map(name => [name, Math.round(Number(dimensions[name]))])),
    });
    if (result.status === 'missing') return res.status(404).json({ error: 'Review sample is no longer available.' });
    if (result.status === 'duplicate') return res.status(409).json({ error: 'This reviewer already rated the sample.' });
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/summary/:sampleId', async (req, res, next) => {
  try {
    const session = req.get('X-Reviewer-Session');
    if (!session || session.length < 16) return res.status(400).json({ error: 'A reviewer session is required.' });
    if (!requirePanelAccess(req, res)) return;
    if (!await hasReviewerSubmitted(req.params.sampleId, session)) {
      return res.status(403).json({ error: 'Submit a review before viewing this summary.' });
    }
    res.json(await getReviewSummary(req.params.sampleId));
  } catch (error) {
    next(error);
  }
});

router.get('/stats', async (_req, res, next) => {
  try {
    res.json(await getReviewStats());
  } catch (error) {
    next(error);
  }
});

export default router;
