/**
 * routes/transcribe.js — Audio Transcription Route
 *
 * POST /transcribe
 *  - Accepts an audio blob as multipart/form-data (field name: "audio")
 *  - Forwards the audio to the OpenAI Whisper API
 *  - Returns the transcription text as JSON: { text: string }
 */

import { Router } from 'express';
import multer from 'multer';

// TODO (Sprint 2): Import the OpenAI SDK
// import OpenAI from 'openai';

const router = Router();

// Store uploaded audio in memory (no disk I/O needed for small chunks)
const upload = multer({ storage: multer.memoryStorage() });

// TODO (Sprint 2): Initialise the OpenAI client
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── POST /transcribe ────────────────────────────────────────────────────────

router.post('/', upload.single('audio'), async (req, res, next) => {
  try {
    // ── Input validation ──
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided. Send a multipart/form-data request with field "audio".' });
    }

    const { mimetype, buffer, originalname } = req.file;

    // Basic MIME type guard — Whisper accepts webm, mp4, wav, mp3, etc.
    const allowedTypes = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg'];
    if (!allowedTypes.includes(mimetype)) {
      return res.status(400).json({ error: `Unsupported audio type: ${mimetype}` });
    }

    // TODO (Sprint 2): Forward audio to OpenAI Whisper
    // const formData = new FormData();
    // formData.append('file', new Blob([buffer], { type: mimetype }), originalname || 'audio.webm');
    // formData.append('model', 'whisper-1');
    //
    // const transcription = await openai.audio.transcriptions.create({
    //   file: formData.get('file'),
    //   model: 'whisper-1',
    // });
    //
    // return res.json({ text: transcription.text });

    // ── STUB response ──
    console.log(`[/transcribe] Received ${buffer.length} bytes of ${mimetype} (stub mode)`);
    return res.json({ text: '[Stub] Transcription not yet implemented. Sprint 2 will wire up Whisper.' });

  } catch (err) {
    next(err);
  }
});

export default router;
