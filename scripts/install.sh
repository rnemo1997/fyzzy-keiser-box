#!/usr/bin/env bash
# Install Fyzzy Bridge as a systemd service on Raspberry Pi OS.
# Run with sudo. Expects Node 20+ and NetworkManager (nmcli).
set -euo pipefail

TARGET=/opt/fyzzy-bridge
SRC="$(cd "$(dirname "$0")/.." && pwd)"

command -v node >/dev/null || { echo "Node.js 20+ vereist"; exit 1; }
command -v nmcli >/dev/null || { echo "NetworkManager (nmcli) vereist"; exit 1; }

id fyzzy &>/dev/null || useradd --system --create-home --home-dir /home/fyzzy fyzzy

echo "== build =="
cd "$SRC"
npm ci
npm run build

echo "== install to $TARGET =="
mkdir -p "$TARGET"
cp -r dist node_modules package.json "$TARGET"/
chown -R fyzzy:fyzzy "$TARGET"

echo "== env =="
if [[ ! -f /etc/fyzzy-bridge.env ]]; then
  cat > /etc/fyzzy-bridge.env <<'ENV'
# Fyzzy Bridge config — vul in en herstart: systemctl restart fyzzy-bridge
HUB_IP=192.168.150.2
HUB_PORT=8090
# HUB_EMAIL=stacey@emfysio.nl
# HUB_PASSWORD=...
UPLINK_IFACE=wlan1
FYZZY_CLOUD_URL=https://api.fyzzy.nl
ENV
  chmod 600 /etc/fyzzy-bridge.env
  echo "  -> /etc/fyzzy-bridge.env aangemaakt (vul HUB_EMAIL/PASSWORD in)"
fi

echo "== systemd =="
cp "$SRC/systemd/fyzzy-bridge.service" /etc/systemd/system/fyzzy-bridge.service
systemctl daemon-reload
systemctl enable --now fyzzy-bridge
echo "Klaar. Logs: journalctl -u fyzzy-bridge -f"
