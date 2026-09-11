import { describe, expect, it } from 'vitest';
import {
  parseSettingsControlName,
  type SettingsControlTarget,
} from '@settings/ui/control-codec';

describe('settings control name codec', () => {
  it.each<[string, SettingsControlTarget]>([
    ['outline-enabled', { group: 'outline', key: 'enabled' }],
    ['outline-opacity', { group: 'outline', key: 'opacity' }],
    ['color-moderator', { group: 'color', key: 'moderator' }],
    ['backgroundColor-owner', { group: 'backgroundColor', key: 'owner' }],
    ['backgroundEnabled-verified', { group: 'backgroundEnabled', key: 'verified' }],
    ['showAuthor-superChat', { group: 'showAuthor', key: 'superChat' }],
    ['fontSize', { group: 'root', key: 'fontSize' }],
  ])('decodes %s', (name, target) => {
    expect(parseSettingsControlName(name)).toEqual(target);
  });

  it.each([
    '',
    'outline-opacity-slider',
    'color-superChat',
    'backgroundColor-unknown',
    'showAuthor-unknown',
    'unknownSetting',
  ])('rejects unsupported control name %s', (name) => {
    expect(parseSettingsControlName(name)).toBeNull();
  });
});
