// Outbound link to Fyzzy cloud. Everything is client-initiated (no inbound ports):
//  - heartbeat: announce presence + learn whether we've been claimed by a practice
//  - ingest:    drain the local outbox (reps batches) once linked
//  - live:      push realtime events over a WebSocket (Phase 4)
import WebSocket from 'ws';
import { config } from '../config.js';
import { loadState, saveState } from '../state.js';
import { ack, peek, pending } from '../buffer/db.js';
import { logger } from '../util/log.js';

const log = logger('cloud');

export interface HeartbeatReply {
  claimed: boolean;
  practiceId?: number;
  /** On-demand sync command from the cloud: re-export this window now. */
  sync?: { from: string; to: string };
}

export class CloudLink {
  private ws: WebSocket | null = null;

  private url(pathname: string): string { return new URL(pathname, config.cloud.baseUrl).toString(); }

  /** Announce presence + discover claim status. Called on a timer. */
  async heartbeat(hubReachable: boolean): Promise<HeartbeatReply> {
    const st = loadState();
    const res = await fetch(this.url('/api/bridge/heartbeat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceUid: st.deviceUid,
        deviceSecret: st.deviceSecret,
        state: st.lifecycle,
        fw: process.env.npm_package_version || '0.1.0',
        hubReachable,
        pending: pending(),
      }),
    });
    if (!res.ok) throw new Error(`heartbeat HTTP ${res.status}`);
    const reply = (await res.json()) as HeartbeatReply;

    // First time we learn we've been claimed → go running + remember the practice.
    if (reply.claimed && !st.cloud) {
      saveState({ lifecycle: 'running', cloud: { practiceId: reply.practiceId! } });
      log.info(`claimed by practice ${reply.practiceId}`);
    }
    return reply;
  }

  /** Drain the outbox to the cloud. Safe to call often; acks only what the cloud accepted. */
  async flushOutbox(): Promise<number> {
    const st = loadState();
    if (!st.cloud) return 0; // not linked yet
    let sent = 0;
    for (;;) {
      const batch = peek(50);
      if (batch.length === 0) break;
      const res = await fetch(this.url('/api/bridge/ingest'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Uid': st.deviceUid,
          'X-Device-Secret': st.deviceSecret,
        },
        body: JSON.stringify({ items: batch.map((b) => ({ kind: b.kind, payload: JSON.parse(b.payload) })) }),
      });
      if (!res.ok) { log.warn(`ingest HTTP ${res.status} — will retry`); break; }
      ack(batch.map((b) => b.id));
      sent += batch.length;
    }
    if (sent) log.info(`flushed ${sent} outbox items`);
    return sent;
  }

  /** Realtime uplink for live machine events (Phase 4). */
  connectLive(onOpen?: (send: (event: unknown) => void) => void): void {
    const st = loadState();
    if (!st.cloud) return;
    const wsUrl = config.cloud.wsUrl || config.cloud.baseUrl.replace(/^http/, 'ws') + '/bridge/live';
    this.ws = new WebSocket(wsUrl, { headers: { 'X-Device-Uid': st.deviceUid, 'X-Device-Secret': st.deviceSecret } });
    this.ws.on('open', () => { log.info('live ws open'); onOpen?.((e) => this.ws?.send(JSON.stringify(e))); });
    this.ws.on('close', () => { log.warn('live ws closed — reconnect in 5s'); setTimeout(() => this.connectLive(onOpen), 5000); });
    this.ws.on('error', (err) => log.warn('live ws error', (err as Error).message));
  }

  sendLive(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }
}
