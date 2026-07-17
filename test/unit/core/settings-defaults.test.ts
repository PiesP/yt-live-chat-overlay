import { describe, it, expect } from 'vitest';
import { migrateSettings, SETTINGS_VERSION, STORAGE_KEY } from '@settings/defaults';

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
    expect(result._version).toBe(1);
  });

  it('migrates from 0 to 1 (upgrades lower version)', () => {
    const result = migrateSettings({ _version: 0, fontSize: 24 });
    expect(result._version).toBe(1);
    expect(result.fontSize).toBe(24);
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
    expect(SETTINGS_VERSION).toBe(1);
    expect(STORAGE_KEY).toBe('yt-live-chat-overlay-settings');
  });
});
