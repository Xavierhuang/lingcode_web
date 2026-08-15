#!/bin/sh
# Install LingCodeBaby on Linux (and inside WSL).
#
#   curl -fsSL https://lingcode.dev/install-baby.sh | sh
#
# The bash counterpart of install-baby.ps1. Everything here is done with
# curl/wget from a POSIX shell — there is no PowerShell in this path at all,
# which is the point: `... | powershell -NoProfile -Command -` cannot work in
# WSL or any other real bash, because `powershell` isn't on PATH there.
#
# What it does:
#   1. Fetches the live updater manifest at lingcode.dev/lingcodebaby/latest.json
#      (the same manifest install-baby.ps1 reads and the installed app's own
#      auto-updater polls — no separate "installer" version to keep in sync,
#      and no hardcoded vX.Y.Z to rot).
#   2. Downloads the Linux AppImage for your CPU.
#   3. Installs it per-user under ~/.local — no sudo, works on any distro:
#        ~/.local/bin/lingcodebaby                          (the AppImage)
#        ~/.local/share/applications/lingcodebaby.desktop    (app-menu entry)
#        ~/.local/share/icons/.../lingcodebaby.png           (icon, best effort)
#   4. Verifies the download against the manifest's minisign signature when
#      minisign/signify is available, and says so plainly when it isn't.
#
# Differs from install-cli.sh in one important way: LingCodeBaby is a GUI app
# (Tauri v2 + webkit2gtk), not a CLI binary. So PATH is a convenience rather
# than a requirement, but we DO have to write a .desktop entry by hand — that's
# the part NSIS does for free on Windows.
#
# Inside WSL this installs the LINUX build by default (WSL is Linux). A window
# only appears under WSLg, i.e. Windows 11. If you actually want the Windows
# app in your Start Menu:
#
#   curl -fsSL https://lingcode.dev/install-baby.sh | LINGCODEBABY_WINDOWS=1 sh
#
# ...which downloads the NSIS setup .exe with curl and hands it to WSL's binfmt
# interop. Still no PowerShell.
#
# Environment knobs (parity with install-baby.ps1):
#   LINGCODEBABY_MANIFEST_URL   override the manifest endpoint
#   LINGCODEBABY_DRYRUN=1       print what would happen, download nothing
#   LINGCODEBABY_SILENT=1       WSL+WINDOWS path only: pass /S to the installer
#   LINGCODEBABY_WINDOWS=1      WSL only: install the Windows build instead
#   LINGCODEBABY_FORCE=1        re-install even if the current version is present

set -eu

MANIFEST_URL="${LINGCODEBABY_MANIFEST_URL:-https://lingcode.dev/lingcodebaby/latest.json}"
DRYRUN="${LINGCODEBABY_DRYRUN:-0}"
SILENT="${LINGCODEBABY_SILENT:-0}"
WANT_WINDOWS="${LINGCODEBABY_WINDOWS:-0}"

# Tauri updater pubkey, same value as src-tauri/tauri.conf.json -> plugins.updater.pubkey.
# Public by design; it only lets us VERIFY signatures, never create them.
PUBKEY_B64="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg0M0M2QUE0REVEMkRBQjAKUldTdzJ0TGVwR284aEl0czZ2VkRpaTNpMWljZmVHY2F5VDdEa2t4WWs0TzRCR2QrZzZOcmU4UUQK"

die() { echo "lingcodebaby: $*" >&2; exit 1; }

# ── Fetch helper: curl or wget, whichever exists ────────────────────────────
# Same shape as install-cli.sh — plenty of minimal images ship only one.
fetch_to() { # fetch_to <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    die "need curl or wget on PATH"
  fi
}

fetch_stdout() { # fetch_stdout <url>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    die "need curl or wget on PATH"
  fi
}

# ── 1. OS gate ──────────────────────────────────────────────────────────────
OS_RAW="$(uname -s)"
case "$OS_RAW" in
  Linux) : ;;
  Darwin)
    cat >&2 <<'EOF'
lingcodebaby: on macOS, install from the DMG instead — it's a single drag:

  https://lingcode.dev/LingCodeBaby.dmg

Open it and drag LingCodeBaby.app into Applications.
EOF
    exit 0
    ;;
  MINGW*|MSYS*|CYGWIN*)
    cat >&2 <<'EOF'
lingcodebaby: Git Bash / MSYS can't install the Windows build. Use PowerShell:

  irm https://lingcode.dev/install-baby.ps1 | iex

(If you're inside WSL — that's Linux, not Windows, and this script works there.
It installs the Linux build by default; set LINGCODEBABY_WINDOWS=1 to install
the Windows build into your Start Menu instead.)
EOF
    exit 1
    ;;
  *)
    die "unsupported OS: $OS_RAW (Linux and WSL are supported; macOS uses the DMG)"
    ;;
esac

# ── 2. WSL detection ────────────────────────────────────────────────────────
IS_WSL=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || { [ -r /proc/version ] && grep -qi microsoft /proc/version; }; then
  IS_WSL=1
fi

if [ "$WANT_WINDOWS" = "1" ] && [ "$IS_WSL" != "1" ]; then
  die "LINGCODEBABY_WINDOWS=1 only works inside WSL (it needs Windows interop to run the .exe)"
fi

# ── 3. Arch -> manifest platform key ────────────────────────────────────────
# Tauri's own key convention, matching what's already in latest.json.
ARCH_RAW="$(uname -m)"
if [ "$WANT_WINDOWS" = "1" ]; then
  case "$ARCH_RAW" in
    x86_64|amd64)   PLATFORM_KEY="windows-x86_64"  ;;
    aarch64|arm64)  PLATFORM_KEY="windows-aarch64" ;;
    *) die "unsupported Windows architecture: $ARCH_RAW" ;;
  esac
else
  case "$ARCH_RAW" in
    x86_64|amd64) PLATFORM_KEY="linux-x86_64" ;;
    aarch64|arm64)
      # Not a 404-on-a-guessed-URL situation: the release workflow builds the
      # deb/rpm/AppImage bundles only on ubuntu-22.04 x64, so no arm64 Linux
      # asset exists to download. Be explicit rather than cryptic.
      die "no arm64 Linux build exists yet (only linux-x86_64 is published). Build from source: github.com/Xavierhuang/lingcodebaby_windows"
      ;;
    *) die "unsupported Linux architecture: $ARCH_RAW" ;;
  esac
fi

# ── 4. Read the manifest ────────────────────────────────────────────────────
echo "▶ Checking $MANIFEST_URL"
MANIFEST="$(fetch_stdout "$MANIFEST_URL")" || die "couldn't reach $MANIFEST_URL"
[ -n "$MANIFEST" ] || die "manifest at $MANIFEST_URL is empty"

# Reachable but not JSON (a redirect to an HTML error page, a stale nginx rule,
# someone pointing LINGCODEBABY_MANIFEST_URL at the wrong file). Catch it here
# so the user gets one clear line instead of a raw jq parse error.
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$MANIFEST" | jq -e . >/dev/null 2>&1 \
    || die "manifest at $MANIFEST_URL isn't valid JSON"
fi

# jq when present; otherwise a narrow pure-sed reader. jq is NOT installed on a
# stock Debian/Ubuntu box, so the fallback is the common case, not the exotic one.
json_field() { # json_field <platform-key> <field>
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$MANIFEST" | jq -r --arg k "$1" --arg f "$2" '.platforms[$k][$f] // empty' 2>/dev/null || true
  else
    # Flatten to one line, isolate the object that follows "<key>":, then pull
    # the first "<field>": "..." inside it.
    printf '%s' "$MANIFEST" | tr -d '\n' \
      | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p' \
      | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
  fi
}

json_version() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$MANIFEST" | jq -r '.version // empty' 2>/dev/null || true
  else
    printf '%s' "$MANIFEST" | tr -d '\n' \
      | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
  fi
}

VERSION="$(json_version)"
[ -n "$VERSION" ] || die "manifest at $MANIFEST_URL has no 'version' field"

DOWNLOAD_URL="$(json_field "$PLATFORM_KEY" url)"
[ -n "$DOWNLOAD_URL" ] || die "manifest at $MANIFEST_URL has no '$PLATFORM_KEY' entry"
case "$DOWNLOAD_URL" in
  https://*) : ;;
  *) die "manifest gave a non-https url for $PLATFORM_KEY: $DOWNLOAD_URL" ;;
esac
SIGNATURE="$(json_field "$PLATFORM_KEY" signature || true)"

# ── 5. Paths ────────────────────────────────────────────────────────────────
BIN_DIR="$HOME/.local/bin"
APP_BIN="$BIN_DIR/lingcodebaby"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/lingcodebaby.desktop"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
ICON_FILE="$ICON_DIR/lingcodebaby.png"

# Already up to date? install-baby.ps1 checks the Windows uninstall registry for
# this; on Linux the equivalent breadcrumb is the X-AppImage-Version we wrote
# into the .desktop last time. Without this, every re-run re-downloads ~110 MB.
INSTALLED_VERSION=""
if [ -f "$DESKTOP_FILE" ] && [ -x "$APP_BIN" ]; then
  INSTALLED_VERSION="$(sed -n 's/^X-AppImage-Version=//p' "$DESKTOP_FILE" 2>/dev/null | tail -1)"
fi
if [ "$WANT_WINDOWS" != "1" ] && [ "$INSTALLED_VERSION" = "$VERSION" ] && [ -n "$VERSION" ] \
   && [ "${LINGCODEBABY_FORCE:-0}" != "1" ]; then
  echo "✓ LingCodeBaby $VERSION is already installed."
  echo "  Re-install anyway with:  LINGCODEBABY_FORCE=1"
  exit 0
fi
if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" != "$VERSION" ]; then
  echo "▶ Upgrading LingCodeBaby $INSTALLED_VERSION → $VERSION"
fi

if [ "$DRYRUN" = "1" ]; then
  echo ""
  echo "[dry run] version:      $VERSION"
  [ -n "$INSTALLED_VERSION" ] && echo "[dry run] installed:    $INSTALLED_VERSION"
  echo "[dry run] platform key: $PLATFORM_KEY"
  echo "[dry run] would download: $DOWNLOAD_URL"
  if [ "$WANT_WINDOWS" = "1" ]; then
    echo "[dry run] would run the Windows installer via WSL interop$([ "$SILENT" = "1" ] && echo ' silently (/S)' || echo ' interactively')"
  else
    echo "[dry run] would install to: $APP_BIN"
    echo "[dry run] would write:      $DESKTOP_FILE"
    echo "[dry run] would write:      $ICON_FILE (best effort)"
  fi
  exit 0
fi

TMPDIR_LB="$(mktemp -d "${TMPDIR:-/tmp}/lingcodebaby-install.XXXXXX")"
trap 'rm -rf "$TMPDIR_LB"' EXIT INT TERM

# ── 6. Signature verification (opportunistic) ───────────────────────────────
# install-baby.ps1 ships the signature in the manifest and then ignores it.
# We use it when a verifier is on the box, and say so out loud when it isn't —
# these builds are not Authenticode/GPG signed, so this is the only integrity
# check available.
verify_signature() { # verify_signature <file>
  file="$1"
  if [ -z "$SIGNATURE" ]; then
    echo "⚠  manifest carries no signature for $PLATFORM_KEY — skipping verification"
    return 0
  fi
  if ! command -v minisign >/dev/null 2>&1 && ! command -v signify >/dev/null 2>&1; then
    echo "⚠  neither minisign nor signify found — skipping signature check"
    echo "   (install minisign and re-run to verify: apt install minisign)"
    return 0
  fi
  if ! command -v base64 >/dev/null 2>&1; then
    echo "⚠  no base64 on PATH — skipping signature check"
    return 0
  fi
  printf '%s' "$SIGNATURE"  | base64 -d > "$file.minisig" 2>/dev/null || {
    echo "⚠  couldn't decode the manifest signature — skipping verification"
    rm -f "$file.minisig"
    return 0
  }
  printf '%s' "$PUBKEY_B64" | base64 -d > "$TMPDIR_LB/pubkey" 2>/dev/null || {
    echo "⚠  couldn't decode the bundled pubkey — skipping verification"
    return 0
  }
  echo "▶ Verifying signature"
  if command -v minisign >/dev/null 2>&1; then
    minisign -V -p "$TMPDIR_LB/pubkey" -x "$file.minisig" -m "$file" >/dev/null 2>&1 \
      || die "signature check FAILED for $DOWNLOAD_URL — refusing to install"
  else
    signify -V -p "$TMPDIR_LB/pubkey" -x "$file.minisig" -m "$file" >/dev/null 2>&1 \
      || die "signature check FAILED for $DOWNLOAD_URL — refusing to install"
  fi
  echo "  ✓ signature ok"
}

# ── 7a. WSL -> Windows build via binfmt interop ─────────────────────────────
if [ "$WANT_WINDOWS" = "1" ]; then
  [ -d /mnt/c ] || die "/mnt/c is not mounted — can't reach the Windows filesystem from this WSL distro"
  [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ] \
    || die "WSL interop is disabled, so a .exe can't be launched from here. Enable interop, or run this in PowerShell: irm https://lingcode.dev/install-baby.ps1 | iex"

  # The .exe must sit on a /mnt/c path. NSIS installers launched from the WSL
  # ext4 filesystem (via \\wsl$) fail in confusing ways.
  WIN_TMP=""
  if command -v cmd.exe >/dev/null 2>&1; then
    WIN_USER="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n' || true)"
    if [ -n "$WIN_USER" ] && [ -d "/mnt/c/Users/$WIN_USER/AppData/Local/Temp" ]; then
      WIN_TMP="/mnt/c/Users/$WIN_USER/AppData/Local/Temp"
    fi
  fi
  [ -n "$WIN_TMP" ] && [ -w "$WIN_TMP" ] || WIN_TMP="/mnt/c/Windows/Temp"
  [ -d "$WIN_TMP" ] && [ -w "$WIN_TMP" ] \
    || die "no writable Windows temp dir found (tried AppData\\Local\\Temp and C:\\Windows\\Temp)"

  WIN_EXE="$WIN_TMP/LingCodeBaby-$VERSION-setup.exe"
  echo "▶ Downloading $DOWNLOAD_URL"
  fetch_to "$DOWNLOAD_URL" "$WIN_EXE" || die "download failed: $DOWNLOAD_URL"
  verify_signature "$WIN_EXE"

  if [ "$SILENT" = "1" ]; then
    echo "▶ Running the Windows installer silently (/S — no SmartScreen prompt shown)"
    "$WIN_EXE" /S || die "installer exited non-zero"
  else
    echo "▶ Running the Windows installer — expect a SmartScreen prompt on first run:"
    echo "  click 'More info' then 'Run anyway' (these builds aren't Authenticode-signed yet)."
    "$WIN_EXE" || die "installer exited non-zero"
  fi
  rm -f "$WIN_EXE" "$WIN_EXE.minisig"

  echo ""
  echo "✓ LingCodeBaby $VERSION installed (Windows build)."
  echo "  Find it in the Windows Start Menu, or search for LingCodeBaby."
  exit 0
fi

# ── 7b. Linux (incl. WSL by default) -> AppImage ────────────────────────────
if [ "$IS_WSL" = "1" ]; then
  echo "▶ WSL detected (${WSL_DISTRO_NAME:-unknown distro}) — installing the LINUX build,"
  echo "  since WSL is Linux. Want the Windows app in your Start Menu instead?"
  echo "    curl -fsSL https://lingcode.dev/install-baby.sh | LINGCODEBABY_WINDOWS=1 sh"
fi

echo "▶ Installing LingCodeBaby $VERSION"
echo "▶ Downloading $DOWNLOAD_URL"
APPIMAGE="$TMPDIR_LB/LingCodeBaby.AppImage"
fetch_to "$DOWNLOAD_URL" "$APPIMAGE" || die "download failed: $DOWNLOAD_URL"
chmod +x "$APPIMAGE"
verify_signature "$APPIMAGE"

mkdir -p "$BIN_DIR" "$DESKTOP_DIR" "$ICON_DIR"

if [ "$IS_WSL" = "1" ]; then
  # WebKit2GTK crashes in WSL trying DMA-BUF/EGL (no DRI3/libGLESv2).
  # Install the raw AppImage under a hidden name and write a thin wrapper
  # that sets WEBKIT_DISABLE_DMABUF_RENDERER=1 so WebKit falls back to
  # software rendering.
  REAL_APPIMAGE="$BIN_DIR/.lingcodebaby.AppImage"
  mv -f "$APPIMAGE" "$REAL_APPIMAGE"
  chmod +x "$REAL_APPIMAGE"
  cat > "$APP_BIN" <<WRAPPER
#!/bin/sh
exec env WEBKIT_DISABLE_DMABUF_RENDERER=1 "$REAL_APPIMAGE" "\$@"
WRAPPER
  chmod +x "$APP_BIN"
else
  REAL_APPIMAGE="$APP_BIN"
  mv -f "$APPIMAGE" "$REAL_APPIMAGE"
  chmod +x "$REAL_APPIMAGE"
fi
echo "▶ Installed $APP_BIN"

# Icon: best effort. --appimage-extract needs no FUSE, but it does need the
# AppImage to be runnable at all (right arch, exec bit), so it's a no-op when
# this script is exercised cross-platform. If anything here fails we still want
# a working menu entry, so never let it abort the install.
#
# linuxdeploy/Tauri put the icon in several conventional places and the exact
# basename follows productName, so search rather than hardcode: prefer the
# largest hicolor size, fall back to a root-level PNG, then to .DirIcon.
echo "▶ Writing desktop entry"
(
  cd "$TMPDIR_LB" || exit 0
  # Try the pattern form first — it avoids unpacking all ~110 MB. Pattern
  # support varies by runtime version, and a pattern that "succeeds" while
  # matching nothing is the awkward case, so fall back to a full extract
  # whenever the targeted attempt yields no PNG at all.
  root="$TMPDIR_LB/squashfs-root"
  "$REAL_APPIMAGE" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 || true
  if [ -z "$(find "$root" -name '*.png' -o -name '.DirIcon' 2>/dev/null | head -1)" ]; then
    rm -rf "$root"
    "$REAL_APPIMAGE" --appimage-extract >/dev/null 2>&1 || exit 0
  fi
  [ -d "$root" ] || exit 0
  # Candidates emitted WORST-first, because `tail -1` takes the winner:
  #   .DirIcon  <  root-level *.png  <  hicolor sizes ascending (largest last)
  SRC_ICON="$(
    { [ -f "$root/.DirIcon" ] && echo "$root/.DirIcon"
      find "$root" -maxdepth 1 -type f -name '*.png' 2>/dev/null
      find "$root/usr/share/icons" -type f -name '*.png' 2>/dev/null \
        | awk -F/ '{n=0; for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+x[0-9]+$/) {split($i,a,"x"); n=a[1]} print n"\t"$0}' \
        | sort -n -k1,1 | cut -f2-
    } | tail -1
  )"
  [ -n "$SRC_ICON" ] && [ -f "$SRC_ICON" ] && cp -f "$SRC_ICON" "$ICON_FILE" 2>/dev/null
) || true

# Icon= takes a bare name only when the file landed in the icon theme dir;
# otherwise point straight at the AppImage's own path so the entry still shows
# something rather than a broken-image placeholder.
if [ -f "$ICON_FILE" ]; then
  ICON_VALUE="lingcodebaby"
else
  ICON_VALUE="text-editor"
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=LingCodeBaby
GenericName=Code Editor
Comment=A tiny native code editor with Claude built in
Exec=$APP_BIN %F
Icon=$ICON_VALUE
Terminal=false
Categories=Development;TextEditor;IDE;
MimeType=text/plain;inode/directory;
StartupWMClass=LingCodeBaby
StartupNotify=true
X-AppImage-Version=$VERSION
EOF
chmod 644 "$DESKTOP_FILE"

# Both are nice-to-have and missing on plenty of distros.
update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo ""
echo "✓ LingCodeBaby $VERSION installed."
echo ""

# libfuse2 is the single most common reason an AppImage won't start. Ubuntu
# 22.04+ dropped it from the default install, and the resulting error
# ("dlopen(): error loading libfuse.so.2") tells the user nothing useful.
FUSE_OK=0
if command -v ldconfig >/dev/null 2>&1; then
  ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' && FUSE_OK=1
else
  # No ldconfig (Alpine, some containers) — probe the usual paths.
  for d in /lib /usr/lib /lib64 /usr/lib64 /usr/lib/x86_64-linux-gnu; do
    [ -e "$d/libfuse.so.2" ] && { FUSE_OK=1; break; }
  done
fi

if [ "$FUSE_OK" != "1" ]; then
  echo "⚠  libfuse2 isn't installed, and AppImages need it to mount themselves."
  echo "   Either install it:"
  echo ""
  echo "     sudo apt install libfuse2        # Debian / Ubuntu"
  echo "     sudo dnf install fuse-libs       # Fedora / RHEL"
  echo ""
  echo "   ...or run it without FUSE:"
  echo ""
  echo "     lingcodebaby --appimage-extract-and-run"
  echo ""
fi

if [ "$IS_WSL" = "1" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "⚠  No DISPLAY or WAYLAND_DISPLAY is set, so no window can appear."
  echo "   Linux GUI apps in WSL need WSLg (Windows 11). On Windows 10, install"
  echo "   the Windows build instead:"
  echo ""
  echo "     curl -fsSL https://lingcode.dev/install-baby.sh | LINGCODEBABY_WINDOWS=1 sh"
  echo ""
fi

echo "  Launch it from your app menu, or from a terminal:"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "    lingcodebaby"
    ;;
  *)
    echo "    $APP_BIN"
    echo ""
    echo "  ($BIN_DIR isn't on your PATH. Add it to ~/.bashrc if you want the"
    echo "   short 'lingcodebaby' command:  export PATH=\"\$HOME/.local/bin:\$PATH\")"
    ;;
esac
