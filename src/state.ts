// Persisted runtime identity + lifecycle state (data/state.json, mode 0600).
// Lifecycle:  new -> provisioned -> linked -> running
//   new         fresh box; no practice WiFi set; provisioning server open.
//   provisioned practice WiFi configured, box has (or is getting) internet.
//   linked      claimed by a practice in the cloud; has a device token.
//   running     linked + actively collecting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export type Lifecycle = 'new' | 'provisioned' | 'linked' | 'running';

export interface BridgeState {
  deviceUid: string;          // stable public identity (shown in the app)
  deviceSecret: string;       // private credential the box authenticates with
  lifecycle: Lifecycle;
  practiceWifi?: { ssid: string };     // creds are applied to the OS, not kept here in plaintext
  hub?: { email: string; password: string }; // TODO: encrypt at rest / move to machine-secret
  cloud?: { practiceId: number };      // set once the cloud reports we've been claimed
  lastExportTo?: string;      // ISO (UTC) watermark of the newest exported window
  lastReconcileAt?: string;   // ISO (UTC) last whole-day re-export (the slow completeness pass)
  lastRepTs?: number;         // "Completed At" (ms) of the newest rep we've ever seen — advances only on a genuinely new rep
  lastLiveLagMs?: number;     // delivery lag (now − rep "Completed At") measured the last time a NEW rep arrived
  lastLiveLagAt?: string;     // ISO (UTC) when lastLiveLagMs was measured
  windowTzFix?: boolean;      // one-time: rewound the watermark after the export-tz fix
  icuFix?: boolean;           // one-time: rewound to re-import data the ICU-broken window skipped
  resyncVersion?: number;     // bump RESYNC_VERSION in index.ts to force a one-time re-import of today
  // Remote-access enrollment (WireGuard). Written by the first-boot enroll-service
  // (src/remote/enroll.ts). Once enrolled we DON'T enroll again (idempotent).
  // Note: after a successful enroll deviceUid/deviceSecret above are overwritten
  // with the SERVER-provisioned identity, so heartbeat/ingest/authkeys all use it.
  enroll?: {
    serverUrl: string;        // Fyzzy server that owns this Bridge (from provisioning file)
    wgPubkey: string;         // our WireGuard PUBLIC key (private lives only in wg0.conf)
    wgPrivkey?: string;       // kept ONLY until wg0.conf is written, then cleared
    overlayIp?: string;       // assigned /32 overlay IP (= SSH target)
    practiceId?: number | null;
    enrolledAt?: string;      // ISO — set once the enroll POST succeeded
  };
}

const file = path.join(config.dataDir, 'state.json');

function defaults(): BridgeState {
  // Short, human-friendly device id: FYZ-XXXXXX + a long private secret.
  const id = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return {
    deviceUid: `FYZ-${id}`,
    deviceSecret: crypto.randomBytes(32).toString('hex'),
    lifecycle: 'new',
  };
}

let cache: BridgeState | null = null;

export function loadState(): BridgeState {
  if (cache) return cache;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeState;
  } catch {
    cache = defaults();
    saveState(cache);
  }
  return cache;
}

export function saveState(next: Partial<BridgeState>): BridgeState {
  const merged = { ...loadState(), ...next };
  cache = merged;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
