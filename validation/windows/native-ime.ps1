# SPDX-License-Identifier: MIT
# Copyright (c) 2026 PiesP
# Artifact-only native input helper for the YT viewing IME checkpoints.
# The caller owns the headed browser, focused input target, and post-action DOM trace.
# Caller supplies the owned browser PID from CDP SystemInfo.getProcessInfo
# (type=browser) and confirms Browser.getBrowserCommandLine uses the same profile.

#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ComposeCurrent', 'ComposeToggleRoundTrip', 'CtrlSpaceRoundTrip', 'JapaneseCurrent', 'JapaneseHiragana', 'JapaneseDirect', 'JapaneseDuringComposition', 'NativeSpace')]
    [string]$Sequence,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedWindowTitle,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedProfileDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OwnedOutputDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ReceiptPath,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 4294967295)]
    [uint32]$ExpectedBrowserPID,
    [switch]$RequestExistingKoreanLayout,
    [switch]$RequestExistingJapaneseLayout
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This helper is Windows-only.'
}
if ([IntPtr]::Size -ne 8) {
    throw 'This helper requires an x64 PowerShell process and a 40-byte INPUT union.'
}
if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
    throw 'This helper requires the browser interactive desktop session.'
}
if ($ExpectedWindowTitle -cne 'YT Viewing IME Checkpoint') {
    throw 'The requested title is not the source-bound YT viewing IME checkpoint.'
}
if ($RequestExistingKoreanLayout -and $RequestExistingJapaneseLayout) {
    throw 'Select exactly one existing input language.'
}
if (($Sequence -like 'Japanese*' -or $Sequence -eq 'NativeSpace') -and -not $RequestExistingJapaneseLayout) {
    throw 'Japanese sequences require the existing Japanese input layout.'
}

$outputDirectory = [IO.Path]::GetFullPath($OwnedOutputDirectory).TrimEnd('\')
$receiptFile = [IO.Path]::GetFullPath($ReceiptPath)
$receiptDirectory = [IO.Path]::GetDirectoryName($receiptFile).TrimEnd('\')
if (-not [string]::Equals($outputDirectory, $receiptDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetExtension($receiptFile) -ine '.json' -or
    -not [IO.Directory]::Exists($outputDirectory) -or
    [IO.File]::Exists($receiptFile)) {
    throw 'ReceiptPath must be a new JSON file directly inside the existing owned output directory.'
}
$expectedProfile = [IO.Path]::GetFullPath($ExpectedProfileDirectory).TrimEnd('\')
if (-not [IO.Directory]::Exists($expectedProfile)) {
    throw 'The expected owned browser profile directory does not exist.'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeImeBridge {
    public sealed class WindowInfo {
        public IntPtr Hwnd;
        public string Title;
        public uint Pid;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
        [FieldOffset(8)] public HARDWAREINPUT hi;
    }

    private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextLengthW")]
    private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")]
    private static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] layouts);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PostMessageW", SetLastError = true)]
    private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "SendInput", SetLastError = true)]
    private static extern uint NativeSendInput(uint count, [In] INPUT[] inputs, int inputSize);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
    public static IntPtr ForegroundWindow() { return GetForegroundWindow(); }
    public static IntPtr ThreadLayout(uint threadId) { return GetKeyboardLayout(threadId); }

    private static string ReadTitle(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return null;
        int length = GetWindowTextLength(hwnd);
        if (length < 1 || length > 4095) return null;
        StringBuilder text = new StringBuilder(length + 1);
        if (GetWindowText(hwnd, text, text.Capacity) < 1) return null;
        return text.ToString();
    }

    public static WindowInfo ReadWindow(IntPtr hwnd) {
        string title = ReadTitle(hwnd);
        if (title == null) return null;
        uint pid;
        uint threadId = GetWindowThreadProcessId(hwnd, out pid);
        if (threadId == 0 || pid == 0) return null;
        return new WindowInfo { Hwnd = hwnd, Title = title, Pid = pid, ThreadId = threadId };
    }

    public static WindowInfo[] FindWindows(string exactPrefix) {
        List<WindowInfo> matches = new List<WindowInfo>();
        if (!EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            string title = ReadTitle(hwnd);
            if (title != null && title.StartsWith(exactPrefix, StringComparison.Ordinal)) {
                WindowInfo window = ReadWindow(hwnd);
                if (window != null) matches.Add(window);
            }
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("EnumWindows failed");
        return matches.ToArray();
    }

    public static bool ForegroundMatches(IntPtr hwnd, uint pid, string exactTitle) {
        if (GetForegroundWindow() != hwnd) return false;
        WindowInfo current = ReadWindow(hwnd);
        return current != null && current.Pid == pid &&
            String.Equals(current.Title, exactTitle, StringComparison.Ordinal);
    }

    public static uint SendKeyboard(IntPtr hwnd, uint pid, string exactTitle, ushort[] virtualKeys, bool[] keyUps) {
        if (!ForegroundMatches(hwnd, pid, exactTitle))
            throw new InvalidOperationException("Foreground window, title, or PID drifted before SendInput");
        if (virtualKeys == null || keyUps == null || virtualKeys.Length != keyUps.Length ||
            virtualKeys.Length < 1 || virtualKeys.Length > 4)
            throw new ArgumentException("Keyboard batch must contain one to four paired VK events");
        INPUT[] inputs = new INPUT[virtualKeys.Length];
        for (int i = 0; i < inputs.Length; i++) {
            inputs[i].type = 1; // INPUT_KEYBOARD; no KEYEVENTF_UNICODE or injected text.
            inputs[i].ki.wVk = virtualKeys[i];
            inputs[i].ki.dwFlags = keyUps[i] ? 0x0002u : 0u; // KEYEVENTF_KEYUP
        }
        return NativeSendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static bool RequestLayout(IntPtr hwnd, uint pid, string exactTitle, IntPtr layout) {
        if (!ForegroundMatches(hwnd, pid, exactTitle))
            throw new InvalidOperationException("Foreground window drifted before layout request");
        return PostMessage(hwnd, 0x0050u, IntPtr.Zero, layout); // WM_INPUTLANGCHANGEREQUEST
    }

    public static IntPtr[] ExistingLayouts() {
        int count = GetKeyboardLayoutList(0, null);
        if (count < 1 || count > 64) throw new InvalidOperationException("Invalid existing HKL list");
        IntPtr[] layouts = new IntPtr[count];
        int copied = GetKeyboardLayoutList(count, layouts);
        if (copied != count) throw new InvalidOperationException("Existing HKL list changed");
        return layouts;
    }

    public static string[] ParseCommandLine(string commandLine) {
        int count;
        IntPtr pointer = CommandLineToArgvW(commandLine, out count);
        if (pointer == IntPtr.Zero || count < 1 || count > 256)
            throw new InvalidOperationException("Cannot parse browser command line");
        try {
            string[] result = new string[count];
            for (int i = 0; i < count; i++)
                result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
            return result;
        } finally { LocalFree(pointer); }
    }
}
'@

if ([NativeImeBridge]::InputSize() -ne 40) {
    throw 'The compiled native INPUT union is not 40 bytes.'
}

$hash = [Security.Cryptography.SHA256]::Create()
try {
    $profileBytes = [Text.Encoding]::UTF8.GetBytes($expectedProfile.ToLowerInvariant())
    $profileHash = ([BitConverter]::ToString($hash.ComputeHash($profileBytes))).Replace('-', '').ToLowerInvariant()
} finally {
    $hash.Dispose()
}

$receipt = [ordered]@{
    schemaVersion = 1
    kind = 'native-ime-action-only'
    status = 'aborted'
    sequence = $Sequence
    expectedTitlePrefix = $ExpectedWindowTitle
    expectedProfileSha256 = $profileHash
    requestedExistingKoreanLayout = [bool]$RequestExistingKoreanLayout
    requestedExistingJapaneseLayout = [bool]$RequestExistingJapaneseLayout
    target = $null
    hklBefore = $null
    hklAfter = $null
    layoutDelivery = [ordered]@{
        requestPosted = $false
        requestAcknowledged = $false
        restorePosted = $false
        restoreAcknowledged = $false
        processingUncertain = $false
    }
    sendCounts = [ordered]@{ calls = 0; requestedEvents = 0; acceptedEvents = 0 }
    actions = @()
    errors = @()
    cleanup = [ordered]@{
        releasedKeys = $true
        restoreActionDispatched = $false
        parityActionsBalanced = $(if ($Sequence -in @('ComposeToggleRoundTrip', 'CtrlSpaceRoundTrip')) { $false } else { 'not-applicable' })
        modeRestored = 'not-observed'
        hklRestored = 'not-checked'
    }
    interpretation = 'No TSF open/conversion mode claim; caller must inspect trusted DOM composition and text.'
}

$target = $null
$originalHkl = [IntPtr]::Zero
$pendingToggle = $null
$partialInput = $false
$pressed = New-Object 'System.Collections.Generic.List[UInt16]'
$clock = [Diagnostics.Stopwatch]::StartNew()
$actionDeadlineSeconds = 13.0
$cleanupDeadlineSeconds = 15.0
$cleanupPhase = $false

function Assert-Deadline {
    $limit = if ($cleanupPhase) { $cleanupDeadlineSeconds } else { $actionDeadlineSeconds }
    if ($clock.Elapsed.TotalSeconds -ge $limit) {
        throw 'Native input reached the 13-second action or 15-second cleanup bound.'
    }
}

function Assert-OwnedForeground {
    Assert-Deadline
    if ($null -eq $target -or -not [NativeImeBridge]::ForegroundMatches($target.Hwnd, $target.Pid, $target.Title)) {
        throw 'Owned browser focus, title, or PID drifted; further input was stopped.'
    }
}

function HklHex([IntPtr]$layout) {
    $unsigned = [BitConverter]::ToUInt64([BitConverter]::GetBytes($layout.ToInt64()), 0)
    return ('0x{0:X16}' -f $unsigned)
}

function Request-TargetLayout([IntPtr]$layout, [string]$reason) {
    Assert-OwnedForeground
    if (-not [NativeImeBridge]::RequestLayout($target.Hwnd, $target.Pid, $target.Title, $layout)) {
        throw "The owned window rejected $reason HKL request."
    }
    if ($reason -eq 'original') {
        $receipt.layoutDelivery.restorePosted = $true
    } else {
        $receipt.layoutDelivery.requestPosted = $true
    }
    $receipt.actions += [ordered]@{ kind = 'hkl-request-posted'; reason = $reason; hkl = (HklHex $layout); atMs = $clock.ElapsedMilliseconds }
    $until = [Diagnostics.Stopwatch]::StartNew()
    while ([NativeImeBridge]::ThreadLayout($target.ThreadId) -ne $layout) {
        Assert-OwnedForeground
        if ($until.ElapsedMilliseconds -ge 1500) {
            $receipt.layoutDelivery.processingUncertain = $true
            throw "The owned foreground thread did not adopt $reason HKL."
        }
        Start-Sleep -Milliseconds 50
    }
    if ($reason -eq 'original') {
        $receipt.layoutDelivery.restoreAcknowledged = $true
    } else {
        $receipt.layoutDelivery.requestAcknowledged = $true
    }
    $receipt.actions += [ordered]@{ kind = 'hkl-request-observed'; reason = $reason; hkl = (HklHex $layout); atMs = $clock.ElapsedMilliseconds }
}

function Invoke-KeyBatch([System.UInt16[]]$keys, [bool[]]$ups, [string]$label) {
    Assert-OwnedForeground
    $sent = [NativeImeBridge]::SendKeyboard($target.Hwnd, $target.Pid, $target.Title, $keys, $ups)
    $receipt.sendCounts.calls++
    $receipt.sendCounts.requestedEvents += $keys.Length
    $receipt.sendCounts.acceptedEvents += $sent
    for ($index = 0; $index -lt [int]$sent; $index++) {
        if ($ups[$index]) {
            for ($held = $pressed.Count - 1; $held -ge 0; $held--) {
                if ($pressed[$held] -eq $keys[$index]) { $pressed.RemoveAt($held); break }
            }
        } else {
            $pressed.Add($keys[$index])
        }
    }
    $receipt.actions += [ordered]@{ kind = 'keyboard'; label = $label; requested = $keys.Length; accepted = $sent; atMs = $clock.ElapsedMilliseconds }
    if ($sent -ne $keys.Length) {
        $script:partialInput = $true
        $win32Error = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "SendInput accepted $sent of $($keys.Length) events for $label (Win32 error $win32Error)."
    }
}

function Invoke-KeyPress([System.UInt16]$key, [string]$label) {
    Invoke-KeyBatch ([System.UInt16[]]@($key, $key)) ([bool[]]@($false, $true)) $label
}

function Invoke-Combo([System.UInt16]$modifier, [System.UInt16]$key, [string]$label) {
    Invoke-KeyBatch ([System.UInt16[]]@($modifier, $key, $key, $modifier)) ([bool[]]@($false, $false, $true, $true)) $label
}

function Invoke-Word {
    # Synthesized ordinary native VKs for two-set Korean "한글": g k s r m f, then Space.
    foreach ($key in [System.UInt16[]]@(0x47, 0x4B, 0x53, 0x52, 0x4D, 0x46, 0x20)) {
        Invoke-KeyPress $key ('word-vk-{0:X2}' -f $key)
        Start-Sleep -Milliseconds 40
    }
}

function Invoke-JapaneseWord([bool]$convert) {
    # Romaji "nihongo" through ordinary native VKs; Space opens conversion candidates.
    foreach ($key in [System.UInt16[]]@(0x4E, 0x49, 0x48, 0x4F, 0x4E, 0x47, 0x4F)) {
        Invoke-KeyPress $key ('japanese-word-vk-{0:X2}' -f $key)
        Start-Sleep -Milliseconds 40
    }
    if ($convert) {
        Invoke-KeyPress 0x20 'japanese-conversion-candidate'
        Start-Sleep -Milliseconds 150
    }
    Invoke-KeyPress 0x0D 'japanese-commit'
}

try {
    $windows = @([NativeImeBridge]::FindWindows($ExpectedWindowTitle))
    if ($windows.Count -ne 1) { throw "Expected one titled Chrome/Edge window; found $($windows.Count)." }
    $target = $windows[0]
    if ($target.Pid -ne $ExpectedBrowserPID) {
        throw 'The titled browser window PID disagrees with ExpectedBrowserPID.'
    }
    $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $target.Pid) -OperationTimeoutSec 2
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace($process.CommandLine)) {
        throw 'The target browser process image or command line could not be verified.'
    }
    $image = [IO.Path]::GetFileName($process.ExecutablePath)
    if ($image -notin @('chrome.exe', 'msedge.exe') -or $process.Name -ine $image -or
        -not [IO.File]::Exists($process.ExecutablePath)) {
        throw 'The titled window is not backed by an installed Chrome or Edge executable image.'
    }
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ([int]$process.SessionId -ne $sessionId) {
        throw 'The browser window and helper are in different interactive sessions.'
    }
    $arguments = [NativeImeBridge]::ParseCommandLine($process.CommandLine)
    $profiles = @()
    for ($i = 0; $i -lt $arguments.Length; $i++) {
        if ($arguments[$i].StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) {
            $profiles += $arguments[$i].Substring('--user-data-dir='.Length)
        } elseif ([string]::Equals($arguments[$i], '--user-data-dir', [StringComparison]::OrdinalIgnoreCase)) {
            if ($i + 1 -ge $arguments.Length) { throw 'Browser user-data-dir flag has no value.' }
            $profiles += $arguments[++$i]
        }
    }
    if ($profiles.Count -ne 1 -or [string]::IsNullOrWhiteSpace($profiles[0]) -or
        -not [string]::Equals([IO.Path]::GetFullPath($profiles[0]).TrimEnd('\'), $expectedProfile,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The browser process is not bound to the exact owned user-data-dir.'
    }
    $receipt.target = [ordered]@{
        pid = $target.Pid
        threadId = $target.ThreadId
        title = $target.Title
        processImage = $image
        sessionId = $sessionId
        profileSha256 = $profileHash
        profileMatched = $true
    }
    Assert-OwnedForeground
    $originalHkl = [NativeImeBridge]::ThreadLayout($target.ThreadId)
    if ($originalHkl -eq [IntPtr]::Zero) { throw 'The foreground browser thread has no HKL.' }
    $receipt.hklBefore = HklHex $originalHkl

    if ($RequestExistingKoreanLayout) {
        $korean = @([NativeImeBridge]::ExistingLayouts() | Where-Object { ($_.ToInt64() -band 0xffff) -eq 0x0412 })
        if ($korean.Count -ne 1) { throw "Expected one existing Korean HKL; found $($korean.Count)." }
        if ($korean[0] -ne $originalHkl) { Request-TargetLayout $korean[0] 'existing-Korean' }
    }
    if ($RequestExistingJapaneseLayout) {
        $japanese = @([NativeImeBridge]::ExistingLayouts() | Where-Object { ($_.ToInt64() -band 0xffff) -eq 0x0411 })
        if ($japanese.Count -ne 1) { throw "Expected one existing Japanese HKL; found $($japanese.Count)." }
        if ($japanese[0] -ne $originalHkl) { Request-TargetLayout $japanese[0] 'existing-Japanese' }
    }

    switch ($Sequence) {
        'ComposeCurrent' {
            Invoke-Word
        }
        'ComposeToggleRoundTrip' {
            Invoke-KeyPress 0x15 'VK_HANGUL-toggle-before-word'
            $pendingToggle = 'hangul'
            Start-Sleep -Milliseconds 100
            Invoke-Word
        }
        'CtrlSpaceRoundTrip' {
            Invoke-Combo 0x11 0x20 'Ctrl-Space-pause'
            $pendingToggle = 'ctrl-space'
            Start-Sleep -Milliseconds 500
            Invoke-Combo 0x11 0x20 'Ctrl-Space-resume'
            $pendingToggle = $null
            $receipt.cleanup.restoreActionDispatched = $true
            $receipt.cleanup.parityActionsBalanced = $true
        }
        'JapaneseCurrent' { Invoke-JapaneseWord $true }
        'JapaneseHiragana' {
            Invoke-Combo 0x11 0x14 'Japanese-Ctrl-CapsLock-Hiragana'
            Start-Sleep -Milliseconds 100
            Invoke-JapaneseWord $true
        }
        'JapaneseDirect' {
            Invoke-Combo 0x10 0x14 'Japanese-Shift-CapsLock-Alphanumeric'
            Start-Sleep -Milliseconds 100
            Invoke-JapaneseWord $false
        }
        'JapaneseDuringComposition' {
            Invoke-Combo 0x11 0x14 'Japanese-Ctrl-CapsLock-Hiragana'
            Start-Sleep -Milliseconds 100
            foreach ($key in [System.UInt16[]]@(0x4E, 0x49, 0x48, 0x4F, 0x4E)) {
                Invoke-KeyPress $key ('japanese-pending-vk-{0:X2}' -f $key)
                Start-Sleep -Milliseconds 40
            }
            $pendingMarker = $receiptFile + '.pending'
            $gateAck = $receiptFile + '.ack'
            if ([IO.File]::Exists($pendingMarker) -or [IO.File]::Exists($gateAck)) {
                throw 'Composition gate files already exist.'
            }
            [IO.File]::WriteAllText($pendingMarker, 'pending')
            $receipt.actions += [ordered]@{ kind = 'composition-gate'; label = 'pending-observation-requested'; atMs = $clock.ElapsedMilliseconds }
            while (-not [IO.File]::Exists($gateAck)) {
                Assert-OwnedForeground
                Start-Sleep -Milliseconds 40
            }
            $gate = Get-Content -LiteralPath $gateAck -Raw | ConvertFrom-Json
            if ($gate.allow -cne $true) {
                throw 'Owned browser did not observe an open Japanese composition before Ctrl+Space.'
            }
            $receipt.actions += [ordered]@{ kind = 'composition-gate'; label = 'open-observation-acknowledged'; atMs = $clock.ElapsedMilliseconds }
            Invoke-Combo 0x11 0x20 'Japanese-Ctrl-Space-during-composition'
            Start-Sleep -Milliseconds 100
            foreach ($key in [System.UInt16[]]@(0x47, 0x4F)) {
                Invoke-KeyPress $key ('japanese-finish-vk-{0:X2}' -f $key)
                Start-Sleep -Milliseconds 40
            }
            Invoke-KeyPress 0x20 'japanese-conversion-candidate'
            Start-Sleep -Milliseconds 150
            Invoke-KeyPress 0x0D 'japanese-commit'
        }
        'NativeSpace' { Invoke-KeyPress 0x20 'native-player-space' }
    }
    $receipt.status = 'action-dispatched'
} catch {
    $receipt.errors += $_.Exception.Message
} finally {
    $cleanupPhase = $true
    # Release only keys that this helper observed going down in a partial SendInput batch.
    while ($pressed.Count -gt 0) {
        try {
            Assert-OwnedForeground
            $key = $pressed[$pressed.Count - 1]
            Invoke-KeyBatch ([System.UInt16[]]@($key)) ([bool[]]@($true)) ('cleanup-keyup-{0:X2}' -f $key)
        } catch {
            $receipt.cleanup.releasedKeys = $false
            $receipt.errors += ('Key release aborted: ' + $_.Exception.Message)
            break
        }
    }
    if ($null -ne $pendingToggle) {
        if ($partialInput) {
            $receipt.cleanup.parityActionsBalanced = $false
            $receipt.errors += 'Toggle action balance is unknown after partial SendInput; no further toggle was sent.'
        } else {
            try {
                Assert-OwnedForeground
                if ($pendingToggle -eq 'hangul') {
                    Invoke-KeyPress 0x15 'VK_HANGUL-toggle-restore'
                } else {
                    Invoke-Combo 0x11 0x20 'Ctrl-Space-toggle-restore'
                }
                $pendingToggle = $null
                $receipt.cleanup.restoreActionDispatched = $true
                $receipt.cleanup.parityActionsBalanced = $true
            } catch {
                $receipt.cleanup.parityActionsBalanced = $false
                $receipt.errors += ('Toggle restore aborted: ' + $_.Exception.Message)
            }
        }
    }
    if ($partialInput -and $Sequence -in @('ComposeToggleRoundTrip', 'CtrlSpaceRoundTrip')) {
        $receipt.cleanup.parityActionsBalanced = $false
    }
    if ($null -ne $target -and $originalHkl -ne [IntPtr]::Zero) {
        try {
            $currentHkl = [NativeImeBridge]::ThreadLayout($target.ThreadId)
            $requestPending = $receipt.layoutDelivery.requestPosted -and
                -not $receipt.layoutDelivery.requestAcknowledged
            if ($requestPending) {
                # A posted Korean request may still be queued even if the current HKL looks original.
                # Queue the original HKL behind it, but do not infer that either message ran.
                Assert-OwnedForeground
                if (-not [NativeImeBridge]::RequestLayout($target.Hwnd, $target.Pid, $target.Title, $originalHkl)) {
                    throw 'The owned window rejected ordered original-HKL cleanup.'
                }
                $receipt.layoutDelivery.restorePosted = $true
                $receipt.layoutDelivery.processingUncertain = $true
                $receipt.actions += [ordered]@{ kind = 'hkl-restore-posted-unverified'; hkl = (HklHex $originalHkl); atMs = $clock.ElapsedMilliseconds }
                $receipt.errors += 'HKL request processing is uncertain; ordered restore was posted but cannot be verified.'
                $receipt.cleanup.hklRestored = 'unknown'
            } else {
                if ($currentHkl -ne $originalHkl) { Request-TargetLayout $originalHkl 'original' }
                $afterHkl = [NativeImeBridge]::ThreadLayout($target.ThreadId)
                if ($afterHkl -ne $originalHkl -or
                    ($receipt.layoutDelivery.requestPosted -and -not $receipt.layoutDelivery.requestAcknowledged) -or
                    ($receipt.layoutDelivery.restorePosted -and -not $receipt.layoutDelivery.restoreAcknowledged)) {
                    throw 'The owned browser thread HKL or request acknowledgments were not verified.'
                }
                $receipt.cleanup.hklRestored = 'verified'
            }
        } catch {
            $receipt.cleanup.hklRestored = 'unknown'
            if ($receipt.layoutDelivery.requestPosted -or $receipt.layoutDelivery.restorePosted) {
                $receipt.layoutDelivery.processingUncertain = $true
            }
            $receipt.errors += ('HKL restore aborted: ' + $_.Exception.Message)
        } finally {
            $receipt.hklAfter = HklHex ([NativeImeBridge]::ThreadLayout($target.ThreadId))
        }
    }
    $receipt.cleanup.pressedKeysRemaining = $pressed.Count
    $receipt.cleanup.togglePending = $pendingToggle
    $receipt.cleanup.elapsedMs = $clock.ElapsedMilliseconds
    if ($receipt.errors.Count -gt 0 -or -not $receipt.cleanup.releasedKeys -or
        ($Sequence -in @('ComposeToggleRoundTrip', 'CtrlSpaceRoundTrip') -and $receipt.cleanup.parityActionsBalanced -ne $true) -or
        $receipt.cleanup.hklRestored -ne 'verified') {
        $receipt.status = 'aborted'
    }
    $json = ConvertTo-Json -InputObject $receipt -Depth 12
    $stream = [IO.File]::Open($receiptFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine($json); $writer.Flush() } finally { $writer.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

if ($receipt.status -ne 'action-dispatched') {
    throw ('Native IME helper aborted; see receipt: ' + $receiptFile)
}
