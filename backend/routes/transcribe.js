/**
 * routes/transcribe.js — Audio Transcription Route
 *
 * POST /transcribe
 *  - Accepts an audio blob as multipart/form-data (field name: "audio")
 *  - Forwards the audio to the Groq Whisper API (whisper-large-v3-turbo)
 *  - Returns the transcription text as JSON: { text: string }
 *
 * Note: We use native fetch + FormData directly to avoid Node 24 SDK hang issues.
 */

import { Router } from 'express';
import multer from 'multer';

const router = Router();

// Store uploaded audio in memory — chunks are small (8s ≈ 80–150 KB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Whisper's max
});

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL  = 'whisper-large-v3-turbo'; // fast + accurate, free tier

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

    // Skip tiny blobs (silence)
    if (size < 1000) {
      console.log(`[/transcribe] Chunk too small (${size} bytes) — skipping`);
      return res.json({ text: '' });
    }

    console.log(`[/transcribe] Received ${size} bytes of ${mimetype} — sending to Whisper`);

    const extension = baseMime === 'audio/mpeg' ? 'mp3'
                    : baseMime === 'audio/wav'  ? 'wav'
                    : baseMime === 'audio/mp4'  ? 'mp4'
                    : baseMime === 'audio/ogg'  ? 'ogg'
                    : 'webm';

    // ── Call Whisper via raw fetch + FormData ──
    // We build the multipart request manually to avoid the Node 24 SDK hang.
    const formData = new FormData();
    formData.append('model', GROQ_MODEL);
    formData.append(
      'file',
      new Blob([buffer], { type: baseMime }),
      `chunk.${extension}`
    );

    const response = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(errBody?.error?.message ?? `Whisper API error ${response.status}`);
    }

    const data = await response.json();
    const text = data.text?.trim() ?? '';

    console.log(`[/transcribe] Whisper returned: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
    return res.json({ text });

  } catch (err) {
    console.error('[/transcribe] Error:', err.message);
    next(err);
  }
});

export default router;
