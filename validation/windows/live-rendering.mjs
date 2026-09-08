// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

/** Accept the product's policy fallback only when the public page records it. */
export function validateLiveRenderer(renderer, installation, diagnostics) {
  const workerPolicyFallback = installation === 'extension' && renderer === 'main' &&
    diagnostics.some(({ text }) => /TrustedScriptURL|require-trusted-types-for/i.test(text));
  assert(
    (installation === 'userscript' && renderer === 'main') ||
    (installation === 'extension' && renderer === 'worker') || workerPolicyFallback,
    'The installed application did not prove its expected renderer or page-policy fallback'
  );
  return { renderer, workerPolicyFallback };
}
