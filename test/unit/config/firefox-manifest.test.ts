// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { assertFirefoxDataConsent } from '../../../scripts/check/firefox-manifest';

function manifest() {
  return {
    browser_specific_settings: {
      gecko: {
        id: 'yt-live-chat-overlay@piesp.github.io',
        strict_min_version: '147.0',
        data_collection_permissions: {
          required: ['authenticationInfo', 'browsingActivity', 'websiteContent', 'websiteActivity'],
        },
      },
      gecko_android: { strict_min_version: '147.0' },
    },
  };
}

describe('Firefox data consent contract', () => {
  it('keeps the shipped manifest aligned with functional YouTube requests', () => {
    const source: unknown = JSON.parse(
      readFileSync(resolve('extension/manifest.firefox.json'), 'utf8')
    );
    expect(() => assertFirefoxDataConsent(source, 'source manifest')).not.toThrow();
    expect(source).toMatchObject(manifest());
  });

  it('accepts a newer consent-capable floor and unordered required permissions', () => {
    const source = manifest();
    source.browser_specific_settings.gecko.strict_min_version = '148.0';
    source.browser_specific_settings.gecko.data_collection_permissions.required.reverse();
    expect(() => assertFirefoxDataConsent(source, 'manifest')).not.toThrow();
  });

  it.each([null, [], {}, { browser_specific_settings: { gecko: [] } }])(
    'rejects a missing or malformed Gecko declaration: %j',
    (source) => {
      expect(() => assertFirefoxDataConsent(source, 'fixture')).toThrow('fixture must declare');
    }
  );

  it.each(['128.0', '139.99', '140.0a1', '140.*', '', 'not-a-version'])(
    'rejects a floor without the stable built-in consent contract: %s',
    (minimum) => {
      const source = manifest();
      source.browser_specific_settings.gecko.strict_min_version = minimum;
      expect(() => assertFirefoxDataConsent(source, 'fixture')).toThrow('Firefox 140+');
    }
  );

  it('rejects a consent-capable Firefox without currententrychange', () => {
    const source = manifest();
    source.browser_specific_settings.gecko.strict_min_version = '146.0';
    expect(() => assertFirefoxDataConsent(source, 'fixture')).toThrow('Firefox 147+');
  });

  it.each([undefined, null, '141.99', '142.*', 'not-a-version'])(
    'rejects a missing or unsupported Android consent floor: %j',
    (minimum) => {
      const source = manifest();
      const browser_specific_settings = {
        ...source.browser_specific_settings,
        gecko_android: minimum === undefined ? undefined : { strict_min_version: minimum },
      };
      expect(() => assertFirefoxDataConsent({ browser_specific_settings }, 'fixture')).toThrow(
        'Android 142+'
      );
    }
  );

  it('rejects an Android installation floor below the required navigation API', () => {
    const source = manifest();
    source.browser_specific_settings.gecko_android.strict_min_version = '146.0';
    expect(() => assertFirefoxDataConsent(source, 'fixture')).toThrow('Android 147+');
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { required: 'websiteContent' },
    { required: ['none'] },
    { required: ['authenticationInfo', 'browsingActivity', 'websiteContent'] },
    { required: ['authenticationInfo', 'browsingActivity', 'websiteContent', 'websiteContent'] },
    {
      required: [
        ...manifest().browser_specific_settings.gecko.data_collection_permissions.required,
        'searchTerms',
      ],
    },
    {
      ...manifest().browser_specific_settings.gecko.data_collection_permissions,
      optional: ['technicalAndInteraction'],
    },
    { ...manifest().browser_specific_settings.gecko.data_collection_permissions, optional: null },
  ])('rejects missing, inaccurate or optional collection: %j', (permissions) => {
    const source = manifest();
    const gecko = {
      ...source.browser_specific_settings.gecko,
      data_collection_permissions: permissions,
    };
    expect(() =>
      assertFirefoxDataConsent(
        { browser_specific_settings: { ...source.browser_specific_settings, gecko } },
        'fixture'
      )
    ).toThrow('data_collection_permissions.required');
  });
});
