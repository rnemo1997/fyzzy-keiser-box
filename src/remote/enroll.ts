// First-boot enrollment. Runs once (oneshot systemd unit, Before=fyzzy-bridge),
// as root, before the collector comes up. Idempotent: on every later boot it
// sees the saved enroll-state and does nothing.
//
// Flow (BRIDGE-REMOTE-ACCESS-PLAN.md §3.1 / §6):
//   1. read /boot/.../fyzzy-provision.json (server_url, device_uid, enroll_token, ...)
//   2. set the hostname
//   3. generate a local deviceSecret + a WireGuard keypair (private key never leaves the Pi)
//   4. POST {server_url}/api/bridge/enroll  {deviceUid, enrollToken, deviceSecret, wgPubkey, fw, hostname}
//   5. write /etc/wireguard/wg0.conf from the reply, `systemctl enable --now wg-quick@wg0`
//   6. persist enroll-state AND adopt the server-provisioned identity so the
//      collector's heartbeat/ingest/authkeys use it.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { loadState, saveState } from '../state.js';
import { currentVersion } from '../update/updater.js';
import { readProvisionFile } from './provision.js';
import { generateKeypair, writeConf, bringUp } from './wg.js';
import { logger } from '../util/log.js';

const exec = promisify(execFile);
const log = logger('enroll');

interface EnrollReply {
  ok: boolean;
  practiceId?: number | null;
  wg: {
    serverPubkey: string;
    endpoint: string;
    overlayIp: string;
    serverIp: string;
    subnet: string;
    keepalive: number;
  };
}

/** Entry point for `bundle.cjs enroll`. Never throws for the "nothing to do" cases. */
export async function runEnrollOnce(): Promise<void> {
  const st = loadState();

  // Already enrolled → idempotent no-op (survives reboots + OTA).
  if (st.enroll?.enrolledAt) {
    log.info(`already enrolled (${st.deviceUid}, overlay ${st.enroll.overlayIp ?? '?'}) — skipping`);
    return;
  }

  const prov = readProvisionFile();
  if (!prov) {
    log.info('no provisioning file present — nothing to enroll (manual/dev box?)');
    return;
  }

  // Hostname first so it's in place regardless of what the enroll call does.
  if (prov.hostname) await setHostname(prov.hostname);

  // Reuse a keypair/secret across retries so a lost response doesn't strand us
  // with a consumed token: persist BEFORE the POST, send the identical request
  // next time.
  let secret = st.enroll?.wgPrivkey ? st.deviceSecret : undefined;
  let keypair = st.enroll?.wgPrivkey
    ? { privateKey: st.enroll.wgPrivkey, publicKey: st.enroll.wgPubkey }
    : null;

  if (!keypair) {
    secret = crypto.randomBytes(24).toString('hex'); // >= 16 chars, server requires min:16
    keypair = await generateKeypair();
    // Adopt the server-provisioned uid + our new secret now; store the pending WG
    // keys. If the POST fails, the next run reuses exactly these.
    saveState({
      deviceUid: prov.device_uid,
      deviceSecret: secret,
      enroll: { serverUrl: prov.server_url, wgPubkey: keypair.publicKey, wgPrivkey: keypair.privateKey },
    });
  }

  const reply = await postEnroll(prov, keypair.publicKey).catch((e) => {
    log.error(`enroll POST failed: ${e.message} — will retry on next boot/timer`);
    return null;
  });
  if (!reply || !reply.ok) return;

  // Bring up the tunnel.
  writeConf({
    privateKey: keypair.privateKey,
    overlayIp: reply.wg.overlayIp,
    serverPubkey: reply.wg.serverPubkey,
    endpoint: reply.wg.endpoint,
    allowedIps: reply.wg.subnet || `${reply.wg.serverIp}/32`, // whole overlay so office/admin peers are reachable both ways
    keepalive: reply.wg.keepalive || 25,
  });
  await bringUp().catch((e) => log.error(`wg-quick up failed: ${e.message}`));

  // Persist final state. Drop the private key from state.json — it now lives only
  // in wg0.conf (0600).
  saveState({
    deviceUid: prov.device_uid,
    deviceSecret: secret!,
    enroll: {
      serverUrl: prov.server_url,
      wgPubkey: keypair.publicKey,
      overlayIp: reply.wg.overlayIp,
      practiceId: reply.practiceId ?? null,
      enrolledAt: new Date().toISOString(),
    },
  });
  log.info(`enrolled ${prov.device_uid} → practice ${reply.practiceId ?? '?'}, overlay ${reply.wg.overlayIp}`);
}

async function postEnroll(prov: { server_url: string; device_uid: string; enroll_token: string; hostname?: string }, wgPubkey: string): Promise<EnrollReply> {
  const res = await fetch(new URL('/api/bridge/enroll', prov.server_url).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceUid: prov.device_uid,
      enrollToken: prov.enroll_token,
      deviceSecret: loadState().deviceSecret,
      wgPubkey,
      fw: currentVersion(),
      hostname: prov.hostname ?? undefined,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as EnrollReply;
}

async function setHostname(name: string): Promise<void> {
  try {
    await exec('hostnamectl', ['set-hostname', name], { timeout: 10_000 });
    log.info(`hostname set to ${name}`);
  } catch (e: any) {
    log.warn(`could not set hostname: ${e.message}`);
  }
}
