// Keiser A400 Hub (Actionhero "keiser.apollo.server") LAN client.
// Mirrors the reverse-engineered flow (see mijnfysio/KEISER-HUB-API.md):
//   POST /api/auth/login -> { user, accessToken(JWT) }   (token rotates per response)
//   GET  /api/workout-set/export?from&to (ISO8601) -> { workoutSetExport:{format:zip,encoding:base64,data} }
// The Hub uses a self-signed cert with CN apollo-api.keiser.com; we connect to the
// LAN IP with the right SNI and accept the cert (rejectUnauthorized:false).
import https from 'node:https';
import AdmZip from 'adm-zip';
import { logger } from '../util/log.js';

const log = logger('hub');

export interface HubTarget { ip: string; port: number; host: string; }
export interface LoginResult { userId: number; accountType: string; token: string; }
export interface RepRow { [column: string]: string; }
export interface ExportResult {
  reps: RepRow[];          // reps.csv parsed to objects (per-rep summary)
  timeSeriesCsv?: string;  // raw time_series.csv (large; kept as text)
}

function rawRequest(t: HubTarget, method: string, path: string, opts: {
  token?: string; body?: string; timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Host: t.host,
    };
    if (opts.body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(opts.body)); }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const req = https.request({
      host: t.ip,
      port: t.port,
      method,
      path,
      headers,
      servername: t.host,          // SNI so the cert matches
      rejectUnauthorized: false,   // self-signed Keiser cert
      timeout: opts.timeoutMs ?? 90_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export class KeiserApolloClient {
  private token: string | null = null;
  // The Hub rotates the accessToken on every response and invalidates the old
  // one. So two concurrent callers (the collector + the presence poller) would
  // clobber each other's token → 401. Serialize every Hub request through this
  // lock so calls run one-at-a-time and always use the freshest token.
  private lock: Promise<void> = Promise.resolve();
  constructor(private readonly target: HubTarget) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }

  /** Rotate to the freshest accessToken any response hands back. */
  private absorbToken(json: any) {
    if (json && typeof json.accessToken === 'string') this.token = json.accessToken;
  }

  get currentToken(): string | null { return this.token; }

  async login(email: string, password: string): Promise<LoginResult> {
    return this.withLock(async () => {
      const { status, body } = await rawRequest(this.target, 'POST', '/api/auth/login', {
        body: JSON.stringify({ email, password }), timeoutMs: 20_000,
      });
      if (status !== 200) throw new Error(`login failed: HTTP ${status} ${body.slice(0, 200)}`);
      const json = JSON.parse(body);
      this.absorbToken(json);
      if (!this.token) throw new Error('login ok but no accessToken in response');
      log.info(`login ok user=${json.user?.id} role=${json.user?.accountType}`);
      return { userId: json.user?.id, accountType: json.user?.accountType, token: this.token };
    });
  }

  async keepAlive(): Promise<void> {
    return this.withLock(async () => {
      const { status, body } = await rawRequest(this.target, 'POST', '/api/auth/keep-alive', { token: this.token ?? undefined, timeoutMs: 15_000 });
      if (status === 200) { try { this.absorbToken(JSON.parse(body)); } catch { /* ignore */ } }
      else log.debug(`keep-alive HTTP ${status}`); // non-fatal; the collector re-logins as needed
    });
  }

  private async getJson(path: string): Promise<any> {
    return this.withLock(async () => {
      const { status, body } = await rawRequest(this.target, 'GET', path, { token: this.token ?? undefined });
      // The Hub invalidates our token whenever the same account logs in elsewhere.
      // Drop it on 401/403 so the next tick re-logins instead of looping on a dead token.
      if (status === 401 || status === 403) this.token = null;
      if (status !== 200) throw new Error(`GET ${path} -> HTTP ${status} ${body.slice(0, 160)}`);
      const json = JSON.parse(body);
      this.absorbToken(json);
      return json;
    });
  }

  async listUsers(limit = 500): Promise<any[]> {
    const j = await this.getJson(`/api/user/list?limit=${limit}`);
    return j.users ?? [];
  }

  async listMachines(): Promise<any[]> {
    const j = await this.getJson('/api/strength-machine/list');
    return j.strengthMachines ?? [];
  }

  /** Raw authenticated GET — for live-source discovery (active-users etc.). */
  async raw(path: string): Promise<any> {
    return this.getJson(path);
  }

  /**
   * Export one small window of workout sets. Keep ranges small (≈ per day):
   * large ranges 504 at the nginx proxy (~60s). from/to are ISO 8601 UTC.
   * Returns parsed reps.csv rows + the raw time_series.csv.
   */
  async exportWorkoutSets(fromIso: string, toIso: string): Promise<ExportResult> {
    return this.withLock(async () => {
      const q = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
      const { status, body } = await rawRequest(this.target, 'GET', `/api/workout-set/export?${q}`, {
        token: this.token ?? undefined, timeoutMs: 90_000,
      });
      if (status === 401 || status === 403) { this.token = null; throw new Error('export unauthorized — token cleared'); }
      if (status === 504) throw new Error('export 504 (range too large — shrink the window)');
      // The Hub answers 500 "UnknownEntity / entity does not exist" for a window with no
      // workout sets — an empty day, or a day older than its ~2-week retention. That is
      // not an error for us: treat it as "no reps this day" so the backfill advances
      // past it instead of getting stuck retrying the same day forever.
      if (status === 500 && /UnknownEntity|entity does not exist/i.test(body)) return { reps: [] };
      if (status !== 200) throw new Error(`export HTTP ${status} ${body.slice(0, 160)}`);
      const json = JSON.parse(body);
      this.absorbToken(json);
      const exp = json.workoutSetExport;
      if (!exp?.data) return { reps: [] };
      const zipBuf = Buffer.from(exp.data, exp.encoding === 'base64' ? 'base64' : 'utf8');
      const zip = new AdmZip(zipBuf);

      let reps: RepRow[] = [];
      let timeSeriesCsv: string | undefined;
      for (const entry of zip.getEntries()) {
        const name = entry.entryName.toLowerCase();
        if (name === 'reps.csv') reps = parseCsv(entry.getData().toString('utf8'));
        else if (name === 'time_series.csv') timeSeriesCsv = entry.getData().toString('utf8');
      }
      log.info(`export ${fromIso}..${toIso}: ${reps.length} reps`);
      return { reps, timeSeriesCsv };
    });
  }
}

/** Minimal CSV → array of objects. Handles quoted fields with commas. */
export function parseCsv(text: string): RepRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  const rows: RepRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: RepRow = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? '';
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
