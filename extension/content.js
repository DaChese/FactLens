/**
 * content.js — FactLens Content Script
 *
 * Runs in every frame (all_frames: true) because many news sites embed their
 * video player in an iframe — captions rendered there are invisible to a
 * top-frame-only script.
 *
 * Two jobs:
 *
 * 1. Closed-caption capture. Snapshots visible caption text from known player
 *    DOMs (YouTube, Video.js, JW Player, Shaka, HTML5 text tracks) plus a
 *    generic fallback, and forwards it to the service worker. Captions are
 *    more accurate than audio transcription, so the service worker prefers
 *    them while they're arriving and falls back to Whisper otherwise.
 *
 * 2. Page-signal scraping (top frame only). Collects the page title, main
 *    headline, and social/image metadata so the backend can cross-check that
 *    the story identified from audio matches what's actually on screen —
 *    part of the story-verification "checks and balances".
 */

(function () {
  'use strict';

  const CAPTION_POLL_MS = 1200;
  const SIGNALS_POLL_MS = 8000;
  const IS_TOP_FRAME    = window === window.top;

  // ─── Caption Capture ───────────────────────────────────────────────────────

  // Known caption containers, most specific first.
  const CAPTION_SELECTORS = [
    '.ytp-caption-segment',                    // YouTube
    '.captions-text .caption-visual-line',     // YouTube (alt layout)
    '.vjs-text-track-cue',                     // Video.js (Brightcove & many news sites)
    '.jw-captions .jw-text-track-cue',         // JW Player
    '.shaka-text-container span',              // Shaka Player
    '.theoplayer-texttracks',                  // THEOplayer
    '.bmpui-ui-subtitle-label',                // Bitmovin
  ];

  // Generic last resort — any element whose class mentions captions/subtitles.
  // Guarded by looksLikeCaption() so page chrome ("Turn on subtitles" buttons,
  // settings menus) doesn't get mistaken for spoken text.
  const GENERIC_SELECTORS = [
    '[class*="caption" i] span',
    '[class*="subtitle" i] span',
  ];

  let lastSnapshot        = '';
  let loggedSelector      = null; // log which selector matched, once, for debugging

  /** Heuristic filter for the generic selectors: real captions are short-ish
   *  visible sentences, not UI labels or whole article bodies. */
  function looksLikeCaption(text) {
    const words = text.split(/\s+/).length;
    return words >= 3 && words <= 60 && !/^(on|off|settings|subtitles?|captions?|cc)$/i.test(text.trim());
  }

  function collectFromSelectors(selectors, applyGuard) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length === 0) continue;
      const text = Array.from(nodes)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      if (applyGuard && !looksLikeCaption(text)) continue;

      if (loggedSelector !== selector) {
        loggedSelector = selector;
        console.log(`[FactLens] Captions found via "${selector}" (frame: ${IS_TOP_FRAME ? 'top' : location.hostname})`);
      }
      return text;
    }
    return '';
  }

  /**
   * Collect the currently visible caption text from known containers,
   * HTML5 text-track cues, or generic caption-ish elements.
   */
  function readCaptions() {
    const known = collectFromSelectors(CAPTION_SELECTORS, false);
    if (known) return known;

    // HTML5 text tracks (mode must be 'showing')
    for (const video of document.querySelectorAll('video')) {
      for (const track of video.textTracks ?? []) {
        if (track.mode !== 'showing' || !track.activeCues) continue;
        const text = Array.from(track.activeCues)
          .map((cue) => (cue.text || '').replace(/<[^>]+>/g, ' ').trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          if (loggedSelector !== 'textTracks') {
            loggedSelector = 'textTracks';
            console.log(`[FactLens] Captions found via HTML5 textTracks (frame: ${IS_TOP_FRAME ? 'top' : location.hostname})`);
          }
          return text;
        }
      }
    }

    return collectFromSelectors(GENERIC_SELECTORS, true);
  }

  function pollCaptions() {
    let text;
    try {
      text = readCaptions();
    } catch {
      return; // player DOM in a weird state — try again next tick
    }

    if (!text || text === lastSnapshot) return;
    lastSnapshot = text;
    send({ type: 'CAPTION_TEXT', payload: text });
  }

  // ─── Page Signals (top frame only) ─────────────────────────────────────────

  let lastSignals = '';

  function metaContent(selector) {
    return document.querySelector(selector)?.getAttribute('content')?.trim() || '';
  }

  /**
   * Scrape the on-screen text that identifies what this page is about:
   * title, main headline, social metadata, and image alt text / captions.
   */
  function readPageSignals() {
    const headline = document.querySelector('h1')?.textContent?.trim().slice(0, 300) || '';
    const ogTitle  = metaContent('meta[property="og:title"]');
    const ogDesc   = metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]');

    // Image metadata: og:image alt text plus the first few figure captions /
    // meaningful image alts near the top of the page ("crucial photos").
    const imageTexts = [];
    const ogImageAlt = metaContent('meta[property="og:image:alt"]');
    if (ogImageAlt) imageTexts.push(ogImageAlt);
    for (const el of document.querySelectorAll('figcaption, img[alt]')) {
      if (imageTexts.length >= 3) break;
      const text = (el.tagName === 'IMG' ? el.getAttribute('alt') : el.textContent)?.trim();
      if (text && text.length > 15 && text.length < 300) imageTexts.push(text);
    }

    return {
      pageTitle:    document.title?.trim().slice(0, 300) || '',
      onScreenText: [headline, ogTitle, ogDesc, ...imageTexts]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1500),
    };
  }

  function pollSignals() {
    let signals;
    try {
      signals = readPageSignals();
    } catch {
      return;
    }

    const fingerprint = `${signals.pageTitle}|${signals.onScreenText}`;
    if (!signals.pageTitle || fingerprint === lastSignals) return;
    lastSignals = fingerprint;
    send({ type: 'PAGE_SIGNALS', payload: signals });
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension context invalidated (e.g. extension reloaded) — stop polling
      clearInterval(captionTimer);
      if (signalsTimer) clearInterval(signalsTimer);
    }
  }

  const captionTimer = setInterval(pollCaptions, CAPTION_POLL_MS);
  let signalsTimer   = null;

  if (IS_TOP_FRAME) {
    signalsTimer = setInterval(pollSignals, SIGNALS_POLL_MS);
    pollSignals(); // send initial signals immediately, don't wait 8s
    console.log('[FactLens] Content script loaded (captions + page signals).');
  }
})();
