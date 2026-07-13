#!/usr/bin/env bash
# Install Fyzzy Bridge as a systemd service on Raspberry Pi OS.
# Run with sudo. Expects Node 20+ and NetworkManager (nmcli).
# The box runs a single bundled file (dist/bundle.cjs) behind a `current`
# symlink; OTA updates just swap that symlink (see src/update/updater.ts).
set -euo pipefail

TARGET=/opt/fyzzy-bridge
SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -e "console.log(require('$SRC/package.json').version)")"

command -v node >/dev/null || { echo "Node.js 20+ vereist"; exit 1; }
command -v nmcli >/dev/null || { echo "NetworkManager (nmcli) vereist"; exit 1; }

id fyzzy &>/dev/null || useradd --system --create-home --home-dir /home/fyzzy fyzzy

echo "== build bundle ($VERSION) =="
cd "$SRC"
npm ci
npm run bundle   # -> dist/bundle.cjs (single, dependency-free file)

echo "== install to $TARGET/releases/$VERSION =="
REL="$TARGET/releases/$VERSION"
mkdir -p "$REL"
cp dist/bundle.cjs "$REL/bundle.cjs"
echo "$VERSION" > "$REL/VERSION"
ln -sfn "$REL" "$TARGET/current"
chown -R fyzzy:fyzzy "$TARGET"

echo "== env =="
if [[ ! -f /etc/fyzzy-bridge.env ]]; then
  cat > /etc/fyzzy-bridge.env <<ENV
# Fyzzy Bridge config — herstart na wijzigen: systemctl restart fyzzy-bridge
HUB_IP=192.168.150.2
HUB_PORT=8090
# Keiser-login komt normaal via de app-onboarding (per praktijk).
UPLINK_IFACE=wlan1
FYZZY_CLOUD_URL=https://fyzzy.nl
FYZZY_BRIDGE_VERSION=$VERSION
# OTA vanaf GitHub Releases (aan by default):
OTA_REPO=rnemo1997/fyzzy-keiser-box
ENV
  chmod 600 /etc/fyzzy-bridge.env
fi

echo "== systemd =="
cp "$SRC/systemd/fyzzy-bridge.service" /etc/systemd/system/fyzzy-bridge.service
systemctl daemon-reload
systemctl enable --now fyzzy-bridge
echo "Klaar ($VERSION). Logs: journalctl -u fyzzy-bridge -f"
