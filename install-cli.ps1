# Install the standalone `lingcode` CLI on Windows (PowerShell 5.1+).
#
#   iwr -useb https://lingcode.dev/install-cli.ps1 | iex
#
# What it does:
#   1. Downloads lingcode-windows-<arch>-v0.9.X-rcN.zip from lingcode.dev
#   2. Extracts to %LOCALAPPDATA%\Programs\lingcode\
#   3. Adds that directory to the User PATH (so `lingcode` works in any
#      new shell — existing shells need to be reopened).
#   4. Prints `lingcode --version`.
#
# Counterpart of install-cli.sh, which handles macOS + Linux. Windows is a
# different beast (PATH editing via registry, no symlinks, .exe extension)
# so it has its own installer rather than trying to share bash.
#
# The CLI binary is unsigned in v0.9.x — Windows Defender SmartScreen will
# show "Windows protected your PC" on first run. Click "More info" →
# "Run anyway". Real Authenticode signing is on the roadmap.

$ErrorActionPreference = "Stop"

# Version pin. Bump this when promoting an RC to stable.
$LingcodeVersion = if ($env:LINGCODE_TS_VERSION) { $env:LINGCODE_TS_VERSION } else { "v0.9.0-rc10" }

# Detect arch. PowerShell exposes $env:PROCESSOR_ARCHITECTURE
# (AMD64, ARM64, x86). We don't ship 32-bit; refuse it.
# For AMD64 we ALSO probe for AVX2 — Bun's standard windows-x64 build emits
# AVX2 instructions; CPUs without it (pre-Haswell ~2013, some Atom/Celeron,
# and many cloud Windows VMs with no AVX2 passthrough) silently crash with
# STATUS_ILLEGAL_INSTRUCTION (exit 0xC000001D). The "-baseline" variant is
# compiled without AVX2 and runs everywhere x86_64 does.
function Test-AVX2 {
    try {
        if (-not ("Win32.CpuFeatures" -as [Type])) {
            Add-Type -Namespace Win32 -Name CpuFeatures -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(uint feature);
"@
        }
        # PF_AVX2_INSTRUCTIONS_AVAILABLE = 40 (winnt.h)
        return [Win32.CpuFeatures]::IsProcessorFeaturePresent(40)
    } catch {
        return $false
    }
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" {
        if (Test-AVX2) { "x64" } else {
            Write-Host "  (CPU does not support AVX2; falling back to baseline build)"
            "x64-baseline"
        }
    }
    "ARM64" { "arm64" }
    Default {
        Write-Error "lingcode: unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

$archiveName = "lingcode-windows-$arch-$LingcodeVersion.zip"
$downloadUrl = if ($env:LINGCODE_TARBALL_URL) { $env:LINGCODE_TARBALL_URL } else { "https://lingcode.dev/$archiveName" }

$installRoot = Join-Path $env:LOCALAPPDATA "Programs\lingcode"
$binDir      = $installRoot   # The .exe lives directly here after extraction.
$exePath     = Join-Path $installRoot "lingcode.exe"

$tmpDir  = Join-Path $env:TEMP ("lingcode-install-" + [System.IO.Path]::GetRandomFileName())
$tmpZip  = Join-Path $tmpDir   "lingcode.zip"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
    Write-Host "▶ Downloading $downloadUrl"
    # ProgressPreference suppresses the noisy progress bar that triples
    # iwr's runtime on Windows for large downloads.
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $tmpZip
    } finally {
        $ProgressPreference = $oldProgress
    }

    Write-Host "▶ Extracting to $installRoot"
    if (Test-Path $installRoot) {
        Remove-Item -Recurse -Force $installRoot
    }
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

    # Zip layout: lingcode-windows-x64/bin/lingcode.exe (Bun --compile output).
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    $srcDir = Get-ChildItem -Path $tmpDir -Directory -Filter "lingcode-*" | Select-Object -First 1
    if (-not $srcDir) {
        Write-Error "lingcode: unexpected archive layout in $downloadUrl"
        exit 1
    }
    $exeSrc = Join-Path $srcDir.FullName "bin\lingcode.exe"
    if (-not (Test-Path $exeSrc)) {
        Write-Error "lingcode: lingcode.exe missing inside archive (expected at $exeSrc)"
        exit 1
    }
    # Flatten: copy the contents of bin/ into installRoot, AND the resource
    # bundle (sibling of bin/) so the binary's resource lookup works.
    Copy-Item -Path (Join-Path $srcDir.FullName "*") -Destination $installRoot -Recurse -Force
    if (Test-Path (Join-Path $installRoot "bin\lingcode.exe")) {
        Copy-Item -Path (Join-Path $installRoot "bin\lingcode.exe") -Destination $exePath -Force
    }
} finally {
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
}

# Add installRoot to the User PATH if not already there. User PATH edits
# require restarting any open shells; we broadcast WM_SETTINGCHANGE so new
# shells pick it up immediately.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$pathEntries = $userPath -split ";" | Where-Object { $_ -ne "" }
if ($pathEntries -notcontains $installRoot) {
    Write-Host "▶ Adding $installRoot to User PATH"
    $newPath = if ($userPath) { "$userPath;$installRoot" } else { $installRoot }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    # Update current session PATH too so the version check below works.
    $env:Path = "$env:Path;$installRoot"

    # Broadcast environment change so new shells pick it up without reboot.
    # Without this, only shells started AFTER reboot see the new PATH.
    if (-not ("Win32.NativeMethods" -as [Type])) {
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
    }
    $HWND_BROADCAST = [IntPtr]0xFFFF
    $WM_SETTINGCHANGE = 0x001A
    $result = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
}

Write-Host ""
Write-Host "✓ Installed lingcode."
Write-Host ""
try {
    & $exePath --version
} catch {
    Write-Warning "lingcode --version returned an error. Try opening a new PowerShell and running ``lingcode --version`` directly."
}

Write-Host ""
Write-Host "  Authenticate:  lingcode providers login"
Write-Host "  First chat:    lingcode run --provider lingmodel ""hello"""
Write-Host ""
Write-Host "  (Reopen any existing terminals so they pick up the new PATH.)"
