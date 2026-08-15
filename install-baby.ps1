# Install LingCodeBaby on Windows (PowerShell 5.1+).
#
#   curl -fsSL https://lingcode.dev/install-baby.ps1 | powershell -NoProfile -Command -
#
# (curl.exe ships inbox on Windows 10 1803+ and Windows 11 — this is a real
# curl | shell pipe, not a PowerShell-only lookalike. If you'd rather stay in
# pure PowerShell: `irm https://lingcode.dev/install-baby.ps1 | iex` does the
# same thing via Invoke-RestMethod instead of curl.exe.)
#
# What it does:
#   1. Fetches the live updater manifest at lingcode.dev/lingcodebaby/latest.json
#      (the same manifest the installed app's own auto-updater polls — there is
#      no separate "installer" version to keep in sync).
#   2. Picks the setup .exe for your CPU (x64 or arm64).
#   3. If LingCodeBaby is already installed and current, does nothing.
#      If installed but older, re-downloads and re-runs the installer (NSIS
#      installs upgrade in place). Otherwise, installs fresh.
#   4. Runs the installer INTERACTIVELY (not silently) by default, so you see
#      the normal Windows installer UI — including a Windows Defender
#      SmartScreen "Windows protected your PC" prompt on first run, since the
#      build isn't yet Authenticode-signed. Click "More info" -> "Run anyway".
#      Pass -Silent (or set LINGCODEBABY_SILENT=1) to run unattended with /S —
#      only do this if you already trust the source, since it skips the
#      SmartScreen prompt you'd otherwise see.
#
# Counterpart of install-cli.ps1, but deliberately different in a few ways:
#   - Source of truth is the self-hosted latest.json, not a GitHub Releases
#     alias — LingCodeBaby's GitHub release workflow publishes DRAFT releases
#     that need a manual publish click, so `releases/latest` isn't reliable.
#   - No PATH edits. This is a GUI app launched from the Start Menu (which
#     NSIS wires up itself), not a CLI binary that needs to be on PATH.

[CmdletBinding()]
param(
    [switch]$Silent
)

$ErrorActionPreference = "Stop"

$ManifestUrl = if ($env:LINGCODEBABY_MANIFEST_URL) { $env:LINGCODEBABY_MANIFEST_URL } else { "https://lingcode.dev/lingcodebaby/latest.json" }
$SilentInstall = $Silent -or ($env:LINGCODEBABY_SILENT -eq "1")
$DryRun = $env:LINGCODEBABY_DRYRUN -eq "1"

# ── 1. Fetch + parse the manifest ──────────────────────────────────────────
Write-Host "▶ Checking $ManifestUrl"
try {
    $manifest = Invoke-RestMethod -UseBasicParsing -Uri $ManifestUrl
} catch {
    Write-Error "lingcodebaby: couldn't reach $ManifestUrl ($($_.Exception.Message))"
    exit 1
}

$remoteVersion = $manifest.version
if (-not $remoteVersion) {
    Write-Error "lingcodebaby: manifest at $ManifestUrl has no 'version' field"
    exit 1
}

# ── 2. Arch-detect -> platform key ─────────────────────────────────────────
# Tauri's own platform-key convention, matching what's already in the manifest.
# No AVX2 probing here (unlike install-cli.ps1) — that's specific to the CLI's
# Bun-compiled binaries; this is a standard MSVC-target Rust/NSIS build with no
# arch-feature overrides, so it runs on any x64 or arm64 Windows box.
$platformKey = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "windows-x86_64" }
    "ARM64" { "windows-aarch64" }
    Default {
        Write-Error "lingcodebaby: unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

$platform = $manifest.platforms.$platformKey
if (-not $platform -or -not $platform.url) {
    Write-Error "lingcodebaby: manifest has no '$platformKey' entry"
    exit 1
}
$downloadUrl = $platform.url

# ── 3. Check for an existing install ───────────────────────────────────────
# NSIS (per-user installs, which is what Tauri's default nsis bundler produces)
# writes its uninstall entry under HKCU, not HKLM.
function Get-InstalledLingCodeBabyVersion {
    $uninstallRoots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($root in $uninstallRoots) {
        $hit = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like "LingCodeBaby*" } |
            Select-Object -First 1
        if ($hit) { return $hit.DisplayVersion }
    }
    return $null
}

$installedVersion = Get-InstalledLingCodeBabyVersion

function Compare-Versions([string]$a, [string]$b) {
    # Returns -1, 0, 1 for a<b, a==b, a>b. Tolerates missing/uneven segments.
    $av = ($a -split '\.') | ForEach-Object { [int]($_ -replace '\D', '') }
    $bv = ($b -split '\.') | ForEach-Object { [int]($_ -replace '\D', '') }
    for ($i = 0; $i -lt [Math]::Max($av.Count, $bv.Count); $i++) {
        $x = if ($i -lt $av.Count) { $av[$i] } else { 0 }
        $y = if ($i -lt $bv.Count) { $bv[$i] } else { 0 }
        if ($x -lt $y) { return -1 }
        if ($x -gt $y) { return 1 }
    }
    return 0
}

if ($installedVersion) {
    $cmp = Compare-Versions $installedVersion $remoteVersion
    if ($cmp -ge 0) {
        Write-Host "✓ LingCodeBaby $installedVersion is already installed (latest is $remoteVersion)."
        exit 0
    }
    Write-Host "▶ Upgrading LingCodeBaby $installedVersion -> $remoteVersion"
} else {
    Write-Host "▶ Installing LingCodeBaby $remoteVersion"
}

if ($DryRun) {
    Write-Host ""
    Write-Host "[dry run] would download: $downloadUrl"
    Write-Host "[dry run] would run installer $(if ($SilentInstall) { 'silently (/S)' } else { 'interactively' })"
    exit 0
}

# ── 4. Download + run the installer ────────────────────────────────────────
$tmpDir = Join-Path $env:TEMP ("lingcodebaby-install-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$tmpExe = Join-Path $tmpDir ([System.IO.Path]::GetFileName($downloadUrl))

try {
    Write-Host "▶ Downloading $downloadUrl"
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $tmpExe
    } finally {
        $ProgressPreference = $oldProgress
    }

    Write-Host "▶ Running installer$(if ($SilentInstall) { ' (silent /S — no SmartScreen prompt will be shown)' } else { ' — expect a SmartScreen prompt on first run: click More info -> Run anyway' })"
    if ($SilentInstall) {
        Start-Process -FilePath $tmpExe -ArgumentList "/S" -Wait
    } else {
        Start-Process -FilePath $tmpExe -Wait
    }
} finally {
    if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "✓ LingCodeBaby $remoteVersion installed."
Write-Host "  Find it in the Start Menu, or search for LingCodeBaby."
