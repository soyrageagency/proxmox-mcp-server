#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Proxmox MCP Server — one-command installer (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/soyrageagency/proxmox-mcp-server/main/install.sh | bash
#
# Clones the repo, installs dependencies, builds, and configures Claude Desktop.
#
# Crafted by SoyRage Agency — https://soyrage.es/
# Support: https://www.paypal.com/paypalme/soyrageagency
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="https://github.com/soyrageagency/proxmox-mcp-server.git"
DIR="${PROXMOX_MCP_DIR:-$HOME/proxmox-mcp-server}"

echo ""
echo "  Proxmox MCP Server — installer by SoyRage Agency"
echo "     https://soyrage.es/"
echo ""

command -v git  >/dev/null 2>&1 || { echo "git is required. Install it and retry."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js >= 18 is required (https://nodejs.org)."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "Node.js >= 18 required (found $(node -v))."; exit 1; fi

if [ -d "$DIR/.git" ]; then
  echo "-> Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only || true
else
  echo "-> Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
echo "-> Installing dependencies..."; npm install --silent
echo "-> Building...";               npm run build --silent
echo "-> Starting the guided setup..."
# Attach the terminal so the wizard can prompt even when piped via curl | bash.
if [ -e /dev/tty ]; then
  node scripts/install.mjs < /dev/tty
else
  node scripts/install.mjs --yes
fi
