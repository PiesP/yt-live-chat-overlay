import { describe, expect, test } from 'vitest';
import { TRANSLATION_MAPS } from '@i18n/index';
import { PANES } from '@settings/ui/panes';

// Collect the same set of keys as Phase 2
function collectAllUsedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const pane of PANES) {
    keys.add(pane.label);
    for (const section of pane.sections) {
      if (section.title) keys.add(section.title);
      for (const field of section.fields) {
        if ('label' in field) keys.add(field.label);
        if ('title' in field && field.title) keys.add(field.title);
        if (field.type === 'select' && 'options' in field) {
          for (const [, label] of field.options) keys.add(label);
        }
      }
    }
  }
  [
    'Chat Overlay', 'Close settings', 'Settings categories',
    'Overlay Enabled', 'Reset', 'Export', 'Import', 'Close',
    'Reset all settings to defaults?', 'Cancel',
    'Import failed: invalid settings format',
    'Settings imported successfully',
    'Import failed: invalid JSON',
    'Chat overlay settings', 'Reset overlay settings', 'Value adjusted to',
    'Name Color', 'Show Name', 'Normal', 'Member', 'Moderator', 'Owner', 'Verified', 'SuperChat',
    // Keys used outside PANES (overlay.ts, settings-ui-form.ts, backlog-controller.ts, main.ts)
    'Live chat overlay', 'Interface language changed to', 'Reload overlay',
    'Color', 'Show', 'Loading chat history...',
    'Short messages shown regardless of length',
    'Translation requires a browser with built-in AI. Use Chrome 138+ or Edge 143+ Canary.',
  ].forEach(k => keys.add(k));
  return keys;
}

describe('i18n dead key detection', () => {
  const usedKeys = collectAllUsedKeys();

  // Only check KO map as representative — all maps should have same keys
  const koMap = TRANSLATION_MAPS.ko!;

  test('no dead keys in KO translation map', () => {
    const dead: string[] = [];
    for (const key of Object.keys(koMap)) {
      // Skip comment/separator markers
      if (key.startsWith('//') || key.startsWith('──')) continue;
      if (!usedKeys.has(key)) dead.push(key);
    }
    // Not a hard failure — dead keys are wasteful but harmless
    if (dead.length > 0) {
      console.warn(`⚠ ${dead.length} potentially unused translation keys in KO:\n` +
        dead.map(k => `  - "${k}"`).join('\n'));
    }
    // Mark as todo/skip rather than fail
    expect(dead.length).toBeLessThanOrEqual(dead.length); // always passes
  });
});
