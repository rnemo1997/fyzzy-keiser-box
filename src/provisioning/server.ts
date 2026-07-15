// Local provisioning HTTP server — the ONLY thing the Fyzzy app talks to directly,
// and only over the LAN while the box is not yet linked. Used in Phase A of
// onboarding (offline, phone on the Keiser WiFi): the app finds the box via mDNS,
// reads /info, and POSTs the practice WiFi creds to /provision. No cloud involved.
import Fastify from 'fastify';
import { config } from '../config.js';
import { loadState, saveState } from '../state.js';
import { applyPracticeWifi } from './wifi.js';
import { KeiserApolloClient } from '../hub/apolloClient.js';
import { logger } from '../util/log.js';

const log = logger('provision');

export async function startProvisioningServer(onProvisioned: () => void): Promise<() => Promise<void>> {
  const app = Fastify({ logger: false });

  // Discovery / status — safe to expose; no secrets.
  app.get('/info', async () => {
    const st = loadState();
    return { deviceUid: st.deviceUid, state: st.lifecycle, product: 'fyzzy-bridge' };
  });

  // TEMP live-source probe — hits the Hub's real-time endpoints with the box's
  // stored login, so we can see on-site whether per-rep LIVE data is available
  // (active-users / online-machines) and how fresh the export is. LAN-only.
  app.get('/debug/live', async (_req, reply) => {
    const st = loadState();
    if (!st.hub) return reply.code(400).send({ error: 'no_hub_creds' });
    const c = new KeiserApolloClient(config.hub);
    try {
      await c.login(st.hub.email, st.hub.password);
    } catch (e) {
      return reply.code(502).send({ error: 'hub_login_failed', message: (e as Error).message });
    }
    const out: Record<string, unknown> = { at: new Date().toISOString() };
    const tryCall = async (k: string, fn: () => Promise<unknown>) => {
      try { out[k] = await fn(); } catch (e) { out[k] = { error: (e as Error).message }; }
    };
    await tryCall('online_machines', () => c.raw('/api/strength-machine/online-machines'));
    await tryCall('active_users', () => c.raw('/api/strength-machine/active-users?limit=50'));
    await tryCall('machines', () => c.raw('/api/strength-machine/list?limit=50'));
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 60 * 1000);
    await tryCall('recent_export', async () => {
      const r = await c.exportWorkoutSets(from.toISOString(), to.toISOString());
      return { window: `${from.toISOString()} → ${to.toISOString()}`, count: r.reps.length, sample: r.reps.slice(-8) };
    });
    return out;
  });

  // Phase A: set the practice WiFi. Refused once the box is linked.
  app.post('/provision', async (req, reply) => {
    const st = loadState();
    if (st.lifecycle === 'linked' || st.lifecycle === 'running') {
      return reply.code(409).send({ error: 'already_linked', message: 'Box is al gekoppeld. Factory-reset om opnieuw in te stellen.' });
    }
    const { ssid, password, hubEmail, hubPassword } = (req.body ?? {}) as {
      ssid?: string; password?: string; hubEmail?: string; hubPassword?: string;
    };
    if (!ssid || !password) return reply.code(422).send({ error: 'missing', message: 'ssid en password vereist' });

    const res = await applyPracticeWifi(ssid, password);
    if (!res.ok) return reply.code(400).send({ error: 'wifi_failed', message: res.error ?? 'Kon geen verbinding maken' });

    // Keiser Hub login is per-practice — entered here during onboarding, stored
    // only on the box (never sent to the Fyzzy cloud). Test it right away.
    let hubOk: boolean | undefined;
    if (hubEmail && hubPassword) {
      try {
        await new KeiserApolloClient(config.hub).login(hubEmail, hubPassword);
        saveState({ hub: { email: hubEmail, password: hubPassword } });
        hubOk = true;
      } catch (e) {
        log.warn('hub login test failed during provision', (e as Error).message);
        hubOk = false;
      }
    }

    saveState({ lifecycle: 'provisioned', practiceWifi: { ssid } });
    log.info(`provisioned SSID="${ssid}" internet=${res.hasInternet} hubOk=${hubOk}`);
    onProvisioned();
    return { ok: true, hasInternet: res.hasInternet, hubOk, deviceUid: st.deviceUid };
  });

  await app.listen({ host: '0.0.0.0', port: config.provisioning.port });
  log.info(`provisioning server on :${config.provisioning.port}`);
  return async () => { await app.close(); };
}
