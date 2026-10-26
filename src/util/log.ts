// Tiny structured logger — no deps. Prefix + level, JSON-friendly.
//
// Besides stdout/stderr (which journald captures, but journald is volatile on
// the Pi so it is wiped on reboot), every line is also appended to a small
// size-capped file in the data dir. That log SURVIVES a reboot/power-cycle, so
// after a hang that needed a power-cycle we can still read what the agent was
// doing just before it went silent (Nemo 26-10: two bridges hung at ~14:01 and
// the reboot wiped every trace). Capped to protect the SD card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) || 'info'];

// Same dataDir resolution as config.ts — kept inline so this leaf util pulls in
// no imports (and can never form a cycle with config).
const LOG_DIR = path.join(process.env.FYZZY_DATA_DIR || path.join(os.homedir(), '.fyzzy-bridge'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');
const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB; one rotated file ⇒ ≤ ~4 MB total

let fileReady: boolean | null = null; // null = not tried yet, false = disabled
let bytes = 0;

function ensureFile(): boolean {
  if (fileReady !== null) return fileReady;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { bytes = fs.statSync(LOG_FILE).size; } catch { bytes = 0; }
    fileReady = true;
  } catch {
    fileReady = false; // dir not writable (e.g. dev) → console only, never throw
  }
  return fileReady;
}

function toFile(line: string) {
  if (!ensureFile()) return;
  try {
    const buf = line + '\n';
    fs.appendFileSync(LOG_FILE, buf);
    bytes += Buffer.byteLength(buf);
    if (bytes >= MAX_BYTES) {
      try { fs.rmSync(LOG_FILE + '.1', { force: true }); } catch { /* noop */ }
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      bytes = 0;
    }
  } catch {
    // A full disk or a transient error must never take the agent down.
  }
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const full = extra !== undefined ? `${line} ${safe(extra)}` : line;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(full);
  toFile(full);
}
function safe(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
