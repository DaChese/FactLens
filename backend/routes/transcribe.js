/**
 * routes/transcribe.js — Audio Transcription Route
 *
 * POST /transcribe
 *  - Accepts an audio blob as multipart/form-data (field name: "audio")
 *  - Forwards the audio to the Groq Whisper API (whisper-large-v3-turbo)
 *  - Auto-detects language (supports English, Spanish, and all Whisper languages)
 *  - Returns: { text: string, language: string }
 *
 * Note: We use native fetch + FormData directly to avoid Node 24 SDK hang issues.
 */

import { Router } from 'express';
import multer from 'multer';
import { resolveKey } from '../lib/keys.js';
import { recordSuccess, recordFailure } from '../lib/apiStatus.js';

const router = Router();

// Store uploaded audio in memory — chunks are small (5s ≈ 50–100 KB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Whisper's max
});

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL  = 'whisper-large-v3-turbo';

const ALLOWED_MIME_TYPES = [
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
];

// ─── POST /transcribe ────────────────────────────────────────────────────────

router.post('/', upload.single('audio'), async (req, res, next) => {
  try {
    const groqKey = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    if (!groqKey) {
      return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No audio file provided. Send multipart/form-data with field "audio".',
      });
    }

    const { mimetype, buffer, size } = req.file;

    const baseMime = mimetype.split(';')[0].trim();
    if (!ALLOWED_MIME_TYPES.some(t => t.startsWith(baseMime))) {
      return res.status(400).json({ error: `Unsupported audio type: ${mimetype}` });
    }

    if (size < 1000) {
      console.log(`[/transcribe] Chunk too small (${size} bytes) — skipping`);
      return res.json({ text: '', language: null });
    }

    console.log(`[/transcribe] Received ${size} bytes of ${mimetype} — sending to Whisper`);

    const extension = baseMime === 'audio/mpeg' ? 'mp3'
                    : baseMime === 'audio/wav'  ? 'wav'
                    : baseMime === 'audio/mp4'  ? 'mp4'
                    : baseMime === 'audio/ogg'  ? 'ogg'
                    : 'webm';

    const formData = new FormData();
    formData.append('model', GROQ_MODEL);
    formData.append('response_format', 'verbose_json'); // returns language detection
    // No 'language' field — let Whisper auto-detect (supports EN, ES, and 90+ others)
    formData.append(
      'file',
      new Blob([buffer], { type: baseMime }),
      `chunk.${extension}`
    );

    const response = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const err = new Error(errBody?.error?.message ?? `Whisper API error ${response.status}`);
      err.status = response.status;
      recordFailure('groq', err);
      throw err;
    }
    recordSuccess('groq');

    const data     = await response.json();
    const text     = data.text?.trim() ?? '';
    const language = data.language ?? null;

    console.log(`[/transcribe] Language: ${language} | "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    return res.json({ text, language });

  } catch (err) {
    console.error('[/transcribe] Error:', err.message);
    next(err);
  }
});

export default router;
