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

# WireGuard remote-access tooling (wg, wg-quick). See BRIDGE-REMOTE-ACCESS-PLAN.md.
if ! command -v wg >/dev/null; then
  echo "== install wireguard =="
  apt-get update -qq && apt-get install -y wireguard
fi

id fyzzy &>/dev/null || useradd --system --create-home --home-dir /home/fyzzy fyzzy

# The collector runs as `fyzzy` but the on-site setup portal must reboot the box
# after joining WiFi (so first-boot enroll runs cleanly with internet). Allow ONLY
# `systemctl reboot` without a password — nothing else.
SYSTEMCTL="$(command -v systemctl)"
cat > /etc/sudoers.d/fyzzy-bridge <<SUDO
fyzzy ALL=(root) NOPASSWD: $SYSTEMCTL reboot
SUDO
chmod 440 /etc/sudoers.d/fyzzy-bridge

# The setup portal starts a WiFi hotspot and joins the practice WiFi as the
# `fyzzy` user, which NetworkManager gates behind polkit. Without this rule nmcli
# fails with "Not authorized to control networking" and the AP never appears.
cat > /etc/polkit-1/rules.d/50-fyzzy-nm.rules <<'POLKIT'
// Laat de Fyzzy Bridge-service (user fyzzy) NetworkManager besturen zodat de
// on-site WiFi setup-portal een hotspot kan starten en de praktijk-WiFi kan joinen.
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
        subject.user === "fyzzy") {
        return polkit.Result.YES;
    }
});
POLKIT
chmod 644 /etc/polkit-1/rules.d/50-fyzzy-nm.rules
systemctl restart polkit 2>/dev/null || true

# The WiFi radio needs a regulatory domain before it will run as an access point
# (a fresh Pi OS reports "country 00: DFS-UNSET" and AP mode fails). Default NL;
# override for another destination with WIFI_COUNTRY=AU ./install.sh
WIFI_COUNTRY="${WIFI_COUNTRY:-NL}"
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_wifi_country "$WIFI_COUNTRY" 2>/dev/null || iw reg set "$WIFI_COUNTRY" 2>/dev/null || true
else
  iw reg set "$WIFI_COUNTRY" 2>/dev/null || true
fi

# Shared state dir — used by BOTH the (root) enroll-service and the (fyzzy)
# collector, so the enrolled identity written on first boot is readable by the
# collector's heartbeat. The enroll-service chowns it back to fyzzy afterwards.
DATA_DIR=/var/lib/fyzzy-bridge
mkdir -p "$DATA_DIR"
chown -R fyzzy:fyzzy "$DATA_DIR"

# Break-glass bootstrap SSH key(s): baked into the image, ALWAYS kept in
# authorized_keys by the fleet sync so a bad/empty response can't lock us out.
mkdir -p /etc/fyzzy
if [[ ! -f /etc/fyzzy/bootstrap_authorized_keys ]]; then
  cat > /etc/fyzzy/bootstrap_authorized_keys <<'KEYS'
# Fyzzy Bridge break-glass key(s) — one SSH public key per line.
# Vervang dit door de echte bootstrap-key vóór het bouwen van de base-image.
KEYS
  chmod 644 /etc/fyzzy/bootstrap_authorized_keys
  echo "!! Let op: /etc/fyzzy/bootstrap_authorized_keys is leeg — zet de bootstrap-key erin vóór imaging."
fi

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
# On-site WiFi setup ("captive portal"): hosted on wlan0 when there's no uplink.
SETUP_AP_SSID=Fyzzy-Bridge-Setup
SETUP_AP_PASSWORD=fyzzysetup
SETUP_IFACE=wlan0
SETUP_KEISER_IFACE=eth0
SETUP_PORTAL_PORT=80
FYZZY_CLOUD_URL=https://fyzzy.nl
FYZZY_BRIDGE_VERSION=$VERSION
# Gedeelde state-dir (root enroll-service + fyzzy collector).
FYZZY_DATA_DIR=$DATA_DIR
# SSH-user waarvan de fleet-sync authorized_keys beheert (= remote-login target).
FYZZY_SSH_USER=fyzzy
# OTA vanaf GitHub Releases (aan by default):
OTA_REPO=rnemo1997/fyzzy-keiser-box
ENV
  chmod 600 /etc/fyzzy-bridge.env
fi

echo "== systemd =="
cp "$SRC/systemd/fyzzy-bridge.service"   /etc/systemd/system/fyzzy-bridge.service
cp "$SRC/systemd/fyzzy-enroll.service"   /etc/systemd/system/fyzzy-enroll.service
cp "$SRC/systemd/fyzzy-authkeys.service" /etc/systemd/system/fyzzy-authkeys.service
cp "$SRC/systemd/fyzzy-authkeys.timer"   /etc/systemd/system/fyzzy-authkeys.timer
systemctl daemon-reload
# First-boot enroll (oneshot, runs before the collector) + periodic key sync.
systemctl enable fyzzy-enroll.service
systemctl enable --now fyzzy-authkeys.timer
systemctl enable --now fyzzy-bridge
echo "Klaar ($VERSION). Logs: journalctl -u fyzzy-bridge -f"
echo "Enroll:   journalctl -u fyzzy-enroll -f   ·   Keys: journalctl -u fyzzy-authkeys -f"
