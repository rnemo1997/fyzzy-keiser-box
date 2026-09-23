// WireGuard glue for the remote-access tunnel. Thin wrappers around the
// `wg`/`wg-quick`/`systemctl` tooling (installed by scripts/install.sh via
// `apt install wireguard`). All logic that needs a decision lives in the callers
// (enroll.ts); this file just shells out, mirroring how provisioning/wifi.ts
// drives nmcli.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const exec = promisify(execFile);
const log = logger('wg');

export interface WgKeypair { privateKey: string; publicKey: string; }

/** Run a command, feeding `stdin` in, and resolve its trimmed stdout. */
function pipe(cmd: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
    child.stdin.end(stdin);
  });
}

/** Generate a fresh X25519 keypair with `wg genkey | wg pubkey`. Base64, 44 chars. */
export async function generateKeypair(): Promise<WgKeypair> {
  const { stdout: priv } = await exec('wg', ['genkey']);
  const privateKey = priv.trim();
  const publicKey = await pipe('wg', ['pubkey'], privateKey); // wg pubkey reads the private key on stdin
  return { privateKey, publicKey };
}

export interface WgConfInput {
  privateKey: string;
  overlayIp: string;   // e.g. 10.100.0.23
  serverPubkey: string;
  endpoint: string;    // host:port
  allowedIps: string;  // usually the whole overlay subnet
  keepalive: number;   // seconds
}

/** Write /etc/wireguard/wg0.conf atomically (0600). */
export function writeConf(input: WgConfInput): void {
  const ip = input.overlayIp.includes('/') ? input.overlayIp : `${input.overlayIp}/32`;
  const conf = [
    '# Managed by Fyzzy Bridge enroll-service — do not edit by hand.',
    '[Interface]',
    `PrivateKey = ${input.privateKey}`,
    `Address = ${ip}`,
    '',
    '[Peer]',
    `PublicKey = ${input.serverPubkey}`,
    `Endpoint = ${input.endpoint}`,
    `AllowedIPs = ${input.allowedIps}`,
    `PersistentKeepalive = ${input.keepalive}`,
    '',
  ].join('\n');

  const dir = path.dirname(config.remote.wgConfPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${config.remote.wgConfPath}.tmp`;
  fs.writeFileSync(tmp, conf, { mode: 0o600 });
  fs.renameSync(tmp, config.remote.wgConfPath); // atomic replace
  log.info(`wrote ${config.remote.wgConfPath} (overlay ${ip})`);
}

/** `systemctl enable --now wg-quick@wg0` — bring the tunnel up + persist across reboots. */
export async function bringUp(): Promise<void> {
  const unit = `wg-quick@${config.remote.wgInterface}`;
  await exec('systemctl', ['enable', '--now', unit], { timeout: 30_000 });
  log.info(`${unit} enabled + started`);
}

/**
 * Seconds since the last WireGuard handshake with the hub, or null if we can't
 * tell (interface not up, no peer, never handshook). Second liveness signal
 * shipped on the heartbeat. Reads `wg show <iface> latest-handshakes`, whose
 * value is a UNIX epoch (0 = never).
 */
export async function handshakeAgeSec(): Promise<number | null> {
  try {
    const { stdout } = await exec('wg', ['show', config.remote.wgInterface, 'latest-handshakes'], { timeout: 5_000 });
    // Lines: "<pubkey>\t<epoch-seconds>". Take the freshest peer.
    let newest = 0;
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const ts = Number(parts[1]);
      if (Number.isFinite(ts) && ts > newest) newest = ts;
    }
    if (newest <= 0) return null; // never handshook yet
    return Math.max(0, Math.floor(Date.now() / 1000) - newest);
  } catch {
    return null; // wg not installed / iface down / not enrolled
  }
}
