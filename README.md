# Fyzzy Bridge

On-site collector (Raspberry Pi 4/5) that reads a **Keiser A400 Hub** over the gym
LAN and forwards training data to **Fyzzy cloud** — live + a daily reconciliation
export. Zero-config onboarding: plug it in, discover it in the Fyzzy app, set the
practice WiFi, couple it to your practice.

Architecture & protocol: see `mijnfysio/FYZZY-BRIDGE-ARCHITECTURE.md` and
`mijnfysio/KEISER-HUB-API.md`.

## Hoe het werkt (kort)
- **Twee netwerk-poten**: `wlan0` op het **Keiser A400 WiFi** (databron, geen internet)
  + een tweede interface (`wlan1`/USB-eth) op het **praktijk-net** (internet-uplink).
- **Lifecycle**: `new → provisioned → linked → running`.
  - `new`: adverteert via mDNS (`_fyzzy-bridge._tcp`); opent een lokale provisioning-API.
  - App (Fase A, offline op Keiser-WiFi) zet de praktijk-WiFi via `POST /provision`.
  - Box krijgt internet → heartbeat naar cloud → app claimt 'm (Fase B, online) → `running`.
- **Collector**: login op de Hub → per-dag `/workout-set/export` (kleine ranges i.v.m. nginx-504)
  → `reps.csv` → durable outbox (SQLite) → upload naar cloud. Live-kanaal volgt (Fase 4).

## Ontwikkelen
```bash
npm install
npm run typecheck
npm run dev        # tsx watch
```

## Config (env)
| var | default | |
|---|---|---|
| `HUB_IP` / `HUB_PORT` | `192.168.150.2` / `8090` | Keiser Hub |
| `HUB_EMAIL` / `HUB_PASSWORD` | — | **fallback** Keiser-login. Normaal wordt de per-praktijk Keiser-login in de app-onboarding ingevoerd en op de box opgeslagen — niet via env. |
| `UPLINK_IFACE` | `wlan1` | interface naar het praktijk-net |
| `FYZZY_CLOUD_URL` | `https://fyzzy.nl` | cloud base-url (`/api/bridge/*`) |
| `FYZZY_DATA_DIR` | `~/.fyzzy-bridge` | state + buffer |
| `BACKFILL_DAYS` | `30` | eerste sync haalt zoveel dagen op |
| `OTA_REPO` | `rnemo1997/fyzzy-keiser-box` | GitHub-repo voor OTA-releases |
| `OTA_ENABLED` | `true` | zet op `false` om auto-update uit te zetten |
| `FYZZY_PROVISION_PATHS` | `/boot/firmware/…:/boot/…` | waar het `fyzzy-provision.json` op de boot-partitie staat |
| `WG_INTERFACE` / `WG_CONF_PATH` | `wg0` / `/etc/wireguard/wg0.conf` | WireGuard-client interface + config |
| `FYZZY_SSH_USER` | `fyzzy` | user waarvan de fleet-sync `authorized_keys` beheert |
| `FYZZY_BOOTSTRAP_KEYS` | `/etc/fyzzy/bootstrap_authorized_keys` | break-glass key(s), blijven altijd staan |

## OTA-updates (over-the-air)
De box is **pure-JS** en draait als één gebundeld bestand (`bundle.cjs`) achter een
`current`-symlink. Updaten = die symlink omwisselen — geen compileren op de Pi.

- **Releasen:** `git tag v0.2.0 && git push --tags`. De GitHub Action
  (`.github/workflows/release.yml`) bouwt `bundle.cjs` + `bundle.cjs.sha256` en
  publiceert een **GitHub Release**.
- **De box** checkt elk uur de laatste release, downloadt de bundle, **verifieert de
  sha256**, plaatst 'm in `releases/<versie>/`, wisselt de `current`-symlink en herstart
  (systemd `Restart=always`). Vorige releases blijven staan → snelle rollback.
- Uit te zetten met `OTA_ENABLED=false`.

## Remote access (WireGuard + fleet SSH-keys)
Zie `mijnfysio/BRIDGE-REMOTE-ACCESS-PLAN.md`. De box belt zichzelf thuis via een
WireGuard-tunnel zodat we er — ook achter NAT/CGNAT (Australië) — altijd via SSH
bij kunnen, en het fleet-scherm per praktijk laat zien of hij online is.

Eén OTA-bundle, drie entrypoints (via systemd):
- `fyzzy-enroll.service` (oneshot, first-boot, `node bundle.cjs enroll`): leest
  `fyzzy-provision.json` van de boot-partitie, genereert een WireGuard-keypair +
  device-secret, doet `POST /api/bridge/enroll`, schrijft `wg0.conf` en start
  `wg-quick@wg0`. **Idempotent** — na de eerste keer doet-ie niets meer.
- `fyzzy-authkeys.timer` (elke 5 min + bij boot, `node bundle.cjs authkeys`): haalt
  de centraal beheerde SSH-sleutels op (`GET /api/bridge/authorized-keys`) en
  schrijft ze **atomisch** naar de `authorized_keys` van `FYZZY_SSH_USER`, met
  **altijd** behoud van de bootstrap-key. Lege/ongeldige respons → niets overschrijven.
- `fyzzy-bridge.service` (collector): heartbeat stuurt nu ook `wgHandshakeAgeSec`
  (uit `wg show wg0 latest-handshakes`) als tweede online-signaal.

Enroll-state (`deviceUid`, `deviceSecret`, `wgPubkey`, `overlayIp`, `enrolledAt`)
leeft in `state.json` in de gedeelde `FYZZY_DATA_DIR` (`/var/lib/fyzzy-bridge`);
de WireGuard-privésleutel staat alleen in `wg0.conf` (0600) en verlaat de Pi nooit.

## Deploy op de Pi
```bash
sudo bash scripts/install.sh    # bouwt, installeert deps, zet systemd-service aan
```
Vereist Raspberry Pi OS met **NetworkManager** (`nmcli`) voor WiFi-provisioning.

## Status
MVP-scaffold: Hub-client (login + per-dag export + unzip), mDNS-discovery, lokale
provisioning-server, cloud-link (heartbeat/ingest/live-skeleton), outbox-buffer,
orchestrator. **Nog te doen**: live-subscribe (on-site kanaal bevestigen),
machine-secret auth, OTA-updates, en de dual-interface netwerk-setup op de Pi.
