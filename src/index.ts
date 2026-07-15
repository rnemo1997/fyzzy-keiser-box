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

  // One-time: before the export-tz fix the watermark over-ran real coverage by
  // ~2h (UTC bounds read as local). Rewind once so the gap is re-exported (the
  // cloud importer dedupes, so re-sending is harmless).
  if (!st.windowTzFix && st.lastExportTo) {
    const rewound = new Date(new Date(st.lastExportTo).getTime() - 6 * 3_600_000).toISOString();
    saveState({ lastExportTo: rewound, windowTzFix: true });
    log.info(`window-tz fix: rewound watermark to ${rewound} for a one-time backfill`);
  } else if (!st.windowTzFix) {
    saveState({ windowTzFix: true });
  }

  // Force a one-time re-import of today whenever RESYNC_VERSION is bumped — used to
  // recover data that an earlier bug skipped (e.g. the token-thrash gap). Rewinds
  // the watermark to start of today; the cloud importer dedupes so it's harmless.
  const RESYNC_VERSION = 1;
  if ((st.resyncVersion ?? 0) < RESYNC_VERSION) {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const wm = st.lastExportTo ? new Date(st.lastExportTo) : null;
    if (wm && wm.getTime() > startOfToday.getTime()) {
      saveState({ lastExportTo: startOfToday.toISOString() });
      log.info(`resync v${RESYNC_VERSION}: rewound to ${startOfToday.toISOString()} to re-import today`);
    }
    saveState({ resyncVersion: RESYNC_VERSION });
  }

  advertise();
  await startProvisioningServer(() => advertise()); // re-advertise with new state
  startAutoUpdate(); // OTA: pull + apply newer bundles from GitHub Releases

  // Heartbeat + claim-discovery loop.
  setInterval(() => heartbeatTick().catch((e) => log.warn('heartbeat', e.message)), 30_000);
  heartbeatTick().catch(() => {});

  // Collector loop (only does work once linked).
  setInterval(() => collectorTick().catch((e) => log.warn('collector', e.message)), config.export.collectIntervalMs);

  // Near-instant presence loop (who is on which machine right now).
  setInterval(() => presenceTick().catch((e) => log.warn('presence', e.message)), 5_000);
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

let presenceBusy = false;
/**
 * Near-instant presence: poll the Hub's active-users per online machine and push
 * "who is on which machine right now" to the cloud. Drives the live sidebar
 * without waiting for a set to complete.
 */
async function presenceTick() {
  const st = loadState();
  if (st.lifecycle !== 'running' || presenceBusy) return;
  presenceBusy = true;
  try {
    await ensureHubLogin();
    const list = await hub.raw('/api/strength-machine/list?limit=100');
    const machines = (list.strengthMachines ?? []).filter((m: any) => (m.activeUsers ?? 0) > 0);
    const present: Array<Record<string, unknown>> = [];
    for (const m of machines) {
      try {
        const au = await hub.raw(`/api/strength-machine/active-users?strengthMachineId=${m.id}&limit=50`);
        for (const u of (au.users ?? [])) {
          present.push({
            external_id: String(u.id),
            name: [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || null,
            model_number: m.modelNumber != null ? String(m.modelNumber) : null,
            machine_name: m.name ?? null,
          });
        }
      } catch { /* skip this machine this tick */ }
    }
    await cloud.postPresence(present);
  } catch (e: any) {
    log.debug(`presence skipped: ${e.message}`);
  } finally {
    presenceBusy = false;
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

  const WINDOW_MS = 60 * 60 * 1000; // 1h windows — small enough to beat the nginx 504
  while (cursor < now) {
    const from = cursor;
    const to = new Date(Math.min(from.getTime() + WINDOW_MS, now.getTime()));
    try {
      // The Hub reads from/to as LOCAL wall-clock — send hub-local so the window
      // lines up with the real UTC instants. Watermark stays UTC.
      const { reps } = await hub.exportWorkoutSets(toHubLocal(from), toHubLocal(to));
      if (reps.length > 0) {
        enqueue('reps', { from: from.toISOString(), to: to.toISOString(), deviceUid: st.deviceUid, reps });
        log.info(`queued ${reps.length} reps for ${from.toISOString().slice(0, 10)}`);
      }
      saveState({ lastExportTo: to.toISOString() });
      cursor = new Date(to.getTime() + 1); // continue just after this window
    } catch (e: any) {
      log.warn(`export ${from.toISOString().slice(0, 10)} failed: ${e.message}`);
      break; // transient — retry next tick from the same watermark
    }
  }
}

/**
 * Format an instant as the Hub's local wall-clock — the Hub filters export by
 * local time, ignoring the offset. We compute the Europe/Amsterdam offset by
 * hand (DST-aware) instead of via Intl/toLocaleString, because the box's Node
 * build ships small-ICU: `toLocaleString(..., {timeZone})` silently returns UTC
 * there, which put the export window ~2h off and returned zero reps.
 */
function toHubLocal(d: Date): string {
  const shifted = new Date(d.getTime() + amsterdamOffsetMs(d));
  return shifted.toISOString().replace(/\.\d{3}Z$/, '.000Z'); // digits are Amsterdam wall-clock
}

/** Day-of-month of the last Sunday in a month (UTC). */
function lastSundayDom(year: number, monthZeroIdx: number): number {
  const lastDay = new Date(Date.UTC(year, monthZeroIdx + 1, 0));
  return lastDay.getUTCDate() - lastDay.getUTCDay();
}

/** Europe/Amsterdam UTC offset in ms: CEST(+2h) last-Sun-Mar 01:00 UTC → last-Sun-Oct 01:00 UTC, else CET(+1h). */
function amsterdamOffsetMs(d: Date): number {
  const y = d.getUTCFullYear();
  const dstStart = Date.UTC(y, 2, lastSundayDom(y, 2), 1);
  const dstEnd = Date.UTC(y, 9, lastSundayDom(y, 9), 1);
  const t = d.getTime();
  return (t >= dstStart && t < dstEnd ? 120 : 60) * 60_000;
}
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86_400_000); }

process.on('SIGINT', () => { stopAdvertising(); process.exit(0); });
process.on('SIGTERM', () => { stopAdvertising(); process.exit(0); });

main().catch((e) => { log.error('fatal', e.message); process.exit(1); });
