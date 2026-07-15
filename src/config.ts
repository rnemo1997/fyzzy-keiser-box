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
    // The Hub filters /workout-set/export by LOCAL wall-clock (it ignores the
    // offset on from/to). Send the window bounds in this tz so they line up with
    // real UTC instants; otherwise the box exports a window ~2h in the past.
    tz: process.env.HUB_TZ || 'Europe/Amsterdam',
  },

  // Fyzzy cloud the bridge phones home to. Endpoints live under /api/bridge/*.
  cloud: {
    baseUrl: process.env.FYZZY_CLOUD_URL || 'https://fyzzy.nl',
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
    // How many days back to backfill on first run. The Keiser Hub keeps only
    // ~2 weeks of history, so 30 just wastes requests on days it 500s for.
    backfillDays: Number(process.env.BACKFILL_DAYS || 14),
    // Run the daily reconciliation at this local hour.
    dailyHour: Number(process.env.DAILY_EXPORT_HOUR || 3),
    // How often the collector polls the Hub for new reps. Low = near-live in the
    // gym (data within ~this interval); each poll is a tiny watermark→now window.
    collectIntervalMs: Number(process.env.COLLECT_INTERVAL_MS || 10_000),
  },

  // Over-the-air updates. The box pulls a single bundled file from GitHub
  // Releases, verifies its sha256, swaps a `current` symlink and restarts.
  ota: {
    enabled: process.env.OTA_ENABLED !== 'false',
    repo: process.env.OTA_REPO || 'rnemo1997/fyzzy-keiser-box',
    checkIntervalMs: Number(process.env.OTA_INTERVAL_MS || 3_600_000), // hourly
    installDir: process.env.INSTALL_DIR || '/opt/fyzzy-bridge',
  },

  version: process.env.FYZZY_BRIDGE_VERSION || '0.1.0',
} as const;

export type Config = typeof config;
