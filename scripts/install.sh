#!/bin/sh
# rageprox installer (Linux / macOS) — no Node, no npm required.
#
#   curl -fsSL https://raw.githubusercontent.com/soyrageagency/proxmox-mcp-server/main/scripts/install.sh | sh
#
# Downloads the latest standalone rageprox for your OS/arch from GitHub Releases
# and installs it to ~/.local/bin. Re-run any time to update.
#
# Crafted by SoyRage Agency — https://soyrage.es/
set -eu

REPO="soyrageagency/proxmox-mcp-server"
BINDIR="${RAGEPROX_BINDIR:-$HOME/.local/bin}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux)  plat="linux" ;;
  Darwin) plat="macos" ;;
  *) echo "Unsupported OS: $os. Use the Windows installer or 'npm i -g proxmox-mcp-server'." >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) echo "Unsupported architecture: $arch." >&2; exit 1 ;;
esac
asset="rageprox-${plat}-${a}"

echo "SoyRage · installing rageprox for ${plat}/${a}…"
api="https://api.github.com/repos/${REPO}/releases/latest"
url="$(curl -fsSL "$api" | grep -o "https://[^\"]*${asset}\"" | head -n1 | tr -d '"')"
[ -n "$url" ] || { echo "Could not find asset ${asset} in the latest release." >&2; exit 1; }

mkdir -p "$BINDIR"
echo "  downloading…"
curl -fsSL "$url" -o "$BINDIR/rageprox"
chmod +x "$BINDIR/rageprox"

echo ""
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *) echo "  NOTE: add $BINDIR to your PATH:  export PATH=\"$BINDIR:\$PATH\"" ;;
esac
echo "  Done. Run:  rageprox    (preview with PROXMOX_MCP_DEMO=true)"
