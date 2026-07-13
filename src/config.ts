// Static + env config. Runtime identity/secrets live in state.ts (persisted),
// not here.
import os from 'node:os';

export const config = {
  // Where persisted runtime state (device id, tokens, buffer db) lives.
  dataDir: process.env.FYZZY_DATA_DIR || `${os.homedir()}/.fyzzy-bridge`,

  // The Keiser Hub on the gym LAN.
  hub: {
    ip: process.env.HUB_IP || '192.168.150.2',
    port: Number(process.env.HUB_PORT || 8090),
    host: 'apollo-api.keiser.com', // TLS SNI/cert CN; we pin via --resolve equivalent
  },

  // Fyzzy cloud the bridge phones home to.
  cloud: {
    baseUrl: process.env.FYZZY_CLOUD_URL || 'https://api.fyzzy.nl',
    // Realtime uplink (WebSocket). Derived from baseUrl if not set.
    wsUrl: process.env.FYZZY_CLOUD_WS || '',
  },

  // Local provisioning HTTP server (only open while state === 'new').
  provisioning: {
    port: Number(process.env.PROVISION_PORT || 8088),
  },

  // mDNS service type advertised on the LAN for app discovery.
  mdnsType: 'fyzzy-bridge',

  // Batch export cadence.
  export: {
    // How many days back to backfill on first run.
    backfillDays: Number(process.env.BACKFILL_DAYS || 30),
    // Run the daily reconciliation at this local hour.
    dailyHour: Number(process.env.DAILY_EXPORT_HOUR || 3),
  },
} as const;

export type Config = typeof config;
