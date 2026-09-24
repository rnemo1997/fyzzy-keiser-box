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

  // On-site WiFi setup ("captive portal"). When the box has no internet uplink,
  // it hosts its own AP on wlan0 and serves a browser page where the customer
  // picks their practice WiFi + enters the password. wlan0 time-shares: hotspot
  // for setup, then it joins the chosen network as the internet uplink while the
  // wired interface (eth0) keeps talking to the Keiser subnet. See src/provisioning/portal.ts.
  setup: {
    // AP the customer connects their phone to.
    apSsid: process.env.SETUP_AP_SSID || 'Fyzzy-Bridge-Setup',
    // NetworkManager requires a >=8 char WPA passphrase for `dev wifi hotspot`.
    apPassword: process.env.SETUP_AP_PASSWORD || 'fyzzysetup',
    // The single WiFi radio that hosts the AP and later joins the practice WiFi.
    iface: process.env.SETUP_IFACE || 'wlan0',
    // Port the portal binds. 80 so the phone opens http://10.42.0.1 without a port
    // (and so OS captive-portal probes hit it). Needs CAP_NET_BIND_SERVICE (set in
    // the systemd unit); override to e.g. 8080 in unprivileged setups.
    portalPort: Number(process.env.SETUP_PORTAL_PORT || 80),
    // Fixed AP IP NetworkManager's "shared" mode assigns to wlan0 (+ built-in DHCP).
    apIp: process.env.SETUP_AP_IP || '10.42.0.1',
    // The wired interface that faces the Keiser subnet — kept OFF the default route
    // (ipv4.never-default) so internet goes via wlan0 once the practice WiFi is joined.
    keiserIface: process.env.SETUP_KEISER_IFACE || 'eth0',
    // How long to wait at boot for an uplink (saved WiFi / DHCP) before opening the
    // setup AP. Avoids popping the portal during a normal slow boot.
    noUplinkGraceMs: Number(process.env.SETUP_NO_UPLINK_GRACE_MS || 45_000),
    // How often, while the portal is open, to re-check whether wlan0 got a real
    // uplink (customer joined, or saved WiFi came up) so we can close the AP.
    onlinePollMs: Number(process.env.SETUP_ONLINE_POLL_MS || 10_000),
    // Self-heal: if an enrolled box hasn't reached the Fyzzy cloud for this long,
    // re-open the setup AP so someone on-site can fix the WiFi without SSH/console.
    recoveryAfterMs: Number(process.env.SETUP_RECOVERY_AFTER_MS || 300_000), // 5 min
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
    // How often the collector polls the Hub for new reps. The tail export takes
    // ~1-2s and the `collecting` guard skips overlapping ticks, so 3s keeps the
    // gym feeling live without hammering the Hub's per-response token rotation.
    collectIntervalMs: Number(process.env.COLLECT_INTERVAL_MS || 3_000),
    // Fast path: every tick exports only this trailing window. Small payload,
    // so a tick finishes in ~1-2s and the next one is not skipped by the
    // `collecting` guard. This is what makes the gym feel live.
    tailMinutes: Number(process.env.TAIL_MINUTES || 6),
    // Slow path: re-export a trailing window this often, to catch anything the
    // tail missed (late-finished sets, window edges). Bounded (not the whole day)
    // so it stays cheap + constant late in a busy day instead of growing and
    // stalling the live tail (they share one Hub connection).
    reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 180_000),
    // The reconcile trailing window. Well beyond the tail so it catches real
    // gaps, but bounded so its cost doesn't grow all day. The daily full pass
    // (dailyHour) still guarantees total completeness.
    reconcileWindowMinutes: Number(process.env.RECONCILE_WINDOW_MINUTES || 180),
  },

  // Over-the-air updates. The box pulls a single bundled file from GitHub
  // Releases, verifies its sha256, swaps a `current` symlink and restarts.
  ota: {
    enabled: process.env.OTA_ENABLED !== 'false',
    repo: process.env.OTA_REPO || 'rnemo1997/fyzzy-keiser-box',
    checkIntervalMs: Number(process.env.OTA_INTERVAL_MS || 3_600_000), // hourly
    installDir: process.env.INSTALL_DIR || '/opt/fyzzy-bridge',
  },

  // Remote-access layer (WireGuard tunnel + central SSH-key sync). See
  // mijnfysio/BRIDGE-REMOTE-ACCESS-PLAN.md. The first-boot enroll-service reads
  // the provisioning file and phones the enroll endpoint; a timer keeps the SSH
  // authorized_keys in sync with the fleet-wide registry.
  remote: {
    // Where the SD-card's boot partition drops the per-Bridge provisioning file.
    // Both classic and the newer bootfs location are checked.
    provisionPaths: (process.env.FYZZY_PROVISION_PATHS
      || '/boot/firmware/fyzzy-provision.json:/boot/fyzzy-provision.json')
      .split(':')
      .filter(Boolean),
    // WireGuard client interface + its persistent config on the Pi.
    wgInterface: process.env.WG_INTERFACE || 'wg0',
    wgConfPath: process.env.WG_CONF_PATH || '/etc/wireguard/wg0.conf',
    // OS user whose ~/.ssh/authorized_keys the fleet key-sync manages, and whose
    // login the admin uses over the overlay (ssh <user>@10.100.0.x).
    sshUser: process.env.FYZZY_SSH_USER || 'fyzzy',
    // Break-glass key(s) baked into the image — ALWAYS kept in authorized_keys,
    // never removed by a sync, so a broken/empty response can't lock us out.
    bootstrapKeysPath: process.env.FYZZY_BOOTSTRAP_KEYS || '/etc/fyzzy/bootstrap_authorized_keys',
  },

  version: process.env.FYZZY_BRIDGE_VERSION || '0.1.0',
} as const;

export type Config = typeof config;
