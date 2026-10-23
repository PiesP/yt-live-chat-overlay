// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFile, spawn } from 'node:child_process';
import { win32 } from 'node:path';

const COMMAND_TIMEOUT_MS = 3_000;
const POLL_MS = 100;

interface WindowsProcessRecord {
  ProcessId: unknown;
  CreationDate: unknown;
  ExecutablePath: unknown;
  CommandLine: unknown;
}

interface VerifiedWindowsProcessRecord {
  ProcessId: number;
  CreationDate: string;
  ExecutablePath: string;
  CommandLine: string;
}

export interface ChromeProcessIdentity {
  processId: number;
  creationDate: string;
  executablePath: string;
  commandLine: string;
  profile: string;
}

type QueryProcess = (processId: number, timeoutMs?: number) => Promise<WindowsProcessRecord | null>;

function executable(name: string): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot must be absolute');
  return win32.join(systemRoot, 'System32', name);
}

function validatePid(processId: unknown): asserts processId is number {
  if (typeof processId !== 'number' || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Browser process id must be a positive safe integer');
  }
}

function normalizeProfile(profile: unknown): string {
  if (typeof profile !== 'string' || !win32.isAbsolute(profile) || /["\r\n]/u.test(profile)) {
    throw new Error('Owned Chrome profile must be a safe absolute Windows path');
  }
  return win32
    .normalize(profile)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
}

function commandProfile(commandLine: unknown): string | null {
  if (typeof commandLine !== 'string') return null;
  const matches = [
    ...commandLine.matchAll(
      /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)/giu
    ),
  ];
  if (matches.length !== 1) return null;
  return matches[0]?.[1] ?? matches[0]?.[2] ?? matches[0]?.[3] ?? null;
}

export function isOwnedChromeProcess(
  record: WindowsProcessRecord | null,
  identity: {
    processId: number;
    creationDate: unknown;
    executablePath: unknown;
    commandLine: unknown;
    profile: string;
  }
): record is VerifiedWindowsProcessRecord {
  if (
    !record ||
    typeof record !== 'object' ||
    !identity ||
    typeof identity.executablePath !== 'string' ||
    typeof identity.profile !== 'string'
  )
    return false;
  const executablePath = record.ExecutablePath;
  const name =
    typeof executablePath === 'string' ? win32.basename(executablePath).toLowerCase() : '';
  const profile = commandProfile(record.CommandLine);
  let normalizedCommandProfile: string | null;
  try {
    normalizedCommandProfile = profile === null ? null : normalizeProfile(profile);
  } catch {
    return false;
  }
  return (
    record.ProcessId === identity.processId &&
    typeof record.CreationDate === 'string' &&
    record.CreationDate.length > 0 &&
    record.CreationDate === identity.creationDate &&
    record.CommandLine === identity.commandLine &&
    typeof executablePath === 'string' &&
    win32.isAbsolute(executablePath) &&
    executablePath.toLowerCase() === identity.executablePath.toLowerCase() &&
    (name === 'chrome.exe' || name === 'msedge.exe') &&
    normalizedCommandProfile === identity.profile
  );
}

function queryWindowsProcess(
  processId: number,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<WindowsProcessRecord | null> {
  validatePid(processId);
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}';if($null -eq $p){'null'}else{$p|Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine|ConvertTo-Json -Compress}`;
  return new Promise<WindowsProcessRecord | null>((resolveQuery, rejectQuery) => {
    execFile(
      executable('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', maxBuffer: 65_536, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) rejectQuery(error);
        else {
          try {
            const parsed: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''));
            if (parsed === null) {
              resolveQuery(null);
            } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
              resolveQuery({
                ProcessId: 'ProcessId' in parsed ? parsed.ProcessId : undefined,
                CreationDate: 'CreationDate' in parsed ? parsed.CreationDate : undefined,
                ExecutablePath: 'ExecutablePath' in parsed ? parsed.ExecutablePath : undefined,
                CommandLine: 'CommandLine' in parsed ? parsed.CommandLine : undefined,
              });
            } else {
              rejectQuery(new Error('Invalid Windows process query response'));
            }
          } catch (parseError) {
            rejectQuery(parseError);
          }
        }
      }
    );
  });
}

function taskkillTree(processId: number): Promise<void> {
  validatePid(processId);
  return new Promise<void>((resolveKill, rejectKill) => {
    const child = spawn(executable('taskkill.exe'), ['/PID', String(processId), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      rejectKill(new Error('Timed out terminating the owned Chrome process tree'));
    }, COMMAND_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectKill(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveKill();
      else rejectKill(new Error(`taskkill failed for owned Chrome process ${processId} (${code})`));
    });
  });
}

export async function captureOwnedChromeProcess(
  processId: number,
  profile: string,
  { queryProcess = queryWindowsProcess }: { queryProcess?: QueryProcess } = {}
): Promise<ChromeProcessIdentity> {
  validatePid(processId);
  const normalizedProfile = normalizeProfile(profile);
  const record = await queryProcess(processId);
  const candidate = {
    processId,
    commandLine: record?.CommandLine,
    creationDate: record?.CreationDate,
    executablePath: record?.ExecutablePath,
    profile: normalizedProfile,
  };
  if (!isOwnedChromeProcess(record, candidate)) {
    throw new Error('CDP browser process does not own the expected Chrome profile');
  }
  return {
    processId,
    commandLine: record.CommandLine,
    creationDate: record.CreationDate,
    executablePath: record.ExecutablePath,
    profile: normalizedProfile,
  };
}

export async function terminateOwnedChromeProcess(
  identity: ChromeProcessIdentity | null,
  {
    delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
    queryProcess = queryWindowsProcess,
    terminateTree = taskkillTree,
  }: {
    delay?: (ms: number) => Promise<void>;
    queryProcess?: QueryProcess;
    terminateTree?: (processId: number) => Promise<void>;
  } = {}
): Promise<{ alreadyExited: boolean }> {
  validatePid(identity?.processId);
  if (!identity) throw new Error('Browser process identity is required');
  const current = await queryProcess(identity.processId);
  if (current === null) return { alreadyExited: true };
  if (!isOwnedChromeProcess(current, identity)) {
    throw new Error('Chrome process identity changed; refusing taskkill');
  }
  let terminationError: unknown;
  try {
    await terminateTree(identity.processId);
  } catch (error) {
    terminationError = error;
  }
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  for (let attempt = 0; attempt < COMMAND_TIMEOUT_MS / POLL_MS; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const remaining = await queryProcess(identity.processId, remainingMs);
    if (remaining === null || !isOwnedChromeProcess(remaining, identity)) {
      return { alreadyExited: false };
    }
    await delay(POLL_MS);
  }
  throw terminationError ?? new Error('Owned Chrome process tree did not terminate');
}
