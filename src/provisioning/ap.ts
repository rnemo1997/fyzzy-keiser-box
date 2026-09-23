// On-site WiFi setup radio control (single-radio, wlan0 time-shares).
//
// Unlike wifi.ts (the dual-interface model where a SEPARATE uplink NIC is already
// on the practice net), this module drives the ONE WiFi radio through the on-site
// setup flow: host a temporary access point, let the customer pick their WiFi, then
// join that network as the internet uplink and keep the wired Keiser interface off
// the default route. All via NetworkManager (nmcli); nothing here touches the wired
// LAN except to mark it never-default AFTER a WiFi uplink is confirmed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const exec = promisify(execFile);
const log = logger('setup-ap');

const IFACE = config.setup.iface;         // wlan0
const KEISER_IFACE = config.setup.keiserIface; // eth0 (Keiser subnet)

export interface ScannedNetwork { ssid: string; signal: number; security: string; }
export interface ConnectResult { ok: boolean; hasInternet: boolean; error?: string; }

/** Bring up the "Fyzzy-Bridge-Setup" hotspot on the WiFi radio (NM "shared": 10.42.0.1 + DHCP). */
export async function startAp(): Promise<void> {
  // Radio may be soft-disabled on a box that has only ever used wired — enable it.
  await exec('nmcli', ['radio', 'wifi', 'on'], { timeout: 10_000 }).catch(() => {});
  // Seed a fresh scan NOW, while the radio is still free: once it hosts the AP the
  // single radio can't rescan, so /scan can only serve this cached result.
  await exec('nmcli', ['dev', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'yes'], { timeout: 20_000 }).catch(() => {});
  log.info(`starting AP "${config.setup.apSsid}" on ${IFACE}`);
  await exec('nmcli', [
    'dev', 'wifi', 'hotspot',
    'ifname', IFACE,
    'ssid', config.setup.apSsid,
    'password', config.setup.apPassword,
  ], { timeout: 30_000 });
}

/** Tear the hotspot down and return the radio to idle. Safe to call when it's already down. */
export async function stopAp(): Promise<void> {
  // NM names the hotspot connection "Hotspot"; bring it down then drop the profile
  // so the radio is fully idle. Ignore errors (already down / never started).
  await exec('nmcli', ['con', 'down', 'Hotspot'], { timeout: 15_000 }).catch(() => {});
  await exec('nmcli', ['con', 'delete', 'Hotspot'], { timeout: 15_000 }).catch(() => {});
  log.info('AP stopped');
}

/**
 * Nearby networks as the setup page's picker sees them. Uses NM's last scan
 * (a fresh rescan is impossible while the same radio hosts the AP), deduped by
 * SSID keeping the strongest signal, sorted by signal desc, empty SSIDs dropped.
 */
export async function scanWifi(): Promise<ScannedNetwork[]> {
  const { stdout } = await exec('nmcli', [
    '-t', '-f', 'SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', 'ifname', IFACE,
  ], { timeout: 20_000 });
  const best = new Map<string, ScannedNetwork>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // Terse output is colon-separated; NM escapes literal colons in a field as "\:".
    const parts = line.split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ':'));
    const ssid = (parts[0] ?? '').trim();
    if (!ssid) continue; // hidden / unnamed network
    if (ssid === config.setup.apSsid) continue; // our own setup AP — don't offer it
    const signal = Number(parts[1] ?? 0) || 0;
    const security = (parts[2] ?? '').trim() || 'open';
    const prev = best.get(ssid);
    if (!prev || signal > prev.signal) best.set(ssid, { ssid, signal, security });
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

/**
 * Join the chosen practice WiFi on the setup radio and confirm real internet.
 * `nmcli dev wifi connect` tears the hotspot down as it activates the client
 * connection. Only AFTER internet is confirmed do we adjust routing so the wired
 * Keiser interface stays off the default route. A bad password / unreachable AP
 * fails at the connect step and never touches the wired interface.
 */
export async function connectWifi(ssid: string, password: string): Promise<ConnectResult> {
  try {
    log.info(`joining "${ssid}" on ${IFACE}`);
    await exec('nmcli', [
      'dev', 'wifi', 'connect', ssid, 'password', password, 'ifname', IFACE,
    ], { timeout: 45_000 });
  } catch (e: any) {
    const err = (e?.stderr || e?.message || 'connect failed').toString().trim();
    log.warn(`join failed: ${err}`);
    return { ok: false, hasInternet: false, error: err };
  }

  // Joined the AP — now check we actually reach the internet through it.
  const hasInternet = await ifaceHasInternet(IFACE);
  if (!hasInternet) {
    log.warn(`joined "${ssid}" but no internet via ${IFACE}`);
    return { ok: true, hasInternet: false, error: 'no_internet' };
  }

  // Internet confirmed via WiFi → make the routing durable: keep the wired Keiser
  // interface off the default route, prefer wlan0 for internet.
  await applyDualInterfaceRouting().catch((e) => log.warn(`routing tweak failed: ${e.message}`));
  return { ok: true, hasInternet: true };
}

/**
 * Internet goes via the WiFi uplink; the wired interface only reaches the Keiser
 * subnet. Mark eth0 never-default with a high metric and give wlan0 a low metric,
 * then `device reapply` (graceful — does NOT drop the link) so we never risk the
 * admin's connectivity. No-op-safe if a connection can't be resolved.
 */
export async function applyDualInterfaceRouting(): Promise<void> {
  const keiserCon = await activeConnName(KEISER_IFACE);
  const wifiCon = await activeConnName(IFACE);
  if (keiserCon) {
    await exec('nmcli', ['con', 'mod', keiserCon, 'ipv4.never-default', 'yes', 'ipv4.route-metric', '500'], { timeout: 15_000 });
    await exec('nmcli', ['device', 'reapply', KEISER_IFACE], { timeout: 15_000 }).catch(() => {});
    log.info(`${KEISER_IFACE} ("${keiserCon}") set never-default metric 500`);
  }
  if (wifiCon) {
    await exec('nmcli', ['con', 'mod', wifiCon, 'ipv4.route-metric', '100'], { timeout: 15_000 });
    await exec('nmcli', ['device', 'reapply', IFACE], { timeout: 15_000 }).catch(() => {});
    log.info(`${IFACE} ("${wifiCon}") set metric 100 (preferred default route)`);
  }
}

/** Does the box reach the internet at all (any interface)? Decides whether to open the portal. */
export async function hasUplink(): Promise<boolean> {
  return curlOk([]);
}

/**
 * Reboot the box. Called ONLY after the setup portal has confirmed a real internet
 * uplink: the first-boot `fyzzy-enroll.service` failed earlier (no internet then) and
 * never retries, so a clean reboot lets it run with internet — enrolling + bringing up
 * WireGuard. On the reboot the uplink is present, so the portal is skipped.
 */
export async function reboot(): Promise<void> {
  log.info('rebooting so first-boot enroll runs cleanly now internet is up');
  await exec('sudo', ['systemctl', 'reboot'], { timeout: 10_000 })
    .catch((e) => log.warn(`reboot failed: ${e?.stderr || e?.message}`));
}

/** Does a SPECIFIC interface reach the internet? Used to know when wlan0 got a real uplink. */
export async function ifaceHasInternet(iface: string): Promise<boolean> {
  return curlOk(['--interface', iface]);
}

/** Name of the active NM connection bound to a device, or null. */
async function activeConnName(iface: string): Promise<string | null> {
  try {
    const { stdout } = await exec('nmcli', ['-t', '-f', 'NAME,DEVICE', 'con', 'show', '--active'], { timeout: 10_000 });
    for (const line of stdout.split('\n')) {
      const idx = line.lastIndexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).replace(/\\:/g, ':');
      const dev = line.slice(idx + 1).trim();
      if (dev === iface) return name;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * A tiny connectivity probe via curl (present on Raspberry Pi OS). Hits the standard
 * generate_204 endpoint; a 2xx/204 means real internet. `extra` can bind an interface.
 */
async function curlOk(extra: string[]): Promise<boolean> {
  try {
    const { stdout } = await exec('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '6', ...extra,
      'http://connectivitycheck.gstatic.com/generate_204',
    ], { timeout: 9_000 });
    const code = Number(stdout.trim());
    return code >= 200 && code < 400;
  } catch { return false; }
}
