// Over-the-air updates. The box ships as a single bundled `bundle.cjs`, so an
// update is: download the latest bundle from GitHub Releases, verify its sha256,
// drop it in releases/<version>/, atomically repoint the `current` symlink, and
// restart (systemd relaunches). No compiling on the Pi, no external platform.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('ota');

interface GhAsset { name: string; browser_download_url: string; }
interface GhRelease { tag_name: string; assets: GhAsset[]; prerelease: boolean; }

function currentVersion(): string {
  try {
    return fs.readFileSync(path.join(config.ota.installDir, 'current', 'VERSION'), 'utf8').trim();
  } catch {
    return config.version;
  }
}

/** Compare dotted numeric versions. Returns true if `a` is newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchLatestRelease(): Promise<GhRelease | null> {
  const res = await fetch(`https://api.github.com/repos/${config.ota.repo}/releases/latest`, {
    headers: { 'User-Agent': 'fyzzy-bridge-updater', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) { log.warn(`github releases HTTP ${res.status}`); return null; }
  return (await res.json()) as GhRelease;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'fyzzy-bridge-updater' } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Check for a newer release and apply it. Restarts the process on success. */
export async function checkAndUpdate(): Promise<void> {
  if (!config.ota.enabled) return;
  const rel = await fetchLatestRelease().catch((e) => { log.debug('ota check skipped', e.message); return null; });
  if (!rel) return;

  const target = rel.tag_name.replace(/^v/, '');
  const current = currentVersion();
  if (!isNewer(target, current)) { log.debug(`up to date (current=${current}, latest=${target})`); return; }

  const bundle = rel.assets.find((a) => a.name === 'bundle.cjs');
  const shaAsset = rel.assets.find((a) => a.name === 'bundle.cjs.sha256');
  if (!bundle) { log.warn('release has no bundle.cjs asset'); return; }

  log.info(`updating ${current} -> ${target}`);
  const data = await download(bundle.browser_download_url);

  // Verify integrity.
  const gotSha = crypto.createHash('sha256').update(data).digest('hex');
  if (shaAsset) {
    const want = (await download(shaAsset.browser_download_url)).toString('utf8').trim().split(/\s+/)[0];
    if (want && want !== gotSha) { log.error(`sha256 mismatch (want ${want}, got ${gotSha}) — abort`); return; }
  } else {
    log.warn('no sha256 asset — installing unverified (add bundle.cjs.sha256 to releases)');
  }

  // Stage the new release.
  const relDir = path.join(config.ota.installDir, 'releases', target);
  fs.mkdirSync(relDir, { recursive: true });
  fs.writeFileSync(path.join(relDir, 'bundle.cjs'), data);
  fs.writeFileSync(path.join(relDir, 'VERSION'), target);

  // Atomically repoint `current` -> releases/<target>.
  const currentLink = path.join(config.ota.installDir, 'current');
  const tmpLink = `${currentLink}.tmp`;
  try { fs.rmSync(tmpLink, { force: true }); } catch { /* ignore */ }
  fs.symlinkSync(relDir, tmpLink, 'dir');
  fs.renameSync(tmpLink, currentLink);

  log.info(`installed ${target} — restarting`);
  process.exit(0); // systemd (Restart=always) relaunches current/bundle.cjs
}

/** Periodic OTA check. */
export function startAutoUpdate(): void {
  if (!config.ota.enabled) { log.info('OTA disabled'); return; }
  setInterval(() => { checkAndUpdate().catch((e) => log.warn('ota', e.message)); }, config.ota.checkIntervalMs);
  // First check shortly after boot (let the box settle / connect first).
  setTimeout(() => checkAndUpdate().catch(() => {}), 60_000);
  log.info(`OTA on (repo=${config.ota.repo}, every ${Math.round(config.ota.checkIntervalMs / 60000)}m)`);
}
