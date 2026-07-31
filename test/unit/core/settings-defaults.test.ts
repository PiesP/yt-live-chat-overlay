import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  SETTINGS_VERSION,
  STORAGE_KEY,
} from '@settings/defaults';

// ── migrateSettings ─────────────────────────────────────────────

describe('migrateSettings', () => {
  it('stamps SETTINGS_VERSION when _version is absent', () => {
    const result = migrateSettings({ enabled: true, fontSize: 24 });
    expect(result._version).toBe(SETTINGS_VERSION);
  });

  it('preserves existing _version when >= current', () => {
    const result = migrateSettings({ _version: 5, enabled: true });
    expect(result._version).toBe(5);
  });

  it('upgrades _version when lower than current', () => {
    const result = migrateSettings({ _version: 0, enabled: true });
    expect(result._version).toBe(2);
  });

  it('migrates from 0 to the current version', () => {
    const result = migrateSettings({ _version: 0, fontSize: 24 });
    expect(result._version).toBe(2);
    expect(result.fontSize).toBe(24);
  });

  it('adds author background colors when migrating v1 settings', () => {
    const result = migrateSettings({ _version: 1, fontSize: 24 });

    expect(result._version).toBe(2);
    expect(result.backgroundColors).toEqual({
      normal: '#00000000',
      member: '#00000000',
      moderator: '#1B3A6F59',
      owner: '#6B4F0059',
      verified: '#00000000',
    });
  });

  it('does not expose the shared background color defaults through migration results', () => {
    const result = migrateSettings({ _version: 1 });

    expect(result.backgroundColors).not.toBe(DEFAULT_SETTINGS.backgroundColors);
    (result.backgroundColors as Record<string, string>).normal = '#12345659';
    expect(DEFAULT_SETTINGS.backgroundColors.normal).toBe('#00000000');
  });

  it('preserves all original keys', () => {
    const input = { enabled: true, speedPxPerSec: 300, fontSize: 32 };
    const result = migrateSettings(input);
    expect(result.enabled).toBe(true);
    expect(result.speedPxPerSec).toBe(300);
    expect(result.fontSize).toBe(32);
  });

  it('handles empty input', () => {
    const result = migrateSettings({});
    expect(result._version).toBe(SETTINGS_VERSION);
  });

  it('does not mutate the input object', () => {
    const input = { fontSize: 24 };
    const inputClone = { ...input };
    migrateSettings(input);
    expect(input).toEqual(inputClone);
  });

  it('exports SETTINGS_VERSION and STORAGE_KEY as constants', () => {
    expect(SETTINGS_VERSION).toBe(2);
    expect(STORAGE_KEY).toBe('yt-live-chat-overlay-settings');
  });
});
