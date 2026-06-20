#!/bin/sh
# Install the standalone `lingcode` CLI.
#
#   curl -fsSL https://lingcode.dev/install-cli.sh | sh
#
# Three install paths, one script:
#   - macOS:   downloads the Swift tarball (bundles Node, integrates with
#              LingCode.app on the same machine via Unix-socket IPC).
#   - Linux:   downloads the v0.9.x Bun-compiled CLI (single static binary,
#              opencode-fork architecture; no LingCode.app integration —
#              Linux is CLI-only).
#   - Windows: prints a redirect to install-cli.ps1 (PowerShell installer).

set -eu

# Version pin for the Linux/Windows TS CLI. Bump this when promoting an
# RC to stable. Mac path is unaffected — Mac uses the unversioned
# `lingcode-cli-latest-*` Swift symlink.
LINGCODE_TS_VERSION="${LINGCODE_TS_VERSION:-v0.9.0-rc17}"

OS_RAW="$(uname -s)"
case "$OS_RAW" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  MINGW*|MSYS*|CYGWIN*)
    cat >&2 <<EOF
lingcode: Windows install requires PowerShell, not bash.

Open PowerShell and run:

  iwr -useb https://lingcode.dev/install-cli.ps1 | iex

(If you're inside WSL — that's Linux, not Windows. This script will
install the Linux binary; you can use it from WSL or from native Linux
the same way.)
EOF
    exit 1
    ;;
  *)
    echo "lingcode: unsupported OS: $OS_RAW (macOS, Linux, and Windows are supported)" >&2
    exit 1
    ;;
esac

ARCH_RAW="$(uname -m)"
case "$OS:$ARCH_RAW" in
  darwin:arm64|darwin:aarch64) ARCH="arm64"   ;;
  darwin:x86_64|darwin:amd64)  ARCH="x86_64"  ;;
  linux:x86_64|linux:amd64)    ARCH="x64"     ;;
  linux:aarch64|linux:arm64)   ARCH="arm64"   ;;
  *)
    echo "lingcode: unsupported $OS architecture: $ARCH_RAW" >&2
    exit 1
    ;;
esac

# Detect Alpine / musl so we pick the right Linux binary.
LINUX_LIBC=""
if [ "$OS" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    LINUX_LIBC="-musl"
  fi
fi

INSTALL_ROOT="$HOME/.lingcode/cli"
BIN_DIR="$HOME/.local/bin"
SYMLINK="$BIN_DIR/lingcode"
TMPDIR="$(mktemp -d -t lingcode-install.XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$OS" = "darwin" ]; then
  # Mac path: existing Swift tarball flow, unchanged.
  TARBALL_URL="${LINGCODE_TARBALL_URL:-https://lingcode.dev/lingcode-cli-latest-${OS}-${ARCH}.tar.gz}"
  ARCHIVE_EXT="tar.gz"
else
  # Linux path: new TS/Bun-compiled .zip from the v0.9.x stream.
  TARBALL_URL="${LINGCODE_TARBALL_URL:-https://lingcode.dev/lingcode-${OS}-${ARCH}${LINUX_LIBC}-${LINGCODE_TS_VERSION}.zip}"
  ARCHIVE_EXT="zip"
fi

echo "▶ Downloading $TARBALL_URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$TARBALL_URL" -o "$TMPDIR/lingcode.$ARCHIVE_EXT"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$TARBALL_URL" -O "$TMPDIR/lingcode.$ARCHIVE_EXT"
else
  echo "lingcode: need curl or wget on PATH" >&2
  exit 1
fi

echo "▶ Extracting to $INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT"
rm -rf "$INSTALL_ROOT"/*
if [ "$ARCHIVE_EXT" = "zip" ]; then
  if ! command -v unzip >/dev/null 2>&1; then
    echo "lingcode: need unzip on PATH for Linux install" >&2
    exit 1
  fi
  unzip -q "$TMPDIR/lingcode.$ARCHIVE_EXT" -d "$TMPDIR"
  # Linux zip layout: lingcode-linux-x64/bin/lingcode (Bun --compile output)
  SRC_DIR="$(find "$TMPDIR" -maxdepth 2 -type d -name 'lingcode-*' | head -1)"
  if [ -z "$SRC_DIR" ] || [ ! -x "$SRC_DIR/bin/lingcode" ]; then
    echo "lingcode: unexpected archive layout in $TARBALL_URL" >&2
    exit 1
  fi
  cp -R "$SRC_DIR/." "$INSTALL_ROOT/"
  # Bun --compile outputs put the binary at bin/lingcode. Symlink the top-level
  # path so the final ~/.local/bin/lingcode symlink resolves cleanly.
  ln -sf "$INSTALL_ROOT/bin/lingcode" "$INSTALL_ROOT/lingcode"
else
  tar -xzf "$TMPDIR/lingcode.$ARCHIVE_EXT" -C "$TMPDIR"
  # Mac tarball layout: lingcode/{lingcode, LingCodeCLI_lingcode.bundle/}
  cp -R "$TMPDIR/lingcode/." "$INSTALL_ROOT/"
fi

# Strip the quarantine xattr macOS adds when curl downloads a file. Without
# this, every invocation hits Gatekeeper's online check and may fail offline.
# Linux has no equivalent — silently skipped via `command -v xattr`.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$INSTALL_ROOT" 2>/dev/null || true
fi

echo "▶ Linking $SYMLINK"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_ROOT/lingcode" "$SYMLINK"

echo ""
echo "✓ Installed lingcode."
echo ""
"$SYMLINK" --version || true

# PATH check.
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo ""
    echo "  Try it:  lingcode ask 'what is in this directory?'"
    ;;
  *)
    echo ""
    echo "⚠  $BIN_DIR is not on your PATH."
    echo "   Add this line to your shell rc (~/.zshrc or ~/.bashrc):"
    echo ""
    echo "     export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "   Then open a new terminal and try:"
    echo "     lingcode ask 'what is in this directory?'"
    ;;
esac
