// Advertise the bridge on the LAN so the Fyzzy app can discover it (no codes).
// The app browses for _fyzzy-bridge._tcp and reads the TXT records.
import { Bonjour } from 'bonjour-service';
import { config } from '../config.js';
import { loadState } from '../state.js';
import { logger } from '../util/log.js';

const log = logger('mdns');
let bonjour: InstanceType<typeof Bonjour> | null = null;
let advertisedKey: string | null = null;

export function advertise(): void {
  const st = loadState();
  // advertise() is called again on every heartbeat and on each state change.
  // Re-publishing the same service name over a still-live registration throws
  // "Service name is already in use on the network" (it collides with our own
  // previous advertisement). So only (re)publish when the advertised state
  // actually changed; otherwise it's a no-op.
  const key = `${st.deviceUid}|${st.lifecycle}`;
  if (bonjour && key === advertisedKey) {
    return;
  }

  // Tear down the previous advertisement before publishing the new one.
  if (bonjour) {
    try { bonjour.unpublishAll(); bonjour.destroy(); } catch { /* ignore */ }
    bonjour = null;
  }

  bonjour = new Bonjour();
  bonjour.publish({
    name: `Fyzzy Bridge ${st.deviceUid}`,
    type: config.mdnsType,          // -> _fyzzy-bridge._tcp
    port: config.provisioning.port,
    txt: {
      deviceUid: st.deviceUid,
      fw: process.env.npm_package_version || '0.1.0',
      state: st.lifecycle,          // new | provisioned | linked | running
    },
  });
  advertisedKey = key;
  log.info(`advertising _${config.mdnsType}._tcp as ${st.deviceUid} (state=${st.lifecycle})`);
}

export function stopAdvertising(): void {
  bonjour?.unpublishAll(() => bonjour?.destroy());
  bonjour = null;
  advertisedKey = null;
}
