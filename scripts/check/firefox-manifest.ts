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

function minimumAtLeast(value: unknown, major: number): boolean {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+(?:\.\d+)?$/.test(value) &&
    Number(value.split('.')[0]) >= major
  );
}

/** Keep packaged consent aligned with the functional requests described in PRIVACY.md. */
export function assertFirefoxDataConsent(manifest: unknown, artifact: string): void {
  const settings = record(record(manifest)?.browser_specific_settings);
  const gecko = record(settings?.gecko);
  if (
    gecko?.id !== 'yt-live-chat-overlay@piesp.github.io' ||
    !minimumAtLeast(gecko.strict_min_version, 140)
  ) {
    throw new Error(
      `${artifact} must declare its Gecko identity and Firefox 140+ built-in consent.`
    );
  }
  if (!minimumAtLeast(gecko.strict_min_version, 147)) {
    throw new Error(`${artifact} must require Firefox 147+ for Navigation.currententrychange.`);
  }
  if (!minimumAtLeast(record(settings?.gecko_android)?.strict_min_version, 142)) {
    throw new Error(`${artifact} must require Firefox for Android 142+ built-in consent.`);
  }
  if (!minimumAtLeast(record(settings?.gecko_android)?.strict_min_version, 147)) {
    throw new Error(
      `${artifact} must require Firefox for Android 147+ for Navigation.currententrychange.`
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
