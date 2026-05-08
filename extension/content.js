/**
 * content.js — FactLens Content Script
 *
 * With the Side Panel API, Chrome handles rendering sidebar.html in its native
 * side panel — no iframe injection needed. This script's only job is to:
 *  - Act as the message bridge between background.js and the side panel
 *  - Forward TRANSCRIPT, FACTCHECK, BIAS, and STATUS messages to the panel
 *    via chrome.runtime.sendMessage (the side panel shares the extension's
 *    message bus, so sidebar.js can listen with chrome.runtime.onMessage)
 *
 * NOTE: We no longer inject any DOM elements into the host page.
 */

(function () {
  'use strict';

  // Listen for messages from the background service worker and relay them
  // to the side panel. The side panel (sidebar.js) listens on the same
  // chrome.runtime.onMessage bus, so we just pass messages straight through.
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    // All recognised message types are forwarded as-is.
    // The side panel's sidebar.js handles rendering.
    const knownTypes = ['STATUS', 'TRANSCRIPT', 'FACTCHECK', 'BIAS', 'ERROR'];

    if (knownTypes.includes(message.type)) {
      // Nothing extra to do — background.js sends directly to the tab, and
      // the side panel receives on the same runtime message channel.
      // This listener exists as a hook for any future content-script-level
      // work (e.g. highlighting claims in the page text).
    } else {
      console.warn('[FactLens] content.js received unknown message type:', message.type);
    }
  });

  console.log('[FactLens] Content script loaded.');
})();
