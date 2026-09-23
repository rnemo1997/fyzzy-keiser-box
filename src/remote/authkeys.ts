// Fleet-wide SSH key sync. Pulls the centrally-managed authorized keys from the
// Fyzzy server and writes them atomically to the service-user's authorized_keys,
// ALWAYS keeping the local bootstrap key so a broken/empty response can never
// lock us out (BRIDGE-REMOTE-ACCESS-PLAN.md §5a).
//
// Runs on a timer (fyzzy-authkeys.timer) + once at boot, as root, so it can
// manage any target user's authorized_keys and chown it correctly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';
import { loadState } from '../state.js';
import { logger } from '../util/log.js';

const log = logger('authkeys');

const KEY_RE = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-(ssh-ed25519|ecdsa-sha2-\S+)@openssh\.com)\s+/;

/** Entry point for `bundle.cjs authkeys`. */
export async function syncAuthorizedKeysOnce(): Promise<void> {
  const st = loadState();
  if (!st.enroll?.enrolledAt || !st.deviceUid || !st.deviceSecret) {
    log.debug('not enrolled yet — skipping key sync');
    return;
  }

  const serverKeys = await fetchKeys(st.enroll.serverUrl, st.deviceUid, st.deviceSecret);
  if (serverKeys === null) {
    // HTTP error / malformed body → NEVER overwrite. Keep whatever is on disk.
    log.warn('key fetch failed or invalid — leaving authorized_keys untouched');
    return;
  }

  const bootstrap = readBootstrapKeys();
  const merged = dedupe([...bootstrap, ...serverKeys].filter(validKey));

  if (merged.length === 0) {
    // Should never happen (bootstrap key ships in the image), but be defensive:
    // an empty file would be a self-lockout.
    log.warn('no valid keys (bootstrap missing?) — leaving authorized_keys untouched');
    return;
  }

  writeAuthorizedKeys(config.remote.sshUser, merged);
  log.info(`synced authorized_keys for ${config.remote.sshUser}: ${bootstrap.length} bootstrap + ${serverKeys.length} fleet → ${merged.length} unique`);
}

/** GET /api/bridge/authorized-keys → string[] of key lines, or null on any failure. */
async function fetchKeys(serverUrl: string, uid: string, secret: string): Promise<string[] | null> {
  try {
    const res = await fetch(new URL('/api/bridge/authorized-keys', serverUrl).toString(), {
      headers: { 'X-Device-Uid': uid, 'X-Device-Secret': secret },
    });
    if (!res.ok) { log.warn(`authorized-keys HTTP ${res.status}`); return null; }
    const body = (await res.json()) as { keys?: unknown };
    if (!body || !Array.isArray(body.keys)) return null; // malformed → treat as invalid
    return body.keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim());
  } catch (e: any) {
    log.warn(`authorized-keys fetch error: ${e.message}`);
    return null;
  }
}

function readBootstrapKeys(): string[] {
  try {
    return fs.readFileSync(config.remote.bootstrapKeysPath, 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    log.warn(`no bootstrap key file at ${config.remote.bootstrapKeysPath} — break-glass access not guaranteed`);
    return [];
  }
}

function validKey(line: string): boolean {
  return KEY_RE.test(line.trim());
}

function dedupe(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const norm = k.trim();
    if (!seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

/** Atomically replace ~<user>/.ssh/authorized_keys with the given keys (0600, owned by the user). */
function writeAuthorizedKeys(user: string, keys: string[]): void {
  const home = homeDir(user);
  const sshDir = path.join(home, '.ssh');
  const target = path.join(sshDir, 'authorized_keys');

  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(sshDir, `.authorized_keys.${process.pid}.tmp`);
  fs.writeFileSync(tmp, keys.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target); // atomic
  chownToUser(user, sshDir, target);
}

/** Resolve the user's home dir (fall back to /home/<user>). */
function homeDir(user: string): string {
  try {
    const info = os.userInfo();
    if (info.username === user && info.homedir) return info.homedir;
  } catch { /* ignore */ }
  try {
    const pw = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).trim();
    const dir = pw.split(':')[5];
    if (dir) return dir;
  } catch { /* getent may be absent */ }
  return `/home/${user}`;
}

/** chown the .ssh dir + file to the target user (best-effort; needs root). */
function chownToUser(user: string, sshDir: string, target: string): void {
  try {
    execFileSync('chown', ['-R', `${user}:${user}`, sshDir]);
  } catch (e: any) {
    log.debug(`chown skipped (${e.message}) — fine if already running as ${user}`);
  }
  void target;
}
