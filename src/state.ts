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
  windowTzFix?: boolean;      // one-time: rewound the watermark after the export-tz fix
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
