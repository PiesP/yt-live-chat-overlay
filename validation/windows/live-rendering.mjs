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
    !(workerPolicyFallback && isTrustedTypesWorkerBlock(entry))).length;
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
