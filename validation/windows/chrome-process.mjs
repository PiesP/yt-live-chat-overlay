// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFile, spawn } from 'node:child_process';
import { win32 } from 'node:path';

const COMMAND_TIMEOUT_MS = 3_000;
const POLL_MS = 100;

function executable(name) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot must be absolute');
  return win32.join(systemRoot, 'System32', name);
}

function validatePid(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Browser process id must be a positive safe integer');
  }
}

function normalizeProfile(profile) {
  if (typeof profile !== 'string' || !win32.isAbsolute(profile) || /["\r\n]/u.test(profile)) {
    throw new Error('Owned Chrome profile must be a safe absolute Windows path');
  }
  return win32.normalize(profile).replace(/[\\/]+$/u, '').toLowerCase();
}

function commandProfile(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const matches = [...commandLine.matchAll(
    /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)/giu
  )];
  if (matches.length !== 1) return null;
  return matches[0][1] ?? matches[0][2] ?? matches[0][3] ?? null;
}

export function isOwnedChromeProcess(record, identity) {
  if (
    !record ||
    typeof record !== 'object' ||
    !identity ||
    typeof identity.executablePath !== 'string' ||
    typeof identity.profile !== 'string'
  ) return false;
  const executablePath = record.ExecutablePath;
  const name = typeof executablePath === 'string' ? win32.basename(executablePath).toLowerCase() : '';
  const profile = commandProfile(record.CommandLine);
  let normalizedCommandProfile;
  try { normalizedCommandProfile = profile === null ? null : normalizeProfile(profile); }
  catch { return false; }
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

function queryWindowsProcess(processId, timeoutMs = COMMAND_TIMEOUT_MS) {
  validatePid(processId);
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}';if($null -eq $p){'null'}else{$p|Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine|ConvertTo-Json -Compress}`;
  return new Promise((resolveQuery, rejectQuery) => {
    execFile(executable('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', maxBuffer: 65_536, timeout: timeoutMs, windowsHide: true },
    (error, stdout) => {
      if (error) rejectQuery(error);
      else {
        try { resolveQuery(JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''))); }
        catch (parseError) { rejectQuery(parseError); }
      }
    });
  });
}

function taskkillTree(processId) {
  validatePid(processId);
  return new Promise((resolveKill, rejectKill) => {
    const child = spawn(executable('taskkill.exe'), ['/PID', String(processId), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      rejectKill(new Error('Timed out terminating the owned Chrome process tree'));
    }, COMMAND_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timeout); rejectKill(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveKill();
      else rejectKill(new Error(`taskkill failed for owned Chrome process ${processId} (${code})`));
    });
  });
}

export async function captureOwnedChromeProcess(
  processId,
  profile,
  { queryProcess = queryWindowsProcess } = {}
) {
  validatePid(processId);
  const normalizedProfile = normalizeProfile(profile);
  const record = await queryProcess(processId);
  const identity = {
    processId,
    commandLine: record?.CommandLine,
    creationDate: record?.CreationDate,
    executablePath: record?.ExecutablePath,
    profile: normalizedProfile,
  };
  if (!isOwnedChromeProcess(record, identity)) {
    throw new Error('CDP browser process does not own the expected Chrome profile');
  }
  return identity;
}

export async function terminateOwnedChromeProcess(
  identity,
  { delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
    queryProcess = queryWindowsProcess, terminateTree = taskkillTree } = {}
) {
  validatePid(identity?.processId);
  const current = await queryProcess(identity.processId);
  if (current === null) return { alreadyExited: true };
  if (!isOwnedChromeProcess(current, identity)) {
    throw new Error('Chrome process identity changed; refusing taskkill');
  }
  let terminationError;
  try { await terminateTree(identity.processId); } catch (error) { terminationError = error; }
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
