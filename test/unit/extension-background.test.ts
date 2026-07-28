// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

type InstalledListener = (details: { reason: string }) => void;
type MenuClickListener = (info: { menuItemId: string | number }, tab?: { id?: number }) => void;

describe('extension background menu commands', () => {
  let installedListener: InstalledListener;
  let menuClickListener: MenuClickListener;
  const create = vi.fn();
  const removeAll = vi.fn((callback?: () => void) => callback?.());
  const sendMessage = vi.fn(async () => undefined);

  beforeEach(async () => {
    vi.resetModules();
    create.mockClear();
    removeAll.mockClear();
    sendMessage.mockClear();

    Object.assign(globalThis, {
      chrome: {
        contextMenus: {
          create,
          removeAll,
          onClicked: {
            addListener: (listener: MenuClickListener) => {
              menuClickListener = listener;
            },
          },
        },
        runtime: {
          onInstalled: {
            addListener: (listener: InstalledListener) => {
              installedListener = listener;
            },
          },
        },
        tabs: { sendMessage },
      },
    });

    await import('../../extension/background');
  });

  it.each(['install', 'update'])('rebuilds both commands on %s', (reason) => {
    installedListener({ reason });

    expect(removeAll).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith({
      id: 'reset-settings',
      title: 'Reset overlay settings',
      contexts: ['action'],
    });
    expect(create).toHaveBeenCalledWith({
      id: 'reload-overlay',
      title: 'Reload overlay',
      contexts: ['action'],
    });
  });

  it('does not rebuild commands for unrelated lifecycle reasons', () => {
    installedListener({ reason: 'browser_update' });

    expect(removeAll).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('forwards known menu commands to the active tab only', async () => {
    menuClickListener({ menuItemId: 'reset-settings' }, { id: 42 });
    menuClickListener({ menuItemId: 'unknown' }, { id: 42 });
    menuClickListener({ menuItemId: 'reload-overlay' }, {});

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'menu-command',
      command: 'reset-settings',
    });
  });
});
