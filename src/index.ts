// Fyzzy Bridge orchestrator.
// Lifecycle: new --(provision WiFi)--> provisioned --(cloud claim)--> running.
// While running it collects Keiser data (daily export now; live later) and
// forwards it to the cloud via the durable outbox.
import crypto from 'node:crypto';
import { config } from './config.js';
import { loadState, saveState } from './state.js';
import { advertise, stopAdvertising } from './discovery/mdns.js';
import { startProvisioningServer } from './provisioning/server.js';
import { CloudLink } from './cloud/link.js';
import { KeiserApolloClient } from './hub/apolloClient.js';
import { enqueue } from './buffer/db.js';
import { startAutoUpdate, checkAndUpdate } from './update/updater.js';
import { runEnrollOnce } from './remote/enroll.js';
import { syncAuthorizedKeysOnce } from './remote/authkeys.js';
import { maybeRunSetupPortal, runSetupPortalStandalone, startSetupPortal, type PortalHandle } from './provisioning/portal.js';
import { reboot } from './provisioning/ap.js';
import { logger } from './util/log.js';

const log = logger('main');

// Sub-commands share the single OTA-updatable bundle. systemd's oneshot enroll
// unit and the authorized_keys timer invoke `bundle.cjs enroll` / `authkeys`;
// no arg runs the collector orchestrator.
const subcommand = process.argv[2];
if (subcommand === 'enroll') {
  runEnrollOnce().then(() => process.exit(0)).catch((e) => { log.error('enroll fatal', e.message); process.exit(1); });
} else if (subcommand === 'authkeys') {
  syncAuthorizedKeysOnce().then(() => process.exit(0)).catch((e) => { log.error('authkeys fatal', e.message); process.exit(1); });
} else if (subcommand === 'setup-portal') {
  // On-site WiFi setup AP + portal, unconditionally (manual re-config / testing).
  runSetupPortalStandalone().catch((e) => { log.error('setup-portal fatal', e.message); process.exit(1); });
} else {
  main().catch((e) => { log.error('fatal', e.message); process.exit(1); });
}
const cloud = new CloudLink();
const hub = new KeiserApolloClient(config.hub);
let collecting = false;

// Self-heal watchdog: last time we successfully reached the Fyzzy cloud, and the
// recovery AP we open when that goes stale (so a box on a bad WiFi can be fixed
// on-site without SSH/console).
let lastCloudOkAt = Date.now();
let recoveryPortal: PortalHandle | null = null;

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

  // Force a one-time re-import whenever RESYNC_VERSION is bumped — recovers data an
  // earlier bug skipped. v3 rewinds several DAYS (not just today) so the backfill
  // re-walks them and recovers the Functional Trainer's late-batch reps that the
  // bounded reconcile silently lost since 642dee1 (24 sep → the ~28 sep gap). The
  // Hub keeps ~2 weeks and the cloud importer dedupes, so re-importing is harmless.
  // v4: the export window was computed in hardcoded Europe/Amsterdam wall-clock,
  // so a non-EU practice (A1 Function, Australia/Sydney) had its sessions fall
  // outside the queried window and never exported. Now the window follows the
  // box's SYSTEM timezone. Rewind a few days so the mis-windowed sessions
  // re-export under the corrected zone (the cloud importer dedupes).
  // v5: the export window now follows the cloud-provided practice tz offset
  // instead of the Pi's OS timezone. Rewind so anything mis-windowed by a wrong
  // Pi tz re-exports under the corrected offset (the cloud importer dedupes).
  const RESYNC_VERSION = 5;
  if ((st.resyncVersion ?? 0) < RESYNC_VERSION) {
    const rewindTo = new Date();
    rewindTo.setUTCHours(0, 0, 0, 0);
    rewindTo.setUTCDate(rewindTo.getUTCDate() - 5); // cover recently mis-windowed sessions
    const wm = st.lastExportTo ? new Date(st.lastExportTo) : null;
    if (! wm || wm.getTime() > rewindTo.getTime()) {
      saveState({ lastExportTo: rewindTo.toISOString() });
      log.info(`resync v${RESYNC_VERSION}: rewound to ${rewindTo.toISOString()} to recover the Functional Trainer gap`);
    }
    saveState({ resyncVersion: RESYNC_VERSION });
  }

  advertise();
  await startProvisioningServer(() => advertise()); // re-advertise with new state
  startAutoUpdate(); // OTA: pull + apply newer bundles from GitHub Releases

  // On-site WiFi setup: if there's no internet uplink after a short grace period,
  // host the "Fyzzy-Bridge-Setup" AP + portal so the customer can pick their WiFi.
  // No-op when an uplink is already present (saved WiFi). Runs in the background.
  maybeRunSetupPortal().catch((e) => log.warn('setup-portal', e.message));

  // Heartbeat + claim-discovery loop.
  setInterval(() => heartbeatTick().catch((e) => log.warn('heartbeat', e.message)), 30_000);
  heartbeatTick().catch(() => {});

  // Collector loop (only does work once linked).
  setInterval(() => collectorTick().catch((e) => log.warn('collector', e.message)), config.export.collectIntervalMs);

  // Near-instant presence loop (who is on which machine right now).
  setInterval(() => presenceTick().catch((e) => log.warn('presence', e.message)), 5_000);

  // Ensure a Fyzzy support admin exists on the Hub (idempotent, once) — always-on
  // support access via the collector's OWN authenticated session, so it works even
  // when the practice's own Keiser login is unavailable (Nemo 29-09). Retries on a
  // slow interval if the first attempt can't reach the Hub yet.
  setTimeout(() => ensureSupportAccount().catch((e) => log.warn('support-account', e.message)), 90_000);
  setInterval(() => ensureSupportAccount().catch((e) => log.debug('support-account', e.message)), 6 * 3_600_000);
}

// The always-present Fyzzy support login. One per Hub; created once and then
// left alone (we adopt a pre-existing one rather than duplicate).
const SUPPORT_EMAIL = 'fyzzy-svc@fyzzy.nl';

async function ensureSupportAccount(): Promise<void> {
  const st = loadState();
  if (st.lifecycle !== 'running') return;          // needs a linked, collecting box
  if (st.support?.userId) return;                  // already ensured — idempotent
  await ensureHubLogin();                           // uses the collector's own session

  // Adopt a pre-existing account instead of creating a duplicate.
  const users = await hub.listUsers(500).catch(() => [] as any[]);
  const existing = users.find((u: any) => u?.emailAddress?.email === SUPPORT_EMAIL);
  if (existing?.id) {
    saveState({ support: { email: SUPPORT_EMAIL, userId: existing.id, createdAt: new Date().toISOString(), note: 'existed' } });
    log.info(`support account already present on Hub (userId=${existing.id})`);
    return;
  }

  const password = 'Fyzzy-' + crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + '!9';
  const pin = String(1000 + crypto.randomInt(9000));
  const res = await hub.createUser({
    accountType: 'admin', email: SUPPORT_EMAIL, firstName: 'Fyzzy', lastName: 'Support', pin, password,
  });
  const userId = res?.user?.id ?? null;
  saveState({ support: { email: SUPPORT_EMAIL, userId, password, pin, createdAt: new Date().toISOString() } });
  log.info(`support account created on Hub (userId=${userId})`);
}

/**
 * Run a cloud-queued command against the Keiser Hub — ALWAYS via the Fyzzy
 * support account (state.support), never the practice/collector login, so we
 * never invalidate their token or lock anyone out (the Hub drops a token when
 * the same account logs in elsewhere). Reports the outcome back per command.
 */
async function runBridgeCommand(cmd: { id: number; type: string; payload: any }): Promise<void> {
  const KNOWN = ['create_keiser_user', 'set_keiser_user_pin'];
  if (! KNOWN.includes(cmd.type)) {
    await cloud.postCommandResult(cmd.id, false, undefined, `unknown command type: ${cmd.type}`).catch(() => {});
    return;
  }
  const support = loadState().support;
  if (!support?.email || !support?.password) {
    await cloud.postCommandResult(cmd.id, false, undefined, 'no Fyzzy support account on this Hub yet').catch(() => {});
    return;
  }
  try {
    const svc = new KeiserApolloClient(config.hub); // separate session as fyzzy-svc
    await svc.login(support.email, support.password);
    const p = cmd.payload || {};

    if (cmd.type === 'set_keiser_user_pin') {
      if (! p.userId) throw new Error('set_keiser_user_pin: missing userId');
      if (! p.pin) throw new Error('set_keiser_user_pin: missing pin');
      await svc.setUserPin(String(p.userId), String(p.pin));
      await cloud.postCommandResult(cmd.id, true, { userId: p.userId }).catch(() => {});
      log.info(`command ${cmd.id}: updated PIN for Hub user ${p.userId} (client ${p.clientId ?? '?'})`);
      return;
    }

    // create_keiser_user
    const res = await svc.createUser({
      accountType: 'user', // 'user' = member (the Hub rejects 'member')
      email: String(p.email),
      firstName: String(p.firstName || ''),
      lastName: String(p.lastName || ''),
      pin: String(p.pin),
    });
    const hubUserId = res?.user?.id ?? null;
    await cloud.postCommandResult(cmd.id, true, { hubUserId }).catch(() => {});
    log.info(`command ${cmd.id}: created Hub user ${hubUserId} for client ${p.clientId}`);
  } catch (e: any) {
    await cloud.postCommandResult(cmd.id, false, undefined, (e?.message ?? 'error').slice(0, 480)).catch(() => {});
    log.warn(`command ${cmd.id} failed`, e?.message);
  }
}

async function heartbeatTick() {
  const st = loadState();
  const hubReachable = await hub.keepAlive().then(() => true).catch(() => false);
  try {
    const reply = await cloud.heartbeat(hubReachable);
    // Cloud reachable → reset the self-heal timer. If a recovery AP was up (e.g.
    // the box got back online via ethernet), drop it now.
    lastCloudOkAt = Date.now();
    if (recoveryPortal) {
      log.info('cloud reachable again — closing recovery WiFi portal');
      recoveryPortal.stop().catch(() => {});
      recoveryPortal = null;
    }
    if (reply.claimed && loadState().lifecycle === 'running') advertise(); // reflect state in mDNS
    if (typeof reply.tzOffsetMinutes === 'number' && reply.tzOffsetMinutes !== loadState().tzOffsetMinutes) {
      // Practice timezone from the cloud → drives the export window, independent
      // of the Pi's OS timezone (which may be mis-imaged).
      saveState({ tzOffsetMinutes: reply.tzOffsetMinutes });
      log.info(`practice tz offset from cloud: ${reply.tzOffsetMinutes}min (${reply.timezone ?? '?'})`);
      collectorTick().catch((e) => log.warn('collector', e.message)); // re-export with the corrected window
    }
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
    if (reply.hubCredentials?.email && reply.hubCredentials?.password) {
      // The practice configured (or changed) the Keiser Hub login in Fyzzy →
      // adopt it and force a re-login so the collector reads the Hub. No on-site
      // or SSH provisioning needed.
      saveState({ hub: { email: reply.hubCredentials.email, password: reply.hubCredentials.password } });
      hub.resetToken();
      log.info('applied Keiser Hub login from Fyzzy — will re-login on next collect');
      collectorTick().catch((e) => log.warn('collector', e.message));
    }
    if (reply.commands?.length) {
      for (const cmd of reply.commands) {
        await runBridgeCommand(cmd).catch((e) => log.warn(`command ${cmd.id}`, e?.message));
      }
    }
  } catch (e) {
    // Offline (e.g. still on Keiser WiFi during Phase A) — that's expected.
    log.debug('heartbeat skipped (offline?)');
  }

  await maybeOpenRecoveryPortal();
}

/**
 * Self-heal: if an enrolled box hasn't reached the Fyzzy cloud for
 * `recoveryAfterMs` (e.g. it joined a WiFi with no real internet, or a captive
 * portal), re-open the "Fyzzy-Bridge-Setup" AP so someone on-site can pick a
 * working WiFi — no SSH or console needed. Closes automatically once the cloud
 * is reachable again (via the portal join, or e.g. an ethernet cable).
 */
async function maybeOpenRecoveryPortal(): Promise<void> {
  if (recoveryPortal) return;                 // already recovering
  if (!loadState().deviceSecret) return;      // not enrolled yet → boot portal handles first setup
  if (Date.now() - lastCloudOkAt < config.setup.recoveryAfterMs) return;

  const mins = Math.round((Date.now() - lastCloudOkAt) / 60_000);
  log.warn(`no Fyzzy cloud contact for ${mins}m — reopening "${config.setup.apSsid}" to fix the WiFi on-site`);
  try {
    recoveryPortal = await startSetupPortal();
    recoveryPortal.whenOnline
      .then(async () => {
        await recoveryPortal?.stop().catch(() => {});
        recoveryPortal = null;
        log.info('recovery: uplink restored via portal — rebooting for a clean reconnect');
        await new Promise((r) => setTimeout(r, 5_000));
        await reboot();
      })
      .catch(() => {});
  } catch (e) {
    log.warn('recovery-portal', (e as Error).message);
    recoveryPortal = null;
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
  const dayStart = startOfLocalDay(now);

  // 1. History BEFORE today — walk once in day-sized windows, advancing the
  //    watermark. Older days are imported exactly once here.
  let cursor = st.lastExportTo
    ? new Date(st.lastExportTo)
    : new Date(now.getTime() - config.export.backfillDays * 86_400_000);
  while (cursor.getTime() < dayStart.getTime() - 1000) {
    const from = cursor;
    const to = new Date(Math.min(from.getTime() + 86_400_000, dayStart.getTime()));
    try {
      await exportRange(from, to, st.deviceUid);
      saveState({ lastExportTo: to.toISOString() });
      cursor = new Date(to.getTime() + 1);
    } catch (e: any) {
      log.warn(`backfill ${from.toISOString().slice(0, 10)} failed: ${e.message}`);
      return; // transient — retry next tick from the same watermark
    }
  }

  // 2. TODAY — two paths, because doing only the full day made every tick take
  //    40-100s (it grows all day), and the `collecting` guard then skipped the
  //    ticks in between. That delay, not the Hub, was what made the gym feel
  //    laggy. Doing only a narrow window is fast but drops sets on the edges.
  //    So: a cheap tail every tick for liveness, a full day now and then for
  //    completeness. The cloud importer dedupes, so overlap is free.

  // 2a. Fast path — trailing window, runs every tick (~1-2s).
  const tailFrom = new Date(Math.max(dayStart.getTime(), now.getTime() - config.export.tailMinutes * 60_000));
  try {
    await exportRange(tailFrom, now, st.deviceUid, true);
  } catch (e: any) {
    log.warn(`tail export failed: ${e.message}`);
  }

  // 2b. Slow path — a BOUNDED trailing window (not the whole day), only every
  //     reconcileIntervalMs. A whole-day reconcile grew all day and, sharing the
  //     Hub connection with the tail, stalled the live feed by the evening. A
  //     fixed trailing window stays cheap + constant; the daily full pass covers
  //     the rest. The cloud importer dedupes, so overlap is free.
  const lastRec = st.lastReconcileAt ? new Date(st.lastReconcileAt).getTime() : 0;
  if (now.getTime() - lastRec >= config.export.reconcileIntervalMs) {
    const reconcileFrom = new Date(Math.max(dayStart.getTime(), now.getTime() - config.export.reconcileWindowMinutes * 60_000));
    try {
      await exportRange(reconcileFrom, now, st.deviceUid);
      saveState({ lastReconcileAt: now.toISOString() });
    } catch (e: any) {
      log.warn(`reconcile failed: ${e.message}`);
    }
  }

  // 2c. Completeness pass — the WHOLE day, infrequently. The bounded reconcile
  //     above is keyed on completed_at, so it misses reps that land in the Hub
  //     LATE with an old timestamp: the Functional Trainer uploads a session in
  //     one delayed batch, so its reps (timestamped when performed) arrive hours
  //     later, outside every trailing window, and were silently lost once 642dee1
  //     dropped the whole-day reconcile. Re-export the full day now and then to
  //     catch them; the cloud importer dedupes, so the overlap is free. Rare
  //     enough (default 30 min) that it never stalls the live tail.
  const lastFull = st.lastFullReconcileAt ? new Date(st.lastFullReconcileAt).getTime() : 0;
  if (now.getTime() - lastFull >= config.export.fullReconcileIntervalMs) {
    try {
      await exportRange(dayStart, now, st.deviceUid);
      saveState({ lastFullReconcileAt: now.toISOString() });
    } catch (e: any) {
      log.warn(`full reconcile failed: ${e.message}`);
    }
  }
}

/** Export [from,to] as one call; on a 504 (range too large) split in half and retry. */
async function exportRange(from: Date, to: Date, deviceUid: string, live = false): Promise<void> {
  try {
    const { reps } = await hub.exportWorkoutSets(toHubLocal(from), toHubLocal(to));
    if (reps.length > 0) {
      enqueue('reps', { from: from.toISOString(), to: to.toISOString(), deviceUid, reps });
      log.info(`export ${from.toISOString().slice(11, 16)}–${to.toISOString().slice(11, 16)}: ${reps.length} reps`);
      if (live) measureLiveLag(reps);
    }
  } catch (e: any) {
    if (/504/.test(e.message ?? '') && to.getTime() - from.getTime() > 10 * 60 * 1000) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      await exportRange(from, mid, deviceUid);
      await exportRange(mid, to, deviceUid);
    } else {
      throw e;
    }
  }
}

/**
 * Telemetry: the delivery latency of a rep, measured the moment a genuinely NEW
 * rep appears. "Completed At" is the Hub's own millis timestamp of when the rep
 * finished, so (now − newest) is the true Hub→box lag — the piece we can't see
 * from the cloud. A small, steady lag (~poll interval) means tightening the poll
 * is enough; a lag that jumps to a whole set's duration means the Hub only
 * exports finished SETS, and we need the realtime /log/subscribe channel instead.
 *
 * Crucially we only record when the newest-rep timestamp ADVANCES. Otherwise, an
 * idle gym (no new reps) would just show how long ago the last rep was — a
 * meaningless, ever-growing number, not the pipeline latency. When idle the last
 * real reading is kept (and the admin marks it "oud"). Stashed in state so the
 * heartbeat can ship it to the cloud and we can read it remotely (no SSH).
 */
function measureLiveLag(reps: Array<Record<string, string>>): void {
  let newest = 0;
  for (const r of reps) {
    const t = Number(r['Completed At']);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (newest <= 0) return;

  const prev = loadState().lastRepTs ?? 0;
  if (prev === 0) { saveState({ lastRepTs: newest }); return; } // bootstrap: don't measure an old rep as if it were fresh
  if (newest <= prev) return;                                   // no new rep this tick → idle/between reps, nothing to learn

  const lagMs = Math.max(0, Date.now() - newest); // clamp clock skew
  saveState({ lastRepTs: newest, lastLiveLagMs: lagMs, lastLiveLagAt: new Date().toISOString() });
  log.info(`live-lag: new rep delivered in ${(lagMs / 1000).toFixed(1)}s`);
}

/**
 * The practice's UTC offset in ms, used to compute the Hub export window in the
 * practice's local wall-clock. Sourced from the cloud heartbeat
 * (state.tzOffsetMinutes) — full tz data lives server-side — so the window
 * never depends on the Pi's OS timezone (small-ICU Node can't resolve IANA
 * zones via Intl anyway). Falls back to the system tz until the cloud value
 * arrives. Never hardcode a zone: a wrong one shifts the window and the Hub
 * returns zero reps.
 */
function localOffsetMs(): number {
  const off = loadState().tzOffsetMinutes;
  if (typeof off === 'number') return off * 60_000;
  return -new Date().getTimezoneOffset() * 60_000; // system tz fallback (offset east of UTC)
}

/** The UTC instant of local 00:00 for the day containing d, in the practice tz. */
function startOfLocalDay(d: Date): Date {
  const off = localOffsetMs();
  const local = new Date(d.getTime() + off); // into local wall-clock
  local.setUTCHours(0, 0, 0, 0);             // zero the time-of-day in local terms
  return new Date(local.getTime() - off);    // back to the real UTC instant
}

/**
 * Format an instant as the Hub's local wall-clock — the Hub filters export by
 * local time, reading the digits as its own local time and ignoring the offset.
 */
function toHubLocal(d: Date): string {
  const shifted = new Date(d.getTime() + localOffsetMs());
  return shifted.toISOString().replace(/\.\d{3}Z$/, '.000Z'); // digits are practice-local wall-clock
}

function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86_400_000); }

process.on('SIGINT', () => { stopAdvertising(); process.exit(0); });
process.on('SIGTERM', () => { stopAdvertising(); process.exit(0); });
