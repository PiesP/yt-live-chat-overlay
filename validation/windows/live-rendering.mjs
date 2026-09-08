// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

/** Accept the product's policy fallback only when the public page records it. */
export function isTrustedTypesWorkerBlock(entry) {
  return (entry.level ?? entry.type) === 'error' &&
    (/^This document requires ['"]TrustedScriptURL['"] assignment\. The action has been blocked\./.test(entry.text) ||
      /^Content-Security-Policy: The page.s settings blocked assigning to an injection sink because it violates the following directive: .require-trusted-types-for/.test(entry.text));
}

export function countUnexpectedLiveErrors(entries, workerPolicyFallback) {
  return entries.filter((entry) => (entry.level ?? entry.type) === 'error' &&
    !(workerPolicyFallback && isTrustedTypesWorkerBlock(entry)) && !isYouTubeHostError(entry)).length;
}

/** These native YouTube media, ad, and site-module requests are outside the overlay. */
export function isYouTubeHostError(entry) {
  if ((entry.level ?? entry.type) !== 'error') return false;
  const text = entry.text;
  if (/^Failed to load .https:\/\/www\.youtube\.com\/s\/_\/ytmainappweb\/_\/js\//.test(text) &&
    text.endsWith('A ServiceWorker intercepted the request and encountered an unexpected error.')) return true;
  if (!text.startsWith('Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at ')) return false;
  const match = text.match(/https:\/\/[^\s‘’"<>]+/);
  if (!match) return false;
  try {
    const url = new URL(match[0]);
    return (url.hostname.endsWith('.googlevideo.com') && url.pathname === '/videoplayback') ||
      (url.hostname === 'googleads.g.doubleclick.net' && url.pathname.startsWith('/pagead/viewthroughconversion/'));
  } catch { return false; }
}

export function redactDiagnosticText(text) {
  return text.replace(/https?:\/\/[^\s‘’"<>]+/g, (value) => {
    try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href; }
    catch { return value; }
  }).slice(0, 1000);
}

export function validateLiveRenderer(renderer, installation, diagnostics, bridgeReady = false) {
  if (installation === 'extension') assert(bridgeReady, 'The installed extension bridge is missing');
  const workerPolicyFallback = installation === 'extension' && renderer === 'main' &&
    diagnostics.some(isTrustedTypesWorkerBlock);
  assert(
    (installation === 'userscript' && renderer === 'main') ||
    (installation === 'extension' && renderer === 'worker') || workerPolicyFallback,
    'The installed application did not prove its expected renderer or page-policy fallback'
  );
  return { renderer, workerPolicyFallback };
}
