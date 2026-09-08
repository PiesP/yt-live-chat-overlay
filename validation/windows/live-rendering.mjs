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
  const resourceFailure = text.startsWith('Failed to load resource:');
  const corsFailure = text.startsWith('Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at ') ||
    text.startsWith("Access to fetch at '") || text.startsWith("Access to XMLHttpRequest at '");
  if (!resourceFailure && !corsFailure) return false;
  const target = resourceFailure ? entry.url : text.match(/https:\/\/[^\s‘’'"<>]+/)?.[0];
  if (!target) return false;
  try {
    const url = new URL(target);
    return (url.hostname.endsWith('.googlevideo.com') && url.pathname === '/videoplayback') ||
      (['googleads.g.doubleclick.net', 'www.youtube.com'].includes(url.hostname) && url.pathname.startsWith('/pagead/viewthroughconversion/')) ||
      (url.hostname === 'ad.doubleclick.net' && url.pathname.startsWith('/ddm/trackimp/')) ||
      (url.hostname === 'accounts.google.com' && url.pathname === '/ServiceLogin') ||
      (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/s/_/ytmainappweb/_/js/'));
  } catch { return false; }
}

export function redactDiagnosticText(text) {
  return text.replace(/https?:\/\/[^\s‘’'"<>]+/g, (value) => {
    try { const url = new URL(value); url.search = ''; url.hash = ''; url.pathname = url.pathname.split(';')[0]; return url.href; }
    catch { return value; }
  }).slice(0, 1000);
}

export function validateLiveRenderer(renderer, installation, diagnostics, bridgeReady = false) {
  if (installation === 'extension') assert(bridgeReady, 'The installed extension bridge is missing');
  const appWorkerFailure = diagnostics.some(({ text }) => text.startsWith('[RenderWorkerManager] renderer.worker.creation-failed'));
  const workerBlock = diagnostics.some((entry) => {
    if (!isTrustedTypesWorkerBlock(entry)) return false;
    if (appWorkerFailure) return true;
    try {
      const url = new URL(entry.url);
      return ['chrome-extension:', 'moz-extension:'].includes(url.protocol) && url.pathname === '/page-script.js';
    } catch { return false; }
  });
  const workerPolicyFallback = installation === 'extension' && renderer === 'main' &&
    workerBlock;
  assert(
    (installation === 'userscript' && renderer === 'main') ||
    (installation === 'extension' && renderer === 'worker') || workerPolicyFallback,
    'The installed application did not prove its expected renderer or page-policy fallback'
  );
  return { renderer, workerPolicyFallback };
}
