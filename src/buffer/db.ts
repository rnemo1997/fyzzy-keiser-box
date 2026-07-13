// Local durable outbox. Everything the bridge wants to send to the cloud is
// enqueued here first, so an internet outage never loses data — the uploader
// drains the queue when connectivity returns.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export type OutboxKind = 'reps' | 'live';

export interface OutboxItem { id: number; kind: OutboxKind; payload: string; created_at: number; }

let db: Database.Database | null = null;

function open(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(path.join(config.dataDir, 'buffer.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  return db;
}

export function enqueue(kind: OutboxKind, payload: unknown): void {
  open().prepare('INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)')
    .run(kind, JSON.stringify(payload), Date.now());
}

export function peek(limit = 50): OutboxItem[] {
  return open().prepare('SELECT * FROM outbox ORDER BY id ASC LIMIT ?').all(limit) as OutboxItem[];
}

export function ack(ids: number[]): void {
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(',');
  open().prepare(`DELETE FROM outbox WHERE id IN (${ph})`).run(...ids);
}

export function pending(): number {
  return (open().prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
}
