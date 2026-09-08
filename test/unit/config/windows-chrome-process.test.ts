// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Portable Windows acceptance runtime is intentionally plain ESM.
import * as chromeProcessModule from '../../../validation/windows/chrome-process.mjs';

const {
  captureOwnedChromeProcess,
  isOwnedChromeProcess,
  terminateOwnedChromeProcess,
} = chromeProcessModule;

const profile = 'C:\\Users\\Test User\\AppData\\Local\\Temp\\run\\chrome-install-owned';
const record = {
  CommandLine: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=${profile}" --flag`,
  CreationDate: '20260908150102.000000+540',
  ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ProcessId: 456,
};

describe('owned Chrome process identity', () => {
  it('captures the exact CDP process, creation time, executable, and profile argument', async () => {
    const identity = await captureOwnedChromeProcess(456, profile, {
      queryProcess: vi.fn().mockResolvedValue(record),
    });

    expect(identity).toEqual({
      commandLine: record.CommandLine,
      creationDate: record.CreationDate,
      executablePath: record.ExecutablePath,
      processId: 456,
      profile: profile.toLowerCase(),
    });
    expect(isOwnedChromeProcess(record, identity)).toBe(true);
    expect(isOwnedChromeProcess({
      ...record,
      CommandLine: `${record.ExecutablePath} --user-data-dir="${profile}"`,
    }, identity)).toBe(false);
  });

  it('rejects another executable, creation identity, or user-data directory', async () => {
    for (const changed of [
      { ...record, ExecutablePath: 'C:\\Windows\\System32\\notepad.exe' },
      { ...record, CreationDate: '' },
      { ...record, CommandLine: `${record.ExecutablePath} --user-data-dir=C:\\other` },
      { ...record, CommandLine: `${record.CommandLine} --user-data-dir=C:\\second` },
    ]) {
      await expect(captureOwnedChromeProcess(456, profile, {
        queryProcess: vi.fn().mockResolvedValue(changed),
      })).rejects.toThrow(/expected Chrome profile/u);
    }
  });

  it('rechecks the full identity immediately before terminating only its exact PID', async () => {
    const identity = await captureOwnedChromeProcess(456, profile, {
      queryProcess: vi.fn().mockResolvedValue(record),
    });
    const queryProcess = vi.fn()
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(null);
    const terminateTree = vi.fn().mockResolvedValue(undefined);

    await expect(terminateOwnedChromeProcess(identity, {
      delay: vi.fn().mockResolvedValue(undefined),
      queryProcess,
      terminateTree,
    })).resolves.toEqual({ alreadyExited: false });
    expect(terminateTree).toHaveBeenCalledOnce();
    expect(terminateTree).toHaveBeenCalledWith(456);
  });

  it('does not kill an absent or PID-reused process', async () => {
    const identity = await captureOwnedChromeProcess(456, profile, {
      queryProcess: vi.fn().mockResolvedValue(record),
    });
    const terminateTree = vi.fn();
    await expect(terminateOwnedChromeProcess(identity, {
      queryProcess: vi.fn().mockResolvedValue(null),
      terminateTree,
    })).resolves.toEqual({ alreadyExited: true });
    await expect(terminateOwnedChromeProcess(identity, {
      queryProcess: vi.fn().mockResolvedValue({ ...record, CommandLine: `${record.CommandLine} --new` }),
      terminateTree,
    })).rejects.toThrow(/identity changed/u);
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it('reports a terminal failure while the same owned process remains', async () => {
    const identity = await captureOwnedChromeProcess(456, profile, {
      queryProcess: vi.fn().mockResolvedValue(record),
    });
    const terminateTree = vi.fn().mockRejectedValue(new Error('taskkill failed'));
    await expect(terminateOwnedChromeProcess(identity, {
      delay: vi.fn().mockResolvedValue(undefined),
      queryProcess: vi.fn().mockResolvedValue(record),
      terminateTree,
    })).rejects.toThrow('taskkill failed');
    expect(terminateTree).toHaveBeenCalledWith(456);
  });
});
