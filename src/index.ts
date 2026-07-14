// Fyzzy Bridge orchestrator.
// Lifecycle: new --(provision WiFi)--> provisioned --(cloud claim)--> running.
// While running it collects Keiser data (daily export now; live later) and
// forwards it to the cloud via the durable outbox.
import { config } from './config.js';
import { loadState, saveState } from './state.js';
import { advertise, stopAdvertising } from './discovery/mdns.js';
import { startProvisioningServer } from './provisioning/server.js';
import { CloudLink } from './cloud/link.js';
import { KeiserApolloClient } from './hub/apolloClient.js';
import { enqueue } from './buffer/db.js';
import { startAutoUpdate, checkAndUpdate } from './update/updater.js';
import { logger } from './util/log.js';

const log = logger('main');
const cloud = new CloudLink();
const hub = new KeiserApolloClient(config.hub);
let collecting = false;

async function main() {
  const st = loadState();
  log.info(`Fyzzy Bridge ${st.deviceUid} starting (state=${st.lifecycle})`);

  advertise();
  await startProvisioningServer(() => advertise()); // re-advertise with new state
  startAutoUpdate(); // OTA: pull + apply newer bundles from GitHub Releases

  // Heartbeat + claim-discovery loop.
  setInterval(() => heartbeatTick().catch((e) => log.warn('heartbeat', e.message)), 30_000);
  heartbeatTick().catch(() => {});

  // Collector loop (only does work once linked).
  setInterval(() => collectorTick().catch((e) => log.warn('collector', e.message)), config.export.collectIntervalMs);
}

async function heartbeatTick() {
  const st = loadState();
  const hubReachable = await hub.keepAlive().then(() => true).catch(() => false);
  try {
    const reply = await cloud.heartbeat(hubReachable);
    if (reply.claimed && loadState().lifecycle === 'running') advertise(); // reflect state in mDNS
    if (reply.sync) {
      // Web asked for a catch-up sync: rewind the export watermark so the next
      // collector run re-exports [from .. now], then kick it off immediately.
      log.info(`sync command received — re-export from ${reply.sync.from}`);
      saveState({ lastExportTo: reply.sync.from });
      collectorTick().catch((e) => log.warn('collector', e.message));
    }
    if (reply.checkUpdate) {
      log.info('update check requested from cloud');
      checkAndUpdate().catch((e) => log.warn('ota', e.message)); // restarts if a newer release exists
    }
  } catch (e) {
    // Offline (e.g. still on Keiser WiFi during Phase A) — that's expected.
    log.debug('heartbeat skipped (offline?)');
  }
}

async function collectorTick() {
  const st = loadState();
  if (st.lifecycle !== 'running' || collecting) return;
  collecting = true;
  try {
    await ensureHubLogin();
    await runBackfillAndReconcile();
    await cloud.flushOutbox();
  } finally {
    collecting = false;
  }
}

async function ensureHubLogin() {
  if (hub.currentToken) return;
  const st = loadState();
  const email = st.hub?.email || process.env.HUB_EMAIL;
  const password = st.hub?.password || process.env.HUB_PASSWORD;
  if (!email || !password) throw new Error('no Keiser hub credentials configured');
  await hub.login(email, password);
}

/**
 * Export in small per-day windows from the watermark to now (beats the nginx 504),
 * enqueue the reps for upload, and advance the watermark.
 */
async function runBackfillAndReconcile() {
  const st = loadState();
  const now = new Date();
  // Walk from the EXACT watermark (not the start of its day) to now, in per-day
  // windows. Starting at the day boundary would re-export the whole current day
  // every tick — a flood of already-imported reps. The cursor advances just past
  // each window so we only ever fetch new reps.
  let cursor = st.lastExportTo
    ? new Date(st.lastExportTo)
    : new Date(now.getTime() - config.export.backfillDays * 86_400_000);

  while (cursor < now) {
    const from = cursor;
    const dayEnd = new Date(startOfUtcDay(cursor).getTime() + 86_400_000 - 1); // 23:59:59.999 UTC
    const to = new Date(Math.min(dayEnd.getTime(), now.getTime()));
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    try {
      const { reps } = await hub.exportWorkoutSets(fromIso, toIso);
      if (reps.length > 0) {
        enqueue('reps', { from: fromIso, to: toIso, deviceUid: st.deviceUid, reps });
        log.info(`queued ${reps.length} reps for ${fromIso.slice(0, 10)}`);
      }
      saveState({ lastExportTo: toIso });
      cursor = new Date(to.getTime() + 1); // continue just after this window
    } catch (e: any) {
      log.warn(`export ${fromIso.slice(0, 10)} failed: ${e.message}`);
      break; // transient — retry next tick from the same watermark
    }
  }
}

function startOfUtcDay(d: Date): Date { const c = new Date(d); c.setUTCHours(0, 0, 0, 0); return c; }
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86_400_000); }

process.on('SIGINT', () => { stopAdvertising(); process.exit(0); });
process.on('SIGTERM', () => { stopAdvertising(); process.exit(0); });

main().catch((e) => { log.error('fatal', e.message); process.exit(1); });
