// Apply / test the practice WiFi on the box's uplink interface via NetworkManager
// (nmcli). The uplink interface is separate from the Keiser-WiFi interface so both
// stay up simultaneously (see FYZZY-BRIDGE-ARCHITECTURE.md §2).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../util/log.js';

const exec = promisify(execFile);
const log = logger('wifi');

// Which interface is the internet uplink (NOT the one on the Keiser WiFi).
const UPLINK_IFACE = process.env.UPLINK_IFACE || 'wlan1';

export interface WifiApplyResult { ok: boolean; hasInternet: boolean; error?: string; }

/** Connect the uplink interface to the given SSID and verify internet. */
export async function applyPracticeWifi(ssid: string, password: string): Promise<WifiApplyResult> {
  try {
    log.info(`connecting ${UPLINK_IFACE} -> "${ssid}"`);
    await exec('nmcli', ['device', 'wifi', 'connect', ssid, 'password', password, 'ifname', UPLINK_IFACE], { timeout: 45_000 });
    const hasInternet = await checkInternet();
    return { ok: true, hasInternet };
  } catch (e: any) {
    log.warn('wifi connect failed', e?.stderr || e?.message);
    return { ok: false, hasInternet: false, error: (e?.stderr || e?.message || 'connect failed').toString().trim() };
  }
}

/** Quick reachability check on the uplink (not the internet-less Keiser side). */
export async function checkInternet(): Promise<boolean> {
  try {
    await exec('ping', ['-c', '1', '-W', '3', '-I', UPLINK_IFACE, '1.1.1.1'], { timeout: 8_000 });
    return true;
  } catch { return false; }
}

/** Forget the practice WiFi (used on factory-reset). */
export async function forgetPracticeWifi(ssid: string): Promise<void> {
  try { await exec('nmcli', ['connection', 'delete', ssid], { timeout: 15_000 }); } catch { /* ignore */ }
}
