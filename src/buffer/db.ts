// Local durable outbox — pure-JS (no native deps) so the whole box can ship as a
// single bundled file and OTA-update trivially. Everything bound for the cloud is
// enqueued here first, so an internet outage never loses data; the uploader drains
// it when connectivity returns. Backed by a small JSON file (rewritten on change);
// the volume (reps batches per day) is tiny, so this is plenty.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type OutboxKind = 'reps' | 'live';
export interface OutboxItem { id: number; kind: OutboxKind; payload: string; created_at: number; }

const file = path.join(config.dataDir, 'outbox.json');

interface OutboxFile { seq: number; items: OutboxItem[]; }
let cache: OutboxFile | null = null;

function load(): OutboxFile {
  if (cache) return cache;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8')) as OutboxFile;
    if (!cache.items) cache = { seq: 0, items: [] };
  } catch {
    cache = { seq: 0, items: [] };
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic swap
}

export function enqueue(kind: OutboxKind, payload: unknown): void {
  const db = load();
  db.items.push({ id: ++db.seq, kind, payload: JSON.stringify(payload), created_at: Date.now() });
  persist();
}

export function peek(limit = 50): OutboxItem[] {
  return load().items.slice(0, limit);
}

export function ack(ids: number[]): void {
  if (ids.length === 0) return;
  const db = load();
  const drop = new Set(ids);
  db.items = db.items.filter((i) => !drop.has(i.id));
  persist();
}

export function pending(): number {
  return load().items.length;
}
