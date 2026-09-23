// On-site WiFi setup portal ("captive portal").
//
// When the box has no internet uplink it hosts the "Fyzzy-Bridge-Setup" AP on the
// WiFi radio and serves this mobile-friendly page at http://10.42.0.1. The customer
// picks their practice WiFi and enters the password; the box joins it, verifies
// internet, drops the AP, and the normal flow (enroll -> WireGuard -> collector)
// proceeds. Single radio, so the AP and the client connection time-share wlan0.
//
// A plain node:http server (not the Fastify provisioning server) is used so we can
// answer arbitrary OS captive-probe hostnames/paths and bind port 80 cheaply.
import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { startAp, stopAp, scanWifi, connectWifi, hasUplink, ifaceHasInternet, reboot } from './ap.js';

const log = logger('portal');

export interface PortalHandle {
  /** Resolves once the box has a working uplink on the setup radio (portal done). */
  whenOnline: Promise<void>;
  /** Tear down the HTTP server + AP. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Bring up the AP + portal. Resolves the returned `whenOnline` when the setup radio
 * reaches the internet (customer joined, or a saved WiFi came up in the background),
 * so callers can then continue the normal lifecycle. Does NOT gate on anything — use
 * maybeRunSetupPortal() for the boot-time "only when there's no uplink" decision.
 */
export async function startSetupPortal(): Promise<PortalHandle> {
  await startAp();

  let resolveOnline: () => void = () => {};
  const whenOnline = new Promise<void>((res) => { resolveOnline = res; });
  let closed = false;

  const server = http.createServer((req, res) => handle(req, res, resolveOnline));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.setup.portalPort, '0.0.0.0', () => resolve());
  });
  log.info(`setup portal on :${config.setup.portalPort} — connect to WiFi "${config.setup.apSsid}" (pw "${config.setup.apPassword}") and open http://${config.setup.apIp}`);

  // Background watcher: if the setup radio gets a real uplink without a /connect
  // (e.g. a previously-saved WiFi finally associates), close the portal too.
  const poll = setInterval(() => {
    ifaceHasInternet(config.setup.iface)
      .then((ok) => { if (ok) resolveOnline(); })
      .catch(() => {});
  }, config.setup.onlinePollMs);
  if (typeof poll.unref === 'function') poll.unref();

  const stop = async () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAp();
  };

  return { whenOnline, stop };
}

/**
 * Boot-time entry: after a short grace period, if the box has NO internet uplink,
 * open the setup AP + portal and keep it open until a working uplink appears, then
 * close it. If an uplink is already present (saved WiFi), returns immediately without
 * ever touching the radio. Never loops tightly.
 */
export async function maybeRunSetupPortal(): Promise<void> {
  await delay(config.setup.noUplinkGraceMs);
  if (await hasUplink()) {
    log.info('uplink present at boot — skipping setup portal');
    return;
  }
  log.info('no internet uplink — opening on-site WiFi setup portal');
  const portal = await startSetupPortal();
  await portal.whenOnline;   // resolves ONLY on a confirmed internet uplink
  await portal.stop();       // drop the AP (response already sent to the phone)
  // First-boot enroll failed earlier without internet and won't retry, so reboot to
  // enroll cleanly. `whenOnline` never fires on a failed /connect → never reboots then.
  await delay(5_000);
  await reboot();
}

/**
 * Standalone run (the `setup-portal` subcommand). Opens the AP + portal unconditionally
 * and keeps it open until a real uplink appears or the process is signalled. Handy for
 * on-site re-configuration and testing.
 */
export async function runSetupPortalStandalone(): Promise<void> {
  const portal = await startSetupPortal();
  const cleanup = async () => { await portal.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await portal.whenOnline;   // resolves ONLY on a confirmed internet uplink
  await portal.stop();
  log.info('setup portal finished (uplink up) — rebooting for a clean enroll');
  await delay(5_000);
  await reboot();
}

// ---- HTTP handling ---------------------------------------------------------

function handle(req: http.IncomingMessage, res: http.ServerResponse, onOnline: () => void): void {
  const url = req.url || '/';
  const method = req.method || 'GET';
  const path = url.split('?')[0];

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', PAGE);
  }
  if (method === 'GET' && path === '/scan') {
    scanWifi()
      .then((networks) => sendJson(res, 200, { networks }))
      .catch((e) => sendJson(res, 500, { error: 'scan_failed', message: String(e?.message || e) }));
    return;
  }
  if (method === 'POST' && path === '/connect') {
    return handleConnect(req, res, onOnline);
  }
  // Any other request (incl. OS captive-portal probes: Apple /hotspot-detect.html,
  // Android /generate_204, Windows /ncsi.txt, ...) — redirect to the portal so the
  // phone pops the "sign in to network" page automatically.
  res.writeHead(302, { Location: `http://${config.setup.apIp}/` });
  res.end();
}

function handleConnect(req: http.IncomingMessage, res: http.ServerResponse, onOnline: () => void): void {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let ssid = '', password = '';
    try {
      const parsed = JSON.parse(body || '{}');
      ssid = String(parsed.ssid || '').trim();
      password = String(parsed.password || '');
    } catch { /* fall through to validation */ }
    if (!ssid) return sendJson(res, 422, { ok: false, error: 'missing_ssid' });

    connectWifi(ssid, password).then((result) => {
      if (result.ok && result.hasInternet) {
        sendJson(res, 200, { ok: true });
        // Signal the orchestrator + close the AP a few seconds LATER so this
        // response reaches the phone before the radio switches away.
        setTimeout(() => onOnline(), 3_000);
        return;
      }
      const error = result.error === 'no_internet' ? 'no_internet' : 'wrong_password';
      sendJson(res, 400, { ok: false, error, message: result.error });
    }).catch((e) => {
      sendJson(res, 500, { ok: false, error: 'connect_failed', message: String(e?.message || e) });
    });
  });
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ---- The page (self-contained, bilingual NL/EN, no external assets) --------

const PAGE = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Fyzzy Bridge — WiFi</title>
<style>
  :root { --bg:#0f1226; --card:#1a1f3d; --line:#2c3358; --fg:#eef1ff; --muted:#9aa3c7; --accent:#6B2D8E; --accent2:#8b5cf6; --ok:#22c55e; --err:#ef4444; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:linear-gradient(160deg,#0f1226,#151a35); color:var(--fg); min-height:100vh; padding:24px 16px calc(24px + env(safe-area-inset-bottom)); }
  .wrap { max-width:440px; margin:0 auto; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .dot { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,var(--accent),var(--accent2)); display:flex; align-items:center; justify-content:center; font-weight:800; }
  h1 { font-size:20px; margin:0; }
  .lang { margin-left:auto; }
  .lang button { background:none; border:1px solid var(--line); color:var(--muted); border-radius:8px; padding:4px 9px; font-size:12px; cursor:pointer; }
  .lang button.on { color:var(--fg); border-color:var(--accent2); }
  p.sub { color:var(--muted); font-size:14px; margin:6px 0 20px; line-height:1.45; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px; }
  label { display:block; font-size:13px; color:var(--muted); margin:14px 0 6px; }
  label:first-child { margin-top:0; }
  select, input, button.primary { width:100%; font-size:16px; border-radius:11px; border:1px solid var(--line); background:#11152e; color:var(--fg); padding:13px 12px; }
  .row { display:flex; gap:8px; }
  .row select { flex:1; }
  button.icon { width:48px; border-radius:11px; border:1px solid var(--line); background:#11152e; color:var(--fg); font-size:18px; }
  .pw { position:relative; }
  .pw button { position:absolute; right:6px; top:6px; bottom:6px; border:none; background:none; color:var(--muted); font-size:13px; padding:0 10px; }
  button.primary { margin-top:20px; border:none; font-weight:700; background:linear-gradient(135deg,var(--accent),var(--accent2)); cursor:pointer; }
  button.primary:disabled { opacity:.55; }
  .status { margin-top:16px; font-size:14px; line-height:1.5; display:none; padding:12px 14px; border-radius:11px; }
  .status.show { display:block; }
  .status.info { background:#1c2450; }
  .status.ok { background:rgba(34,197,94,.13); color:#bbf7d0; }
  .status.err { background:rgba(239,68,68,.13); color:#fecaca; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,.3); border-top-color:#fff; border-radius:50%; animation:s .7s linear infinite; vertical-align:-2px; margin-right:7px; }
  @keyframes s { to { transform:rotate(360deg); } }
  .foot { color:var(--muted); font-size:12px; text-align:center; margin-top:18px; line-height:1.5; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="dot">F</div>
    <h1 data-t="title">WiFi instellen</h1>
    <div class="lang">
      <button data-lang="nl" class="on">NL</button>
      <button data-lang="en">EN</button>
    </div>
  </div>
  <p class="sub" data-t="intro">Kies het WiFi-netwerk van de praktijk en vul het wachtwoord in. Het kastje verbindt dan met internet en komt online in Fyzzy.</p>
  <div class="card">
    <label data-t="network">Netwerk</label>
    <div class="row">
      <select id="ssid"><option value="" data-t="scanning">Scannen…</option></select>
      <button class="icon" id="refresh" title="Opnieuw scannen">↻</button>
    </div>
    <label data-t="ssidManual" style="display:none" id="manualLabel">Netwerknaam (SSID)</label>
    <input id="ssidManual" style="display:none" autocapitalize="none" autocomplete="off">
    <label data-t="password">Wachtwoord</label>
    <div class="pw">
      <input id="password" type="password" autocapitalize="none" autocomplete="off">
      <button id="toggle" type="button" data-t="show">toon</button>
    </div>
    <button class="primary" id="connect" data-t="connect">Verbinden</button>
    <div class="status" id="status"></div>
  </div>
  <div class="foot" data-t="foot">Verbonden met "Fyzzy-Bridge-Setup" · Fyzzy Health &amp; Performance Platform</div>
</div>
<script>
const T = {
  nl: { title:"WiFi instellen", intro:"Kies het WiFi-netwerk van de praktijk en vul het wachtwoord in. Het kastje verbindt dan met internet en komt online in Fyzzy.",
    network:"Netwerk", ssidManual:"Netwerknaam (SSID)", password:"Wachtwoord", show:"toon", hide:"verberg", connect:"Verbinden",
    scanning:"Scannen…", other:"Ander netwerk…", noNets:"Geen netwerken gevonden — tik ↻ of kies 'Ander netwerk'",
    connecting:"Verbinden met het netwerk…", success:"Verbonden — het kastje herstart en komt zo online in Fyzzy. Je kunt deze pagina sluiten.",
    wrong:"Verbinden mislukt. Controleer het wachtwoord en probeer opnieuw.", noInternet:"Verbonden met de WiFi, maar geen internet. Klopt het netwerk?",
    needSsid:"Kies of typ een netwerknaam.", foot:"Verbonden met \\"Fyzzy-Bridge-Setup\\" · Fyzzy Health & Performance Platform" },
  en: { title:"Set up WiFi", intro:"Pick the practice WiFi network and enter its password. The box will connect to the internet and come online in Fyzzy.",
    network:"Network", ssidManual:"Network name (SSID)", password:"Password", show:"show", hide:"hide", connect:"Connect",
    scanning:"Scanning…", other:"Other network…", noNets:"No networks found — tap ↻ or choose 'Other network'",
    connecting:"Connecting to the network…", success:"Connected — the box is restarting and will come online in Fyzzy shortly. You can close this page.",
    wrong:"Connection failed. Check the password and try again.", noInternet:"Connected to WiFi but no internet. Is this the right network?",
    needSsid:"Choose or type a network name.", foot:"Connected to \\"Fyzzy-Bridge-Setup\\" · Fyzzy Health & Performance Platform" }
};
let lang = "nl";
const $ = (id) => document.getElementById(id);
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-t]").forEach(el => { const k = el.getAttribute("data-t"); if (T[lang][k]) el.textContent = T[lang][k]; });
  $("toggle").textContent = $("password").type === "password" ? T[lang].show : T[lang].hide;
  document.querySelectorAll(".lang button").forEach(b => b.classList.toggle("on", b.dataset.lang === lang));
}
document.querySelectorAll(".lang button").forEach(b => b.onclick = () => { lang = b.dataset.lang; applyLang(); refreshManual(); });
$("toggle").onclick = () => { const p = $("password"); p.type = p.type === "password" ? "text" : "password"; applyLang(); };

function refreshManual() {
  const manual = $("ssid").value === "__other__";
  $("ssidManual").style.display = manual ? "block" : "none";
  $("manualLabel").style.display = manual ? "block" : "none";
}
$("ssid").onchange = refreshManual;

async function scan() {
  const sel = $("ssid");
  sel.innerHTML = '<option value="">' + T[lang].scanning + '</option>';
  try {
    const r = await fetch("/scan"); const d = await r.json();
    sel.innerHTML = "";
    if (!d.networks || d.networks.length === 0) {
      const o = document.createElement("option"); o.value = ""; o.textContent = T[lang].noNets; sel.appendChild(o);
    }
    (d.networks || []).forEach(n => {
      const o = document.createElement("option"); o.value = n.ssid;
      const lock = (n.security && n.security !== "open") ? " 🔒" : "";
      o.textContent = n.ssid + lock + "  (" + n.signal + "%)"; sel.appendChild(o);
    });
    const other = document.createElement("option"); other.value = "__other__"; other.textContent = T[lang].other; sel.appendChild(other);
  } catch (e) {
    sel.innerHTML = '<option value="__other__">' + T[lang].other + '</option>';
  }
  refreshManual();
}
$("refresh").onclick = scan;

function setStatus(kind, html) { const s = $("status"); s.className = "status show " + kind; s.innerHTML = html; }

$("connect").onclick = async () => {
  const ssid = $("ssid").value === "__other__" ? $("ssidManual").value.trim() : $("ssid").value;
  const password = $("password").value;
  if (!ssid) { setStatus("err", T[lang].needSsid); return; }
  $("connect").disabled = true;
  setStatus("info", '<span class="spin"></span>' + T[lang].connecting);
  try {
    const r = await fetch("/connect", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ ssid, password }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) { setStatus("ok", T[lang].success); return; }
    setStatus("err", d.error === "no_internet" ? T[lang].noInternet : T[lang].wrong);
  } catch (e) {
    // Expected: the radio switched to the client network, so this page's socket drops.
    setStatus("ok", T[lang].success);
  } finally { $("connect").disabled = false; }
};

applyLang(); scan();
</script>
</body>
</html>`;
