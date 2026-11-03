// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

const requiredDataTypes = [
  'authenticationInfo',
  'browsingActivity',
  'websiteContent',
  'websiteActivity',
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep packaged consent aligned with the functional requests described in PRIVACY.md. */
export function assertFirefoxDataConsent(manifest: unknown, artifact: string): void {
  const gecko = record(record(record(manifest)?.browser_specific_settings)?.gecko);
  const minimum = gecko?.strict_min_version;
  if (
    gecko?.id !== 'yt-live-chat-overlay@piesp.github.io' ||
    typeof minimum !== 'string' ||
    !/^\d+(?:\.\d+)*$/.test(minimum) ||
    Number(minimum.split('.')[0]) < 140
  ) {
    throw new Error(
      `${artifact} must declare its Gecko identity and Firefox 140+ built-in consent.`
    );
  }

  const permissions = record(gecko.data_collection_permissions);
  const required = permissions?.required;
  const optional = permissions?.optional;
  if (
    !Array.isArray(required) ||
    required.length !== requiredDataTypes.length ||
    !requiredDataTypes.every((type) => required.includes(type)) ||
    (optional !== undefined && (!Array.isArray(optional) || optional.length !== 0))
  ) {
    throw new Error(
      `${artifact} must declare data_collection_permissions.required for ${requiredDataTypes.join(', ')} without optional collection.`
    );
  }
}
