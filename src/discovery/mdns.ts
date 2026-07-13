// Advertise the bridge on the LAN so the Fyzzy app can discover it (no codes).
// The app browses for _fyzzy-bridge._tcp and reads the TXT records.
import { Bonjour } from 'bonjour-service';
import { config } from '../config.js';
import { loadState } from '../state.js';
import { logger } from '../util/log.js';

const log = logger('mdns');
let bonjour: Bonjour | null = null;

export function advertise(): void {
  const st = loadState();
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
  log.info(`advertising _${config.mdnsType}._tcp as ${st.deviceUid} (state=${st.lifecycle})`);
}

export function stopAdvertising(): void {
  bonjour?.unpublishAll(() => bonjour?.destroy());
  bonjour = null;
}
