// Local provisioning HTTP server — the ONLY thing the Fyzzy app talks to directly,
// and only over the LAN while the box is not yet linked. Used in Phase A of
// onboarding (offline, phone on the Keiser WiFi): the app finds the box via mDNS,
// reads /info, and POSTs the practice WiFi creds to /provision. No cloud involved.
import Fastify from 'fastify';
import { config } from '../config.js';
import { loadState, saveState } from '../state.js';
import { applyPracticeWifi } from './wifi.js';
import { logger } from '../util/log.js';

const log = logger('provision');

export async function startProvisioningServer(onProvisioned: () => void): Promise<() => Promise<void>> {
  const app = Fastify({ logger: false });

  // Discovery / status — safe to expose; no secrets.
  app.get('/info', async () => {
    const st = loadState();
    return { deviceUid: st.deviceUid, state: st.lifecycle, product: 'fyzzy-bridge' };
  });

  // Phase A: set the practice WiFi. Refused once the box is linked.
  app.post('/provision', async (req, reply) => {
    const st = loadState();
    if (st.lifecycle === 'linked' || st.lifecycle === 'running') {
      return reply.code(409).send({ error: 'already_linked', message: 'Box is al gekoppeld. Factory-reset om opnieuw in te stellen.' });
    }
    const { ssid, password } = (req.body ?? {}) as { ssid?: string; password?: string };
    if (!ssid || !password) return reply.code(422).send({ error: 'missing', message: 'ssid en password vereist' });

    const res = await applyPracticeWifi(ssid, password);
    if (!res.ok) return reply.code(400).send({ error: 'wifi_failed', message: res.error ?? 'Kon geen verbinding maken' });

    saveState({ lifecycle: 'provisioned', practiceWifi: { ssid } });
    log.info(`provisioned SSID="${ssid}" internet=${res.hasInternet}`);
    onProvisioned();
    return { ok: true, hasInternet: res.hasInternet, deviceUid: st.deviceUid };
  });

  await app.listen({ host: '0.0.0.0', port: config.provisioning.port });
  log.info(`provisioning server on :${config.provisioning.port}`);
  return async () => { await app.close(); };
}
