import React, { useState, useEffect, useRef } from "react";

/* ═══════════════════════ Backend wiring ═════════════════════════════════
 * MOCK_MODE=true  → runs standalone with simulated data (no backend needed).
 * MOCK_MODE=false → talks to the real SwitchDex backend via the api client.
 *
 * For production: set MOCK_MODE=false. Base URL is same-origin "/api" (Caddy
 * proxies it); override with window.SWITCHDEX_API = "https://nms.example.com".
 * The standalone version of this client ships as src/api.js.
 * ════════════════════════════════════════════════════════════════════════ */
// Production build: no demo mode. MOCK_MODE is permanently false, so the
// bundler eliminates every `if (MOCK_MODE)` branch and the demo helpers as
// dead code. The app always talks to the real backend at /api.
const MOCK_MODE = false;

const _API_BASE = (typeof window !== "undefined" && window.SWITCHDEX_API) || "";
let _token = null;
function _loadTok() { if (_token) return _token; try { _token = localStorage.getItem("of_token"); } catch { _token = null; } return _token; }
function _setTok(t) { _token = t; try { t ? localStorage.setItem("of_token", t) : localStorage.removeItem("of_token"); } catch {} }

async function _req(path, { method = "GET", body, form, timeoutMs = 30000 } = {}) {
  const headers = {}; const tok = _loadTok();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  let payload;
  if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${_API_BASE}/api${path}`, { method, headers, body: payload, signal: ctl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out — the device or backend did not respond.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) { _setTok(null); window.dispatchEvent(new Event("of-unauthorized")); throw new Error("Unauthorized"); }
  if (!res.ok) { let d = res.statusText; try { d = (await res.json()).detail || d; } catch {} throw new Error(d); }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

const api = {
  login: async (u, p) => { const d = await _req("/auth/login", { method: "POST", form: { username: u, password: p } }); _setTok(d.access_token); return d; },
  logout: () => _setTok(null),
  me: () => _req("/auth/me"),
  changePassword: (oldPw, newPw) => _req("/auth/change-password", { method: "POST", body: { old_password: oldPw, new_password: newPw } }),
  listDevices: () => _req("/devices"),
  probeDevice: (b) => _req("/devices/probe", { method: "POST", body: b }),
  addDevice: (d) => _req("/devices", { method: "POST", body: d }),
  deleteDevice: (id) => _req(`/devices/${id}`, { method: "DELETE" }),
  deviceInterfaces: (id) => _req(`/devices/${id}/interfaces`),
  editDevice: (id, patch) => _req(`/devices/${id}`, { method: "PATCH", body: patch }),
  previewIface: (id, ifname, cfg) => _req(`/devices/${id}/interfaces/${encodeURIComponent(ifname)}/preview`, { method: "POST", body: cfg }),
  applyIface: (id, ifname, cfg) => _req(`/devices/${id}/interfaces/${encodeURIComponent(ifname)}/apply`, { method: "POST", body: cfg, timeoutMs: 45000 }),
  listConfigs: (id) => _req(`/devices/${id}/configs`),
  getConfig: (id, vid) => _req(`/devices/${id}/configs/${vid}`),
  diffConfigs: (id, a, b) => _req(`/devices/${id}/configs/diff?a=${a}&b=${b}`),
  backupDevice: (id) => _req(`/devices/${id}/backup`, { method: "POST", timeoutMs: 60000 }),
  restoreConfig: (id, vid) => _req(`/devices/${id}/restore/${vid}`, { method: "POST", timeoutMs: 150000 }),
  backupAll: () => _req("/backup-all", { method: "POST", timeoutMs: 180000 }),
  listControllers: () => _req("/integrations"),
  addController: (b) => _req("/integrations", { method: "POST", body: b }),
  testController: (b) => _req("/integrations/test", { method: "POST", body: b }),
  syncController: (id) => _req(`/integrations/${id}/sync`, { method: "POST" }),
  deleteController: (id) => _req(`/integrations/${id}`, { method: "DELETE" }),
  deviceMetrics: (id) => _req(`/integrations/devices/${id}/metrics`),
  getTopology: () => _req("/topology"),
  discoverTopology: () => _req("/topology/discover", { method: "POST" }),
  listAlerts: (state="") => _req(`/alerts${state?`?state=${state}`:""}`),
  alertSummary: () => _req("/alerts/summary"),
  ackAlert: (id) => _req(`/alerts/${id}/ack`, { method: "POST" }),
  resolveAlert: (id) => _req(`/alerts/${id}/resolve`, { method: "POST" }),
  listRules: () => _req("/alerts/rules"),
  addRule: (b) => _req("/alerts/rules", { method: "POST", body: b }),
  updateRule: (id, b) => _req(`/alerts/rules/${id}`, { method: "PUT", body: b }),
  deleteRule: (id) => _req(`/alerts/rules/${id}`, { method: "DELETE" }),
  listChannels: () => _req("/alerts/channels"),
  addChannel: (b) => _req("/alerts/channels", { method: "POST", body: b }),
  updateChannel: (id, b) => _req(`/alerts/channels/${id}`, { method: "PUT", body: b }),
  deleteChannel: (id) => _req(`/alerts/channels/${id}`, { method: "DELETE" }),
  testChannel: (b) => _req("/alerts/channels/test", { method: "POST", body: b }),
  compliance: () => _req("/compliance"),
  complianceDevice: (id) => _req(`/compliance/devices/${id}`),
  listPolicies: () => _req("/compliance/policies"),
  createPolicy: (p) => _req("/compliance/policies", { method: "POST", body: p }),
  updatePolicy: (id, p) => _req(`/compliance/policies/${id}`, { method: "PUT", body: p }),
  deletePolicy: (id) => _req(`/compliance/policies/${id}`, { method: "DELETE" }),
  pinBaseline: (did, vid) => _req(`/compliance/baselines/${did}/pin/${vid}`, { method: "POST" }),
  unpinBaseline: (did) => _req(`/compliance/baselines/${did}`, { method: "DELETE" }),
  baselineDrift: (id) => _req(`/compliance/devices/${id}/drift`),
  metric: (id, metric, range="24h", label="") => _req(`/metrics/devices/${id}?metric=${metric}&range=${range}${label?`&label=${encodeURIComponent(label)}`:""}`),
  metricInterfaces: (id, range="24h") => _req(`/metrics/devices/${id}/interfaces?range=${range}`),
  metricSummary: (id) => _req(`/metrics/devices/${id}/summary`),
  fleetSummary: () => _req("/metrics/fleet-summary"),
  connectSSH: (id) => {
    const tok = _loadTok();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const host = _API_BASE ? _API_BASE.replace(/^https?:\/\//, "") : location.host;
    return new WebSocket(`${scheme}://${host}/ws/ssh/${id}?token=${encodeURIComponent(tok || "")}`);
  },
};

// Backend devices (from _dev_out) omit nested collections like interfaces/vlans
// to keep the list payload small. Fill in safe empty defaults so the detail
// panel's Object.entries/keys calls never hit undefined/null.
function normalizeDevice(d) {
  return {
    cpu: 0, mem: 0, uptime: "—",
    ospfNets: [], staticRoutes: [], ntpServers: [],
    ...d,
    interfaces: d.interfaces || {}, vlans: d.vlans || {},
    bgpPeers: d.bgpPeers || [], aclDefs: d.aclDefs || {},
  };
}


const FONTS = `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');`;

/* ───────────────────────── CSS ─────────────────────────────────────── */
const css = `
${FONTS}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#0d1117;color:#e6edf3;}
::-webkit-scrollbar{width:6px;height:6px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px;}
.app{display:flex;height:100vh;overflow:hidden;position:relative;}
.sidebar{width:52px;background:#010409;border-right:1px solid #21262d;display:flex;flex-direction:column;align-items:center;padding:12px 0;gap:4px;flex-shrink:0;}
.sb-logo{width:36px;height:36px;background:#1f6feb;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-bottom:8px;}
.sb-item{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#8b949e;transition:all .15s;position:relative;}
.sb-item:hover{background:#21262d;color:#e6edf3;}
.sb-item.active{background:#1f6feb22;color:#58a6ff;}
.sb-badge{position:absolute;top:3px;right:3px;width:8px;height:8px;background:#f85149;border-radius:50%;border:2px solid #010409;}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.topbar{height:48px;background:#010409;border-bottom:1px solid #21262d;display:flex;align-items:center;padding:0 16px;gap:10px;flex-shrink:0;}
.topbar-title{font-size:14px;font-weight:600;color:#e6edf3;flex:1;letter-spacing:.02em;}
.topbar-title span{color:#58a6ff;}
.tb-btn{display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #30363d;background:#21262d;color:#e6edf3;transition:all .15s;font-family:inherit;}
.tb-btn:hover{background:#30363d;border-color:#8b949e;}
.tb-btn.primary{background:#238636;border-color:#2ea043;color:#fff;}
.tb-btn.primary:hover{background:#2ea043;}
.content{flex:1;display:flex;overflow:hidden;}
.left-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
.toolbar{padding:10px 14px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;background:#0d1117;flex-shrink:0;}
.search-wrap{position:relative;flex:1;max-width:300px;}
.search-wrap svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:13px;height:13px;color:#8b949e;}
.search-input{width:100%;background:#010409;border:1px solid #30363d;border-radius:6px;padding:6px 9px 6px 30px;font-size:13px;color:#e6edf3;font-family:inherit;outline:none;}
.search-input:focus{border-color:#58a6ff;}
.search-input::placeholder{color:#484f58;}
.fbtn{padding:5px 9px;border-radius:5px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #30363d;background:transparent;color:#8b949e;transition:all .15s;font-family:inherit;}
.fbtn:hover,.fbtn.on{background:#21262d;color:#e6edf3;border-color:#58a6ff;}
.stat-row{margin-left:auto;display:flex;gap:14px;}
.chip{font-size:12px;display:flex;align-items:center;gap:5px;color:#8b949e;}
.cdot{width:7px;height:7px;border-radius:50%;}
.tbl-wrap{flex:1;overflow-y:auto;}
table{width:100%;border-collapse:collapse;}
thead th{position:sticky;top:0;background:#010409;padding:7px 12px;text-align:left;font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #21262d;white-space:nowrap;}
tbody tr{border-bottom:1px solid #161b22;cursor:pointer;transition:background .1s;}
tbody tr:hover{background:#161b22;}
tbody tr.sel{background:#1f6feb14;border-left:2px solid #58a6ff;}
tbody td{padding:9px 12px;font-size:13px;vertical-align:middle;}
.dc{display:flex;align-items:center;gap:8px;}
.di{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.sbadge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:20px;font-size:11px;font-weight:500;}
.sbadge.up{background:#1a3e2a;color:#3fb950;}
.sbadge.down{background:#3d1a1a;color:#f85149;}
.sbadge.warn{background:#3d2e1a;color:#e3b341;}
.ptag{display:inline-flex;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:500;font-family:'IBM Plex Mono',monospace;}
.ptag.netconf{background:#1a3e2a;color:#3fb950;}
.ptag.gnmi{background:#2e1a3e;color:#bc8cff;}
.ptag.restconf{background:#1a2e3e;color:#58a6ff;}
.ptag.snmp{background:#3d2e1a;color:#e3b341;}
.ptag.ssh{background:#1a3a3e;color:#39d353;}
.ptag.unifi{background:#13243e;color:#4a9eff;}
.ptag.omada{background:#2e2410;color:#e8a317;}
.ro-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:600;background:#21262d;color:#8b949e;border:1px solid #30363d;}
.ro-banner{display:flex;align-items:center;gap:9px;background:#13243e;border:1px solid #1d3a5f;border-radius:8px;padding:10px 13px;font-size:12px;color:#9cc4f0;}
.ro-banner svg{flex-shrink:0;color:#4a9eff;}
.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.metric-card{background:#0d1117;border:1px solid #21262d;border-radius:7px;padding:9px 11px;}
.metric-label{font-size:11px;color:#8b949e;margin-bottom:3px;}
.metric-val{font-size:18px;font-weight:600;color:#e6edf3;}
.metric-unit{font-size:11px;color:#8b949e;font-weight:400;}
.mono{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#8b949e;}
.row-acts{display:flex;gap:5px;opacity:0;transition:opacity .15s;}
tbody tr:hover .row-acts{opacity:1;}
.act{width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;border:1px solid #30363d;background:#21262d;cursor:pointer;color:#8b949e;transition:all .15s;}
.act:hover{background:#30363d;color:#e6edf3;}
.act.term:hover{background:#1a3a3e;color:#39d353;border-color:#39d353;}
.rpanel{width:560px;border-left:1px solid #21262d;display:flex;flex-direction:column;background:#010409;flex-shrink:0;}
.rpanel.hidden{width:0;overflow:hidden;border:none;}
.content.full .left-pane{display:none;}
.content.full .rpanel{width:100%;border-left:none;}
.content.full .rpanel.hidden{width:100%;}
.pback:hover{text-decoration:underline;}
.ptabs{display:flex;border-bottom:1px solid #21262d;flex-shrink:0;align-items:center;}
.ptab{padding:9px 14px;font-size:12px;font-weight:500;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s;}
.ptab.active{color:#58a6ff;border-bottom-color:#58a6ff;}
.ptab:hover{color:#e6edf3;}
.pclose{margin-left:auto;padding:0 12px;display:flex;align-items:center;color:#8b949e;cursor:pointer;}
.pclose:hover{color:#e6edf3;}
.dpane{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:13px;}
.dhdr{display:flex;align-items:flex-start;gap:10px;}
.dname{font-size:15px;font-weight:600;color:#e6edf3;}
.dsub{font-size:11px;color:#8b949e;margin-top:2px;font-family:'IBM Plex Mono',monospace;}
.sec-title{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;display:flex;align-items:center;justify-content:space-between;}
.dgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.dkv{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:7px 9px;}
.dkv-k{font-size:11px;color:#8b949e;margin-bottom:2px;}
.dkv-v{font-size:12px;font-weight:500;color:#e6edf3;font-family:'IBM Plex Mono',monospace;}
.irow{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:5px;background:#0d1117;border:1px solid #21262d;margin-bottom:4px;font-size:12px;cursor:pointer;transition:border-color .12s,background .12s;}
.irow:hover{border-color:#58a6ff;background:#0f1622;}
.iname{font-family:'IBM Plex Mono',monospace;font-weight:500;color:#e6edf3;flex:1;font-size:11px;}
.vtag{background:#1a2e3e;color:#58a6ff;border-radius:4px;padding:1px 6px;font-size:11px;font-family:'IBM Plex Mono',monospace;margin-right:3px;}
.dbtn{width:100%;padding:7px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #238636;background:#238636;color:#fff;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:7px;transition:background .15s;}
.dbtn:hover{background:#2ea043;}

/* ── Switch faceplate ── */
.faceplate{background:linear-gradient(180deg,#1c2128,#13171c);border:1px solid #30363d;border-radius:9px;padding:9px 11px;}
.fp-top{display:flex;align-items:center;gap:8px;margin-bottom:9px;}
.fp-brand{font-size:11px;font-weight:600;color:#cdd9e5;letter-spacing:.03em;}
.fp-model{font-size:10px;color:#6e7681;font-family:'IBM Plex Mono',monospace;}
.fp-sysleds{margin-left:auto;display:flex;gap:9px;}
.fp-sysled{display:flex;flex-direction:column;align-items:center;gap:2px;}
.fp-sysled .lbl{font-size:8px;color:#6e7681;letter-spacing:.05em;}
.fp-sysled .led{width:7px;height:7px;border-radius:50%;}
.fp-body{display:flex;align-items:flex-end;gap:10px;}
.fp-ports{display:flex;flex-direction:column;gap:3px;}
.fp-prow{display:flex;gap:3px;}
.port{width:23px;height:17px;border-radius:2px;background:#0a0d11;border:1px solid #2d333b;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;position:relative;transition:all .1s;padding-bottom:1px;}
.port:hover{border-color:#58a6ff;}
.port.sel{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff,0 0 6px #58a6ff66;background:#0d1d2e;}
.port .led{position:absolute;top:2px;width:5px;height:3px;border-radius:1px;}
.port.up .led{background:#3fb950;box-shadow:0 0 3px #3fb95099;}
.port.down .led{background:#484f58;}
.port.admin .led{background:#f85149;}
.port .pnum{font-size:7px;color:#8b949e;font-family:'IBM Plex Mono',monospace;line-height:1;}
.port.fiber{background:#0a0f14;border-color:#2e3a44;}
.port.fiber .pnum{color:#58a6ff;}
.fp-zone-div{width:1px;align-self:stretch;background:#30363d;margin:0 2px;}
.fp-zone-lbl{font-size:8px;color:#6e7681;text-align:center;margin-top:3px;letter-spacing:.04em;}
.fp-legend{display:flex;gap:12px;margin-top:9px;padding-top:8px;border-top:1px solid #21262d;}
.fp-leg-item{display:flex;align-items:center;gap:4px;font-size:10px;color:#8b949e;}
.fp-leg-dot{width:7px;height:7px;border-radius:1px;}

/* ── Interface editor ── */
.ed-back{display:flex;align-items:center;gap:6px;font-size:12px;color:#58a6ff;cursor:pointer;font-weight:500;}
.ed-back:hover{color:#79c0ff;}
.ed-title{font-size:15px;font-weight:600;color:#e6edf3;font-family:'IBM Plex Mono',monospace;}
.ed-field{margin-bottom:13px;}
.ed-label{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;display:block;}
.ed-input,.ed-select{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:7px 9px;font-size:13px;color:#e6edf3;font-family:'IBM Plex Mono',monospace;outline:none;}
.ed-input:focus,.ed-select:focus{border-color:#58a6ff;}
.ed-input::placeholder{color:#484f58;}
.seg{display:flex;border:1px solid #30363d;border-radius:7px;overflow:hidden;}
.seg-btn{flex:1;padding:7px;font-size:12px;font-weight:500;cursor:pointer;background:transparent;border:none;color:#8b949e;font-family:inherit;transition:all .12s;}
.seg-btn.on{background:#1f6feb;color:#fff;}
.seg-btn:not(.on):hover{background:#21262d;color:#e6edf3;}
.tgl-row{display:flex;align-items:center;justify-content:space-between;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:9px 11px;}
.tgl-label{font-size:13px;font-weight:500;}
.tgl{width:38px;height:22px;border-radius:11px;background:#30363d;position:relative;cursor:pointer;transition:background .15s;flex-shrink:0;}
.tgl.on{background:#238636;}
.tgl::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;}
.tgl.on::after{left:18px;}
.frow2{display:grid;grid-template-columns:2fr 1fr;gap:8px;}
.cli-preview{background:#020407;border:1px solid #21262d;border-radius:7px;padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.6;}
.cli-preview .cl{white-space:pre-wrap;}
.cli-preview .cl.h{color:#58a6ff;}
.cli-preview .cl.b{color:#cdd9e5;padding-left:8px;}
.cli-preview .cl.neg{color:#f85149;padding-left:8px;}
.ed-actions{display:flex;gap:8px;margin-top:4px;}
.ed-btn{flex:1;padding:8px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:6px;}
.ed-btn.apply{background:#238636;border:1px solid #2ea043;color:#fff;}.ed-btn.apply:hover{background:#2ea043;}
.ed-btn.reset{background:transparent;border:1px solid #30363d;color:#8b949e;}.ed-btn.reset:hover{background:#21262d;color:#e6edf3;}
.ed-btn.ssh{flex:0 0 auto;background:transparent;border:1px solid #39d35355;color:#39d353;}.ed-btn.ssh:hover{background:#1a3a3e;}
.saved-toast{background:#1a3e2a;border:1px solid #238636;color:#3fb950;border-radius:6px;padding:8px 11px;font-size:12px;display:flex;align-items:center;gap:7px;font-weight:500;}

/* ── SSH terminal ── */
.ssh-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.ssh-hdr{padding:7px 12px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:7px;flex-shrink:0;min-height:38px;}
.ssh-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.ssh-st{font-size:12px;color:#8b949e;flex:1;font-family:'IBM Plex Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mode-pill{font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;font-family:'IBM Plex Mono',monospace;letter-spacing:.04em;flex-shrink:0;}
.mode-pill.exec{background:#1a3e2a;color:#3fb950;}
.mode-pill.config{background:#1a2e3e;color:#58a6ff;}
.mode-pill.sub{background:#2e1a3e;color:#bc8cff;}
.mode-pill.line{background:#3d2e1a;color:#e3b341;}
.scb{padding:3px 9px;border-radius:5px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid;background:transparent;font-family:inherit;transition:background .15s;flex-shrink:0;}
.scb.conn{border-color:#238636;color:#3fb950;}.scb.conn:hover{background:#1a3e2a;}
.scb.disc{border-color:#f85149;color:#f85149;}.scb.disc:hover{background:#3d1a1a;}
.terminal{flex:1;overflow-y:auto;padding:9px 12px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;line-height:1.65;background:#020407;}
.tl{white-space:pre-wrap;word-break:break-all;}
.tl.sys{color:#3d4451;}.tl.prompt{color:#39d353;}.tl.prompt.c{color:#58a6ff;}.tl.prompt.s{color:#bc8cff;}
.tl.out{color:#cdd9e5;}.tl.err{color:#f85149;}.tl.warn{color:#e3b341;}.tl.ok{color:#3fb950;}.tl.info{color:#58a6ff;}.tl.dim{color:#484f58;}
.tin-row{display:flex;align-items:center;padding:7px 12px;background:#020407;border-top:1px solid #21262d;flex-shrink:0;gap:5px;}
.tprompt{font-family:'IBM Plex Mono',monospace;font-size:12.5px;white-space:nowrap;flex-shrink:0;}
.tinput{flex:1;background:transparent;border:none;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#e6edf3;outline:none;caret-color:#39d353;}
.tinput:disabled{opacity:.3;}

/* ── Add device modal ── */
.overlay{position:absolute;inset:0;background:rgba(1,4,9,.88);display:flex;align-items:center;justify-content:center;z-index:200;}
.qv-scrim{position:absolute;inset:0;background:rgba(1,4,9,.35);z-index:210;}
.qv-drawer{position:absolute;top:0;right:0;bottom:0;width:340px;background:#0d1117;border-left:1px solid #30363d;box-shadow:-8px 0 24px rgba(0,0,0,.4);z-index:211;display:flex;flex-direction:column;animation:qv-in .18s ease-out;}
@keyframes qv-in{from{transform:translateX(20px);opacity:.4;}to{transform:translateX(0);opacity:1;}}
.qv-hdr{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;border-bottom:1px solid #21262d;}
.qv-name{font-weight:600;color:#e6edf3;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qv-x{cursor:pointer;color:#8b949e;display:flex;align-items:center;flex-shrink:0;}
.qv-x:hover{color:#e6edf3;}
.qv-body{flex:1;overflow-y:auto;padding:14px;}
.qv-footer{padding:12px 14px;border-top:1px solid #21262d;}
.modal{background:#161b22;border:1px solid #30363d;border-radius:12px;width:460px;overflow:hidden;}
.modal-hdr{padding:18px 20px 0;display:flex;align-items:flex-start;justify-content:space-between;}
.modal-title{font-size:15px;font-weight:600;color:#e6edf3;}
.modal-sub{font-size:12px;color:#8b949e;margin-top:3px;}
.modal-body{padding:16px 20px;}
.modal-footer{padding:0 20px 18px;display:flex;gap:8px;}
.flabel{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;display:block;}
.finput{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;font-size:13px;color:#e6edf3;font-family:'IBM Plex Mono',monospace;outline:none;margin-bottom:12px;}
.finput:focus{border-color:#58a6ff;}
.finput::placeholder{color:#484f58;}
.auth-tabs{display:flex;margin-bottom:14px;border:1px solid #30363d;border-radius:7px;overflow:hidden;}
.auth-tab{flex:1;padding:6px 10px;font-size:12px;font-weight:500;cursor:pointer;background:transparent;border:none;color:#8b949e;font-family:inherit;transition:all .15s;}
.auth-tab.on{background:#1f6feb;color:#fff;}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.frow .finput{margin-bottom:0;}
.mbtn{flex:1;padding:8px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:background .15s;}
.mbtn.cancel{background:transparent;border:1px solid #30363d;color:#8b949e;}.mbtn.cancel:hover{background:#21262d;}
.mbtn.go{background:#238636;border:1px solid #2ea043;color:#fff;}.mbtn.go:hover{background:#2ea043;}
.mbtn.add{background:#1f6feb;border:1px solid #388bfd;color:#fff;}.mbtn.add:hover{background:#388bfd;}
.mbtn:disabled{opacity:.4;cursor:not-allowed;}
.probe-log{background:#020407;border-radius:6px;padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;margin-bottom:14px;max-height:180px;overflow-y:auto;border:1px solid #21262d;}
.pl{white-space:pre;}
.pl.sys{color:#484f58;}.pl.ok{color:#3fb950;}.pl.info{color:#58a6ff;}.pl.err{color:#f85149;}
.pl.spin::before{content:"⠋ ";animation:spin .8s steps(8) infinite;}
@keyframes spin{0%{content:"⠋ ";}12.5%{content:"⠙ ";}25%{content:"⠹ ";}37.5%{content:"⠸ ";}50%{content:"⠼ ";}62.5%{content:"⠴ ";}75%{content:"⠦ ";}87.5%{content:"⠧ ";}}
@keyframes sdx-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
.discovered-card{background:#0d1117;border:1px solid #238636;border-radius:8px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:12px;}
.disc-info{flex:1;}
.disc-name{font-size:14px;font-weight:600;color:#e6edf3;}
.disc-meta{font-size:11px;color:#8b949e;font-family:'IBM Plex Mono',monospace;margin-top:2px;}
.disc-vendor{font-size:12px;color:#3fb950;font-weight:500;margin-top:2px;}
.prog-bar{height:3px;background:#21262d;border-radius:2px;overflow:hidden;margin-bottom:10px;}
.prog-fill{height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff);border-radius:2px;}

/* ── Config archive ── */
.cfg-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:11px;flex-wrap:wrap;}
.cfg-btn{display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-family:inherit;transition:all .15s;}
.cfg-btn:hover{background:#30363d;border-color:#8b949e;}
.cfg-btn.primary{background:#1f6feb;border-color:#388bfd;color:#fff;}.cfg-btn.primary:hover{background:#388bfd;}
.cfg-btn:disabled{opacity:.4;cursor:not-allowed;}
.ver-row{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:7px;background:#0d1117;border:1px solid #21262d;margin-bottom:6px;transition:border-color .12s;}
.ver-row:hover{border-color:#30363d;}
.ver-row.current{border-color:#23863666;background:#0e1512;}
.ver-cb{width:15px;height:15px;border-radius:4px;border:1px solid #30363d;background:#010409;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#58a6ff;}
.ver-cb.on{background:#1f6feb;border-color:#1f6feb;color:#fff;}
.ver-meta{flex:1;min-width:0;}
.ver-when{font-size:13px;font-weight:500;color:#e6edf3;display:flex;align-items:center;gap:7px;}
.ver-sub{font-size:11px;color:#8b949e;font-family:'IBM Plex Mono',monospace;margin-top:2px;}
.trigger-tag{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;letter-spacing:.03em;}
.trigger-tag.scheduled{background:#1a2e3e;color:#58a6ff;}
.trigger-tag.change-detected{background:#3d2e1a;color:#e3b341;}
.trigger-tag.manual{background:#1a3e2a;color:#3fb950;}
.trigger-tag.restore{background:#2e1a3e;color:#bc8cff;}
.ver-acts{display:flex;gap:5px;flex-shrink:0;}
.va{width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;border:1px solid #30363d;background:#161b22;cursor:pointer;color:#8b949e;transition:all .15s;}
.va:hover{background:#30363d;color:#e6edf3;}
.va.restore-a:hover{background:#2e1a3e;color:#bc8cff;border-color:#bc8cff;}
.cfg-view{background:#020407;border:1px solid #21262d;border-radius:7px;padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.55;max-height:340px;overflow:auto;}
.cfg-view .cv{white-space:pre;color:#cdd9e5;}
.cfg-view .cv .ln{display:inline-block;width:30px;color:#3d4451;user-select:none;text-align:right;margin-right:10px;}
.diff-view{background:#020407;border:1px solid #21262d;border-radius:7px;padding:0;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.55;max-height:360px;overflow:auto;}
.dv{white-space:pre;padding:1px 10px;display:flex;}
.dv .gut{width:18px;flex-shrink:0;text-align:center;color:#3d4451;}
.dv.add{background:#11261a;color:#3fb950;}
.dv.del{background:#2a1416;color:#f85149;}
.dv.ctx{color:#8b949e;}
.dv.add .gut{color:#3fb950;}
.dv.del .gut{color:#f85149;}
.dv.hunk{background:#1a1230;color:#bc8cff;}
.dv.hunk .gut{color:#bc8cff;}
.diff-hdr{display:flex;align-items:center;gap:10px;font-size:12px;color:#8b949e;margin-bottom:9px;font-family:'IBM Plex Mono',monospace;}
.diff-hdr .pm{font-weight:600;}
.diff-hdr .plus{color:#3fb950;}.diff-hdr .minus{color:#f85149;}
.cfg-empty{text-align:center;padding:30px 14px;color:#6e7681;font-size:13px;}
.cfg-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:7px;font-size:12px;line-height:1.5;margin-bottom:11px;}
.cfg-banner .bx{margin-left:auto;cursor:pointer;opacity:.7;flex-shrink:0;}
.cfg-banner .bx:hover{opacity:1;}
.cfg-banner.ok{background:#1a3e2a;border:1px solid #2ea04355;color:#3fb950;}
.cfg-banner.warn{background:#3d2e1a;border:1px solid #e3b34155;color:#e3b341;}
.cfg-banner.err{background:#3d1a1a;border:1px solid #f8514955;color:#f85149;}
.cfg-loading{display:flex;align-items:center;gap:9px;padding:24px 14px;color:#8b949e;font-size:13px;justify-content:center;}
.cfg-spin{width:15px;height:15px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:cfgspin .7s linear infinite;flex-shrink:0;}
@keyframes cfgspin{to{transform:rotate(360deg);}}

/* ── Fleet config-mgmt view ── */
.fleet-wrap{flex:1;overflow-y:auto;padding:16px;}
.fleet-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
.fkpi{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:13px 15px;}
.fkpi-label{font-size:11px;color:#8b949e;margin-bottom:5px;}
.fkpi-val{font-size:24px;font-weight:600;color:#e6edf3;}
.fkpi-sub{font-size:11px;margin-top:3px;}
.sched-bar{display:flex;align-items:center;gap:12px;background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:11px 15px;margin-bottom:16px;}
.sched-info{flex:1;}
.sched-title{font-size:13px;font-weight:600;color:#e6edf3;display:flex;align-items:center;gap:7px;}
.sched-sub{font-size:11px;color:#8b949e;margin-top:2px;}
.fleet-tbl-card{background:#0d1117;border:1px solid #21262d;border-radius:8px;overflow:hidden;}
.fleet-tbl-hdr{padding:11px 15px;border-bottom:1px solid #21262d;display:flex;align-items:center;}
.fleet-tbl-hdr .t{font-size:13px;font-weight:600;color:#e6edf3;flex:1;}
.fleet-row{display:flex;align-items:center;gap:12px;padding:10px 15px;border-bottom:1px solid #161b22;cursor:pointer;transition:background .1s;}
.fleet-row:last-child{border-bottom:none;}
.fleet-row:hover{background:#161b22;}
.fr-name{font-weight:500;color:#e6edf3;font-size:13px;}
.fr-meta{font-size:11px;color:#8b949e;font-family:'IBM Plex Mono',monospace;}
.bk-status{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500;}
.bk-status.ok{background:#1a3e2a;color:#3fb950;}
.bk-status.changed{background:#3d2e1a;color:#e3b341;}
.bk-status.failed{background:#3d1a1a;color:#f85149;}

/* ── Login ── */
.login-wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0d1117;}
.login-card{width:360px;background:#161b22;border:1px solid #30363d;border-radius:14px;padding:30px 28px;}
.login-logo{width:48px;height:48px;background:#1f6feb;border-radius:11px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}
.login-logo svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;}
.login-title{font-size:19px;font-weight:600;color:#e6edf3;text-align:center;}
.login-title span{color:#58a6ff;}
.login-sub{font-size:12px;color:#8b949e;text-align:center;margin-top:4px;margin-bottom:22px;}
.login-label{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;display:block;}
.login-input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:9px 11px;font-size:14px;color:#e6edf3;font-family:inherit;outline:none;margin-bottom:14px;}
.login-input:focus{border-color:#58a6ff;}
.login-btn{width:100%;padding:10px;border-radius:7px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid #2ea043;background:#238636;color:#fff;font-family:inherit;transition:background .15s;}
.login-btn:hover{background:#2ea043;}
.login-btn:disabled{opacity:.5;cursor:not-allowed;}
.login-err{background:#3d1a1a;border:1px solid #f8514955;color:#f85149;border-radius:7px;padding:9px 11px;font-size:12px;margin-bottom:14px;}
.login-foot{font-size:11px;color:#6e7681;text-align:center;margin-top:16px;line-height:1.5;}

/* ── topbar user chip ── */
.user-chip{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:7px;border:1px solid #30363d;background:#161b22;cursor:pointer;}
.user-chip:hover{background:#21262d;}
.user-av{width:24px;height:24px;border-radius:50%;background:#1f6feb;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;}
.user-name{font-size:12px;color:#e6edf3;font-weight:500;}
.user-role{font-size:10px;color:#8b949e;}

/* ── settings ── */
.settings-wrap{flex:1;overflow-y:auto;padding:20px;}
.set-section{background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:18px 20px;margin-bottom:16px;max-width:680px;}
.set-h{font-size:14px;font-weight:600;color:#e6edf3;margin-bottom:4px;display:flex;align-items:center;gap:8px;}
.set-desc{font-size:12px;color:#8b949e;margin-bottom:16px;}
.set-field{margin-bottom:13px;}
.set-label{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;display:block;}
.set-input,.set-select{width:100%;background:#010409;border:1px solid #30363d;border-radius:6px;padding:8px 10px;font-size:13px;color:#e6edf3;font-family:'IBM Plex Mono',monospace;outline:none;}
.set-input:focus{border-color:#58a6ff;}
.set-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.set-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #21262d;margin-bottom:14px;}
.u-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:7px;background:#010409;border:1px solid #21262d;margin-bottom:6px;}
.u-av{width:30px;height:30px;border-radius:50%;background:#1a2e3e;color:#58a6ff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;}
.u-name{font-weight:500;color:#e6edf3;font-size:13px;flex:1;}
.role-tag{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;}
.role-tag.admin{background:#3d1a1a;color:#f85149;}
.role-tag.operator{background:#1a3e2a;color:#3fb950;}
.role-tag.viewer{background:#1a2e3e;color:#58a6ff;}
.src-tag{font-size:10px;padding:2px 7px;border-radius:4px;background:#21262d;color:#8b949e;}
.set-btn{padding:7px 13px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-family:inherit;transition:all .15s;}
.set-btn:hover{background:#30363d;}
.set-btn.primary{background:#238636;border-color:#2ea043;color:#fff;}.set-btn.primary:hover{background:#2ea043;}
.set-btn.test{background:#1a2e3e;border-color:#388bfd;color:#58a6ff;}.set-btn.test:hover{background:#1f3a52;}
.test-result{font-size:12px;padding:8px 11px;border-radius:6px;margin-top:10px;}
.test-result.ok{background:#1a3e2a;color:#3fb950;}
.test-result.fail{background:#3d1a1a;color:#f85149;}

/* ── Topology ── */
.topo-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;}
.topo-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;background:#0d1117;flex-shrink:0;}
.topo-seg{display:flex;border:1px solid #30363d;border-radius:7px;overflow:hidden;}
.topo-seg button{padding:6px 13px;font-size:12px;font-weight:500;cursor:pointer;background:transparent;border:none;color:#8b949e;font-family:inherit;transition:all .12s;}
.topo-seg button.on{background:#1f6feb;color:#fff;}
.topo-seg button:not(.on):hover{background:#21262d;color:#e6edf3;}
.topo-legend{margin-left:auto;display:flex;gap:14px;align-items:center;}
.topo-leg{display:flex;align-items:center;gap:5px;font-size:11px;color:#8b949e;}
.topo-leg-dot{width:9px;height:9px;border-radius:50%;}
.topo-canvas{flex:1;overflow:hidden;position:relative;background:radial-gradient(circle at 50% 40%,#0f141b,#0a0d12);}
.topo-node-label{font-size:10px;font-family:'IBM Plex Sans',sans-serif;fill:#cdd9e5;pointer-events:none;}
.topo-node-sub{font-size:8px;font-family:'IBM Plex Mono',monospace;fill:#6e7681;pointer-events:none;}
.topo-hint{position:absolute;bottom:12px;left:16px;font-size:11px;color:#484f58;font-family:'IBM Plex Mono',monospace;}

/* ── Alerts ── */
.alerts-wrap{flex:1;overflow-y:auto;padding:18px;}
.al-tabs{display:flex;gap:8px;margin-bottom:16px;}
.al-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
.al-kpi{background:#0d1117;border:1px solid #21262d;border-radius:9px;padding:13px 15px;}
.al-kpi-label{font-size:11px;color:#8b949e;margin-bottom:5px;}
.al-kpi-val{font-size:24px;font-weight:600;}
.al-card{background:#0d1117;border:1px solid #21262d;border-radius:9px;overflow:hidden;}
.al-row{display:flex;align-items:center;gap:12px;padding:11px 15px;border-bottom:1px solid #161b22;}
.al-row:last-child{border-bottom:none;}
.al-sev{width:4px;align-self:stretch;border-radius:2px;flex-shrink:0;}
.al-sev.critical{background:#f85149;}.al-sev.warning{background:#e3b341;}.al-sev.info{background:#58a6ff;}
.al-icon{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.al-icon.critical{background:#3d1a1a;color:#f85149;}.al-icon.warning{background:#3d2e1a;color:#e3b341;}.al-icon.info{background:#1a2e3e;color:#58a6ff;}
.al-body{flex:1;min-width:0;}
.al-title{font-size:13px;font-weight:500;color:#e6edf3;}
.al-detail{font-size:11px;color:#8b949e;margin-top:2px;}
.al-meta{font-size:11px;color:#6e7681;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
.al-state{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;}
.al-state.open{background:#3d1a1a;color:#f85149;}
.al-state.acknowledged{background:#3d2e1a;color:#e3b341;}
.al-state.resolved{background:#1a3e2a;color:#3fb950;}
.al-btn{padding:5px 11px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-family:inherit;transition:all .15s;}
.al-btn:hover{background:#30363d;}
.al-btn.ack:hover{background:#3d2e1a;color:#e3b341;border-color:#e3b341;}
.al-btn.resolve:hover{background:#1a3e2a;color:#3fb950;border-color:#3fb950;}
.al-empty{text-align:center;padding:34px;color:#6e7681;font-size:13px;}
.chan-kind{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:#21262d;color:#8b949e;}

/* ── Compliance ── */
.cmp-wrap{flex:1;overflow-y:auto;padding:18px;}
.cmp-score{display:flex;align-items:center;gap:20px;background:#0d1117;border:1px solid #21262d;border-radius:11px;padding:18px 22px;margin-bottom:16px;}
.cmp-gauge{width:88px;height:88px;flex-shrink:0;position:relative;}
.cmp-gauge-val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.cmp-gauge-num{font-size:22px;font-weight:700;color:#e6edf3;line-height:1;}
.cmp-gauge-lbl{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-top:2px;}
.cmp-score-meta{flex:1;}
.cmp-score-title{font-size:15px;font-weight:600;color:#e6edf3;}
.cmp-score-sub{font-size:12px;color:#8b949e;margin-top:3px;}
.cmp-pills{display:flex;gap:16px;margin-top:10px;}
.cmp-pill{font-size:12px;color:#8b949e;display:flex;align-items:center;gap:6px;}
.cmp-pill b{font-size:16px;}
.cmp-tabs{display:flex;gap:8px;margin-bottom:16px;}
.cmp-card{background:#0d1117;border:1px solid #21262d;border-radius:9px;overflow:hidden;}
.cmp-row{display:flex;align-items:center;gap:12px;padding:11px 15px;border-bottom:1px solid #161b22;}
.cmp-row:last-child{border-bottom:none;}
.cmp-stat{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.cmp-stat.pass{background:#3fb950;}.cmp-stat.fail{background:#f85149;}.cmp-stat.drift{background:#e3b341;}
.cmp-name{font-weight:500;color:#e6edf3;font-size:13px;}
.cmp-sub{font-size:11px;color:#8b949e;font-family:'IBM Plex Mono',monospace;}
.cmp-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;}
.cmp-badge.pass{background:#1a3e2a;color:#3fb950;}
.cmp-badge.fail{background:#3d1a1a;color:#f85149;}
.cmp-badge.drift{background:#3d2e1a;color:#e3b341;}
.cmp-progress{width:90px;height:5px;background:#21262d;border-radius:3px;overflow:hidden;}
.cmp-progress-fill{height:100%;border-radius:3px;}
.cmp-check{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:#010409;border:1px solid #21262d;margin-bottom:4px;font-size:12px;}
.cmp-check-icon{width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0;}
.cmp-check-icon.pass{background:#1a3e2a;color:#3fb950;}.cmp-check-icon.fail{background:#3d1a1a;color:#f85149;}
.cmp-empty{text-align:center;padding:34px;color:#6e7681;font-size:13px;line-height:1.6;}

/* ── Telemetry ── */
.tel-wrap{flex:1;overflow-y:auto;padding:18px;}
.tel-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
.tel-range{display:flex;border:1px solid #30363d;border-radius:7px;overflow:hidden;}
.tel-range button{padding:5px 11px;font-size:12px;font-weight:500;cursor:pointer;background:transparent;border:none;color:#8b949e;font-family:inherit;}
.tel-range button.on{background:#1f6feb;color:#fff;}
.tel-range button:not(.on):hover{background:#21262d;color:#e6edf3;}
.tel-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.tel-card{background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:14px 16px;}
.tel-card.wide{grid-column:1 / -1;}
.tel-card-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.tel-card-title{font-size:13px;font-weight:600;color:#e6edf3;}
.tel-card-cur{font-size:13px;font-weight:600;font-family:'IBM Plex Mono',monospace;}
.tel-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;}
.tel-leg{display:flex;align-items:center;gap:5px;font-size:11px;color:#8b949e;}
.tel-leg-line{width:14px;height:2px;border-radius:2px;}
.tel-empty{text-align:center;padding:28px;color:#6e7681;font-size:12px;}
.spark-wrap{display:flex;align-items:center;gap:8px;}
.spark-label{font-size:11px;color:#8b949e;width:34px;flex-shrink:0;}
.spark-cur{font-size:11px;font-family:'IBM Plex Mono',monospace;color:#e6edf3;width:38px;text-align:right;flex-shrink:0;}
.tel-tabbtn{margin-top:2px;}
`;

/* ───────────────────────── Interface generators ────────────────────── */
function genSwitchIfaces(vendor, accessN, uplinkN) {
  const ifaces = {};
  const accName = ({ Cisco:n=>`GigabitEthernet1/0/${n}`, Arista:n=>`Ethernet${n}`, Juniper:n=>`ge-0/0/${n-1}`, SONiC:n=>`Ethernet${(n-1)*4}` })[vendor] || (n=>`Ethernet${n}`);
  const upName  = ({ Cisco:n=>`TenGigabitEthernet1/1/${n}`, Arista:n=>`Ethernet${48+n}`, Juniper:n=>`xe-0/2/${n-1}`, SONiC:n=>`Ethernet${(accessN+n)*4}` })[vendor] || (n=>`Ethernet${48+n}`);
  const descs = ["Server-port","User-port","AP-uplink","Printer","VoIP-phone","Camera-PoE",""];
  for (let i=1;i<=accessN;i++) {
    const down = (i%7===0);
    ifaces[accName(i)] = { speed:"1G", status: down?"down":"up", ip:"", desc: i<=6?descs[i-1]:"", mode:"access", vlan: i%3===0?"20":"100", shutdown:false };
  }
  for (let i=1;i<=uplinkN;i++) {
    ifaces[upName(i)] = { speed:"10G", status:"up", ip:"", desc:`Uplink-${i}`, mode:"trunk", vlan:null, shutdown:false };
  }
  const mgmt = vendor==="Cisco"?"GigabitEthernet0/0": vendor==="Juniper"?"me0":"Management0";
  ifaces[mgmt] = { speed:"1G", status:"up", ip:"", desc:"OOB-MGMT", mode:"routed", vlan:null, shutdown:false };
  return ifaces;
}

/* ───────────────────────── Initial devices ─────────────────────────── */
const INIT_DEVICES = [
  { id:1, name:"core-rtr-01", ip:"10.0.0.1", vendor:"Arista", model:"DCS-7050CX3", os:"EOS 4.28.3M", type:"router", protocol:"NETCONF", status:"up", cpu:34, mem:58, uptime:"47d 3h", location:"DC1-Rack-A1", sshPort:22,
    interfaces:{"Ethernet1":{speed:"10G",status:"up",ip:"10.0.0.1/24",desc:"To-dist-sw-04",mode:"routed",vlan:null,shutdown:false},"Ethernet2":{speed:"10G",status:"up",ip:"10.0.0.2/30",desc:"Core-link",mode:"routed",vlan:null,shutdown:false},"Ethernet3":{speed:"10G",status:"down",ip:"",desc:"",mode:"routed",vlan:null,shutdown:true},"Ethernet4":{speed:"10G",status:"down",ip:"",desc:"",mode:"routed",vlan:null,shutdown:false},"Management0":{speed:"1G",status:"up",ip:"192.168.1.1/24",desc:"OOB-MGMT",mode:"routed",vlan:null,shutdown:false}},
    vlans:{"1":{name:"default",status:"active"},"10":{name:"MGMT",status:"active"},"20":{name:"SERVERS",status:"active"}},
    bgpPeers:[{peer:"10.0.0.2",as:"65002",state:"Established",prefixes:142,desc:"core-sw-02"}],
    ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"public", ntpServers:[], hostname:"core-rtr-01", role:"core" },
  { id:2, name:"dist-sw-04", ip:"10.0.1.4", vendor:"Juniper", model:"EX4300-48T", os:"Junos 21.4R3", type:"switch", protocol:"gNMI", status:"warn", cpu:71, mem:62, uptime:"12d 7h", location:"DC1-Rack-B4", sshPort:22,
    interfaces: genSwitchIfaces("Juniper",24,2),
    vlans:{"1":{name:"default",status:"active"},"20":{name:"SERVERS",status:"active"},"100":{name:"USERS",status:"active"}},
    bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"public", ntpServers:[], hostname:"dist-sw-04", role:"distribution" },
  { id:3, name:"core-sw-02", ip:"10.0.0.2", vendor:"Arista", model:"DCS-7060CX-32S", os:"EOS 4.28.3M", type:"switch", protocol:"NETCONF", status:"up", cpu:18, mem:44, uptime:"47d 3h", location:"DC1-Rack-A2", sshPort:22,
    interfaces: genSwitchIfaces("Arista",24,4),
    vlans:{"1":{name:"default",status:"active"},"10":{name:"MGMT",status:"active"},"20":{name:"SERVERS",status:"active"},"100":{name:"USERS",status:"active"}},
    bgpPeers:[{peer:"10.0.0.1",as:"65001",state:"Established",prefixes:88,desc:"core-rtr-01"}],
    ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"public", ntpServers:[], hostname:"core-sw-02", role:"core" },
  { id:4, name:"dist-sw-05", ip:"10.0.1.5", vendor:"Cisco", model:"Catalyst 9300", os:"IOS-XE 17.9.3", type:"switch", protocol:"RESTCONF", status:"up", cpu:29, mem:55, uptime:"33d 1h", location:"DC1-Rack-B5", sshPort:22,
    interfaces: genSwitchIfaces("Cisco",24,2),
    vlans:{"1":{name:"default",status:"active"},"10":{name:"MGMT",status:"active"},"20":{name:"SERVERS",status:"active"},"100":{name:"USERS",status:"active"}},
    bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"public", ntpServers:[], hostname:"dist-sw-05", role:"distribution" },
  { id:5, name:"fw-perimeter-01", ip:"10.0.0.254", vendor:"pfSense", model:"XG-7100", os:"pfSense 2.7.0", type:"firewall", protocol:"SSH", status:"up", cpu:12, mem:38, uptime:"120d 0h", location:"DC1-Edge", sshPort:22,
    interfaces:{"em0":{speed:"1G",status:"up",ip:"10.0.0.254/24",desc:"LAN",mode:"routed",vlan:null,shutdown:false},"em1":{speed:"1G",status:"up",ip:"203.0.113.10/30",desc:"WAN",mode:"routed",vlan:null,shutdown:false},"ix0":{speed:"10G",status:"up",ip:"",desc:"DMZ",mode:"routed",vlan:null,shutdown:false}},
    vlans:{"1":{name:"LAN",status:"active"},"50":{name:"DMZ",status:"active"}},
    bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"private", ntpServers:["pool.ntp.org"], hostname:"fw-perimeter-01", role:"edge" },
  // ── controller-managed, read-only (closed ecosystems) ──
  { id:6, name:"unifi-switch-01", ip:"10.0.9.100", vendor:"Ubiquiti", model:"USW-Pro-24-PoE", os:"v6.6.55", type:"switch", protocol:"UNIFI", status:"up", cpu:14, mem:32, uptime:"61d 4h", location:"Office-IDF-1", sshPort:22, source:"unifi", capability:"readonly", controllerId:1, externalId:"unifi-1-0",
    interfaces:Object.fromEntries(Array.from({length:8},(_,i)=>[`Port ${i+1}`,{speed:i<3?"1G":"—",status:i<3?"up":"down",ip:"",desc:i===0?"Uplink":(i<3?"Client":""),mode:"access",vlan:i<3?"1":null,shutdown:false}])),
    vlans:{"1":{name:"Default",status:"active"},"20":{name:"IoT",status:"active"}}, bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"", ntpServers:[], hostname:"unifi-switch-01", role:"access" },
  { id:7, name:"omada-sw-02", ip:"10.0.9.120", vendor:"TP-Link", model:"SG3428MP", os:"1.20.0", type:"switch", protocol:"OMADA", status:"up", cpu:9, mem:28, uptime:"33d 12h", location:"Office-IDF-2", sshPort:22, source:"omada", capability:"readonly", controllerId:2, externalId:"omada-2-0",
    interfaces:Object.fromEntries(Array.from({length:8},(_,i)=>[`Port ${i+1}`,{speed:i<4?"1G":"—",status:i<4?"up":"down",ip:"",desc:i===0?"Uplink":(i<4?"AP/Client":""),mode:"access",vlan:i<4?"1":null,shutdown:false}])),
    vlans:{"1":{name:"Default",status:"active"}}, bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:{}, snmpCommunity:"", ntpServers:[], hostname:"omada-sw-02", role:"access" },
];

/* ───────────────────────── Config archive engine ───────────────────── */
// Render a device's full running-config from its live model. Same source of
// truth the SSH terminal uses, so GUI/CLI edits both show up in backups.
function renderRunningConfig(dev) {
  const L = [];
  L.push(`! Running configuration of ${dev.hostname}`);
  L.push(`! ${dev.vendor} ${dev.model} — ${dev.os}`);
  L.push(`!`);
  L.push(`version ${dev.os}`);
  L.push(`!`);
  L.push(`hostname ${dev.hostname}`);
  L.push(`!`);
  L.push(`ip routing`);
  if (dev.snmpCommunity) { L.push(`!`); L.push(`snmp-server community ${dev.snmpCommunity} RO`); }
  (dev.ntpServers||[]).forEach(n=>L.push(`ntp server ${n}`));
  Object.entries(dev.vlans||{}).forEach(([id,v])=>{ L.push(`!`); L.push(`vlan ${id}`); L.push(` name ${v.name}`); });
  Object.entries(dev.interfaces||{}).forEach(([name,i])=>{
    L.push(`!`); L.push(`interface ${name}`);
    if (i.desc) L.push(` description ${i.desc}`);
    if (i.mode==="routed" && i.ip) { const [ip,c]=i.ip.split("/"); L.push(` ip address ${ip} ${cidrToMask(c)}`); }
    if (i.mode==="access") { L.push(` switchport mode access`); L.push(` switchport access vlan ${i.vlan||1}`); }
    if (i.mode==="trunk") { L.push(` switchport trunk encapsulation dot1q`); L.push(` switchport mode trunk`); }
    if (i.speed && i.speed!=="auto" && i.speed!=="1G") L.push(` speed ${i.speed}`);
    L.push(i.shutdown ? ` shutdown` : ` no shutdown`);
  });
  (dev.staticRoutes||[]).forEach(r=>{ L.push(`!`); L.push(`ip route ${r.replace(" via "," ")}`); });
  if ((dev.bgpPeers||[]).length) {
    L.push(`!`); L.push(`router bgp 65001`);
    dev.bgpPeers.forEach(b=>{ L.push(` neighbor ${b.peer} remote-as ${b.as}`); if(b.desc) L.push(` neighbor ${b.peer} description ${b.desc}`); });
  }
  if ((dev.ospfNets||[]).length) {
    L.push(`!`); L.push(`router ospf 1`);
    dev.ospfNets.forEach(o=>L.push(` network ${o.net} ${o.wild||"0.0.0.255"} area ${o.area}`));
  }
  L.push(`!`); L.push(`line vty 0 4`); L.push(` transport input ssh`); L.push(` login local`);
  L.push(`!`); L.push(`end`);
  return L.join("\n");
}

// Cheap stable hash for change detection (FNV-1a, hex).
function hashConfig(text) {
  let h = 0x811c9dc5;
  for (let i=0;i<text.length;i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h>>>0).toString(16).padStart(8,"0");
}

// Line-based diff (LCS) → array of {type:"add"|"del"|"ctx", text, an, bn}.
function diffConfig(oldText, newText) {
  const a = (oldText||"").split("\n"), b = (newText||"").split("\n");
  const m=a.length, n=b.length;
  const dp = Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for (let i=m-1;i>=0;i--) for (let j=n-1;j>=0;j--)
    dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const out=[]; let i=0,j=0;
  while (i<m && j<n) {
    if (a[i]===b[j]) { out.push({type:"ctx",text:a[i],an:i+1,bn:j+1}); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({type:"del",text:a[i],an:i+1}); i++; }
    else { out.push({type:"add",text:b[j],bn:j+1}); j++; }
  }
  while (i<m) out.push({type:"del",text:a[i],an:++i});
  while (j<n) out.push({type:"add",text:b[j],bn:++j});
  return out;
}
function diffStats(d){ return { added:d.filter(x=>x.type==="add").length, removed:d.filter(x=>x.type==="del").length }; }

// Parse a git unified diff (what /configs/diff returns) into renderable rows.
// Header lines (diff --git, index, ---, +++) are dropped; @@ hunks are kept as
// markers; +/- lines become add/del; everything else is context.
function parseUnifiedDiff(text){
  const rows=[]; let added=0, removed=0;
  (text||"").split("\n").forEach(line=>{
    if (line.startsWith("diff --git")||line.startsWith("index ")||
        line.startsWith("--- ")||line.startsWith("+++ ")||
        line.startsWith("new file")||line.startsWith("deleted file")||
        line.startsWith("old mode")||line.startsWith("new mode")||
        line.startsWith("similarity ")||line.startsWith("rename ")) return;
    if (line.startsWith("\\")) return;                 // "\ No newline at end of file"
    if (line.startsWith("@@")) { rows.push({type:"hunk", text:line}); return; }
    if (line.startsWith("+")) { rows.push({type:"add", text:line.slice(1)}); added++; return; }
    if (line.startsWith("-")) { rows.push({type:"del", text:line.slice(1)}); removed++; return; }
    rows.push({type:"ctx", text:line.startsWith(" ")?line.slice(1):line});
  });
  return { rows, added, removed };
}

function tsAgo(ms){ const s=(Date.now()-ms)/1000; if(s<60)return"just now"; if(s<3600)return`${(s/60)|0}m ago`; if(s<86400)return`${(s/3600)|0}h ago`; return`${(s/86400)|0}d ago`; }
function tsFull(ms){ return new Date(ms).toLocaleString(undefined,{year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}); }

// Build a seed archive so the UI has history on first load.
function seedArchive(devices) {
  const arch = {}; const now = Date.now(); const DAY = 86400000;
  devices.forEach(dev=>{
    const base = renderRunningConfig(dev);
    const versions = [];
    // 3 historical snapshots, oldest first, with a couple of synthetic edits.
    const v1 = base.replace(/ description OOB-MGMT/,"").replace("hostname "+dev.hostname,"hostname "+dev.hostname);
    const v2 = base.replace(" no shutdown\n!\ninterface", " shutdown\n!\ninterface");
    const mk = (text, daysAgo, trigger) => ({
      id: `${dev.id}-${now-daysAgo*DAY}`, ts: now - daysAgo*DAY, hash: hashConfig(text),
      bytes: text.length, lines: text.split("\n").length, trigger, user:"switchdex-scheduler", text,
    });
    versions.push(mk(v1, 21, "scheduled"));
    versions.push(mk(v2, 7,  "change-detected"));
    versions.push(mk(base, 0.04, "scheduled")); // ~1h ago = current
    arch[dev.id] = { versions, lastStatus:"ok", lastRun: now - 0.04*DAY };
  });
  return arch;
}

/* ───────────────────────── CLI engine ──────────────────────────────── */
function cidrToMask(bits){ const n=parseInt(bits); const m=(0xFFFFFFFF<<(32-n))>>>0; return [(m>>>24),(m>>>16)&255,(m>>>8)&255,m&255].join("."); }
function maskToCidr(mask){ return mask.split(".").reduce((a,o)=>a+parseInt(o).toString(2).replace(/0/g,"").length,0); }

function buildCLI(initDev, pushDevice) {
  let dev = JSON.parse(JSON.stringify(initDev));
  let mode = "exec"; let ctx = null; let ctxType = null; let unsaved = false;
  const sync = () => { pushDevice(JSON.parse(JSON.stringify(dev))); unsaved = true; };
  const prompt = () => {
    const h = dev.hostname;
    if (mode==="exec")   return {label:`${h}#`,cls:"exec"};
    if (mode==="config") return {label:`${h}(config)#`,cls:"config"};
    if (mode==="config-if")     return {label:`${h}(config-if)#`,cls:"sub"};
    if (mode==="config-vlan")   return {label:`${h}(config-vlan)#`,cls:"sub"};
    if (mode==="config-router") return {label:`${h}(config-router)#`,cls:"sub"};
    if (mode==="config-ospf")   return {label:`${h}(config-router)#`,cls:"sub"};
    if (mode==="config-acl")    return {label:`${h}(config-ext-nacl)#`,cls:"sub"};
    if (mode==="config-line")   return {label:`${h}(config-line)#`,cls:"line"};
    return {label:`${h}#`,cls:"exec"};
  };
  const pill = () => {
    if (mode==="exec")   return {label:"EXEC",cls:"exec"};
    if (mode==="config") return {label:"CONFIG",cls:"config"};
    if (mode==="config-if")     return {label:"IF",cls:"sub"};
    if (mode==="config-vlan")   return {label:"VLAN",cls:"sub"};
    if (mode==="config-router") return {label:"BGP",cls:"sub"};
    if (mode==="config-ospf")   return {label:"OSPF",cls:"sub"};
    if (mode==="config-acl")    return {label:"ACL",cls:"sub"};
    if (mode==="config-line")   return {label:"LINE",cls:"line"};
    return {label:"EXEC",cls:"exec"};
  };

  function run(raw) {
    const input = raw.trim(); if (!input) return [];
    const lo = input.toLowerCase(); const p = input.split(/\s+/); const cmd = p[0].toLowerCase();
    const L=[]; const out=(t,c="out")=>L.push({type:c,text:t});
    const ok=t=>L.push({type:"ok",text:t}); const err=t=>L.push({type:"err",text:t});
    const warn=t=>L.push({type:"warn",text:t}); const inf=t=>L.push({type:"info",text:t});

    if (cmd==="exit"||cmd==="quit") {
      if (mode==="exec") { L.push({type:"sys_exit"}); return L; }
      if (mode.startsWith("config-")) { mode="config"; ctx=null; ctxType=null; return L; }
      mode="exec"; return L;
    }
    if (cmd==="end"||lo==="^z") { mode="exec"; ctx=null; ctxType=null; return L; }
    if (cmd==="clear"||lo==="cls") { L.push({type:"clear"}); return L; }
    if (cmd==="do" && mode!=="exec") { const sv=mode; mode="exec"; const r=run(p.slice(1).join(" ")); mode=sv; return r; }

    if (mode==="exec") {
      if (cmd==="?"||cmd==="help") {
        out("Privileged EXEC commands:\n");
        [["configure terminal","enter global configuration mode"],["conf t","alias for configure terminal"],["show ...","display info (try 'show ?')"],["ping <ip> [repeat <n>]","send ICMP echo"],["traceroute <ip>","trace packet path"],["write memory","save running-config to NVRAM"],["reload","restart device (simulated)"],["clear counters","reset interface counters"],["exit","close session"]].forEach(([c,d])=>out(`  ${c.padEnd(28)} — ${d}`));
        return L;
      }
      if (cmd==="show") return showCmd(p,out,err,warn,inf,lo);
      if ((cmd==="configure"&&p[1]?.toLowerCase()==="terminal")||lo==="conf t"||lo==="conf term") { mode="config"; inf("Enter configuration commands, one per line.  End with CTRL/Z or 'end'."); return L; }
      if (cmd==="ping") { const t=p[1]||"8.8.8.8"; const r=p[3]||5; out(`Type escape sequence to abort.\nSending ${r} ICMP Echos to ${t}:\n${"!".repeat(Number(r))}\nSuccess rate is 100% (${r}/${r}), round-trip min/avg/max = 1/3/7 ms`); return L; }
      if (cmd==="traceroute"||cmd==="tracert") { const t=p[1]||"8.8.8.8"; out(`Tracing route to ${t}:\n 1  10.0.0.254    1 ms\n 2  203.0.113.1   4 ms\n 3  ${t}         9 ms`); return L; }
      if (cmd==="write"||(lo==="copy running-config startup-config")) { ok("Building configuration...\n[OK]"); unsaved=false; return L; }
      if (cmd==="reload") { warn("% Reload cancelled (simulation mode)."); return L; }
      if (cmd==="clear") { ok("% Cleared."); return L; }
      err(`% Unknown command: '${input}'. Type '?' for help.`); return L;
    }

    if (mode==="config") {
      if (cmd==="?"||cmd==="help") {
        out("Global configuration commands:\n");
        [["hostname <name>","set device hostname"],["interface <name>","enter interface config"],["vlan <id>","create/modify VLAN"],["router bgp <asn>","enter BGP config"],["router ospf <pid>","enter OSPF config"],["ip access-list extended <name>","create extended ACL"],["ip route <net> <mask> <gw>","add static route"],["line vty 0 4","enter VTY line config"],["ntp server <ip>","configure NTP"],["snmp-server community <str> RO/RW","SNMP community"],["spanning-tree mode rapid-pvst","set STP mode"],["end","return to exec mode"]].forEach(([c,d])=>out(`  ${c.padEnd(34)} — ${d}`));
        return L;
      }
      if (cmd==="hostname"&&p[1]) { dev.hostname=p[1]; ok(`% Hostname changed to '${p[1]}'.`); sync(); return L; }
      if (cmd==="interface"&&p[1]) { ctx=p.slice(1).join(" "); mode="config-if"; ctxType="if"; if(!dev.interfaces[ctx]){dev.interfaces[ctx]={speed:"1G",status:"down",ip:"",desc:"",mode:"access",vlan:null,shutdown:true};inf(`% Creating new interface ${ctx}.`);} return L; }
      if (cmd==="vlan"&&p[1]?.match(/^\d+$/)) { ctx=p[1]; mode="config-vlan"; ctxType="vlan"; if(!dev.vlans[ctx])dev.vlans[ctx]={name:"VLAN"+ctx,status:"active"}; return L; }
      if (cmd==="router"&&p[1]==="bgp"&&p[2]) { ctx="bgp-"+p[2]; mode="config-router"; ctxType="bgp"; return L; }
      if (cmd==="router"&&p[1]==="ospf"&&p[2]) { ctx="ospf-"+p[2]; mode="config-ospf"; ctxType="ospf"; return L; }
      if (cmd==="ip"&&p[1]==="access-list"&&p[3]) { const n=p.slice(3).join(" "); ctx=p[2]+"-"+n; mode="config-acl"; ctxType="acl"; if(!dev.aclDefs[n])dev.aclDefs[n]={type:p[2],entries:[]}; return L; }
      if (cmd==="line") { ctx=p.slice(1).join(" "); mode="config-line"; ctxType="line"; return L; }
      if (cmd==="ip"&&p[1]==="route"&&p.length>=5) { const rt=`${p[2]} ${p[3]} via ${p[4]}`; dev.staticRoutes.push(rt); ok(`% Static route added: ${rt}`); sync(); return L; }
      if (cmd==="ntp"&&p[1]==="server"&&p[2]) { dev.ntpServers=[...new Set([...dev.ntpServers,p[2]])]; ok(`% NTP server ${p[2]} added.`); sync(); return L; }
      if (cmd==="snmp-server"&&p[1]==="community"&&p[2]) { dev.snmpCommunity=p[2]; ok(`% SNMP community '${p[2]}' ${p[3]||"RO"} configured.`); sync(); return L; }
      if (cmd==="spanning-tree") { ok(`% Spanning-tree: ${p.slice(1).join(" ")} applied.`); return L; }
      err(`% Invalid input: '${input}'. Type '?' for help.`); return L;
    }

    if (mode==="config-if") {
      const iface=dev.interfaces[ctx];
      if (cmd==="?"||cmd==="help") {
        out(`Interface config commands (${ctx}):\n`);
        [["description <text>","set description"],["ip address <ip> <mask>","assign IPv4"],["no ip address","remove IPv4"],["shutdown","disable interface"],["no shutdown","enable interface"],["speed <100|1000|10000|auto>","set speed"],["mtu <bytes>","set MTU"],["switchport mode <access|trunk>","set mode"],["switchport access vlan <id>","access VLAN"],["switchport trunk allowed vlan <list>","trunk VLANs"],["spanning-tree portfast","enable portfast"],["channel-group <id> mode active","LACP"],["ip ospf <pid> area <id>","enable OSPF"],["exit / end","leave mode"]].forEach(([c,d])=>out(`  ${c.padEnd(38)} — ${d}`));
        return L;
      }
      if (cmd==="description") { iface.desc=p.slice(1).join(" "); ok(`% Description set on ${ctx}.`); sync(); return L; }
      if (cmd==="no"&&p[1]==="description") { iface.desc=""; ok("% Description cleared."); sync(); return L; }
      if (cmd==="ip"&&p[1]==="address"&&p[2]&&p[3]) { const c=maskToCidr(p[3]); iface.ip=`${p[2]}/${c}`; iface.mode="routed"; ok(`% IP ${p[2]}/${c} assigned to ${ctx}.`); sync(); return L; }
      if (cmd==="no"&&p[1]==="ip"&&p[2]==="address") { iface.ip=""; ok(`% IP removed from ${ctx}.`); sync(); return L; }
      if (cmd==="shutdown") { iface.status="down"; iface.shutdown=true; warn(`% ${ctx} administratively DOWN.`); sync(); return L; }
      if (cmd==="no"&&p[1]==="shutdown") { iface.status="up"; iface.shutdown=false; ok(`% ${ctx} is now UP.`); sync(); return L; }
      if (cmd==="speed"&&p[1]) { const sm={"10":"10M","100":"100M","1000":"1G","10000":"10G","100000":"100G","auto":"auto"}; iface.speed=sm[p[1]]||p[1]; ok(`% Speed ${iface.speed} on ${ctx}.`); sync(); return L; }
      if (cmd==="mtu"&&p[1]) { ok(`% MTU ${p[1]} on ${ctx}.`); return L; }
      if (cmd==="switchport") {
        if (p[1]==="mode"&&p[2]) { iface.mode=p[2]; iface.ip=""; ok(`% ${ctx} switchport mode ${p[2]}.`); sync(); return L; }
        if (p[1]==="access"&&p[2]==="vlan"&&p[3]) { iface.vlan=p[3]; iface.mode="access"; ok(`% Access VLAN ${p[3]} on ${ctx}.`); sync(); return L; }
        if (p[1]==="trunk"&&p[2]==="allowed"&&p[3]==="vlan") { iface.mode="trunk"; ok(`% Trunk VLANs [${p.slice(4).join(" ")}] on ${ctx}.`); sync(); return L; }
      }
      if (cmd==="spanning-tree") { ok(`% Spanning-tree applied on ${ctx}.`); return L; }
      if (cmd==="channel-group"&&p[1]) { ok(`% ${ctx} added to Port-Channel${p[1]} (LACP).`); return L; }
      if (cmd==="ip"&&p[1]==="ospf"&&p[2]&&p[3]==="area"&&p[4]) { dev.ospfNets.push({net:iface.ip||ctx,area:p[4],iface:ctx}); ok(`% OSPF area ${p[4]} on ${ctx}.`); sync(); return L; }
      err(`% Invalid input: '${input}'. Type '?'.`); return L;
    }

    if (mode==="config-vlan") {
      const vlan=dev.vlans[ctx];
      if (cmd==="?"||cmd==="help") { out(`VLAN ${ctx}:\n  name <name>\n  state active|suspend\n  exit / end`); return L; }
      if (cmd==="name"&&p[1]) { vlan.name=p.slice(1).join(" "); ok(`% VLAN ${ctx} name '${vlan.name}'.`); sync(); return L; }
      if (cmd==="state"&&p[1]) { vlan.status=p[1]; ok(`% VLAN ${ctx} state ${p[1]}.`); return L; }
      err(`% Invalid VLAN command. Type '?'.`); return L;
    }
    if (mode==="config-router") {
      const asn=ctx.split("-")[1];
      if (cmd==="?"||cmd==="help") { out(`BGP AS ${asn}:\n  neighbor <ip> remote-as <asn>\n  neighbor <ip> description <text>\n  no neighbor <ip>\n  network <net> mask <mask>\n  exit`); return L; }
      if (cmd==="neighbor"&&p[1]&&p[2]==="remote-as"&&p[3]) { const e=dev.bgpPeers.find(x=>x.peer===p[1]); if(e)e.as=p[3]; else dev.bgpPeers.push({peer:p[1],as:p[3],state:"Idle",prefixes:0,desc:""}); ok(`% BGP neighbor ${p[1]} AS${p[3]}.`); sync(); return L; }
      if (cmd==="no"&&p[1]==="neighbor"&&p[2]) { dev.bgpPeers=dev.bgpPeers.filter(x=>x.peer!==p[2]); ok(`% Neighbor ${p[2]} removed.`); sync(); return L; }
      if (cmd==="network") { ok(`% Network ${p[1]} will be advertised.`); return L; }
      err(`% Invalid BGP command. Type '?'.`); return L;
    }
    if (mode==="config-ospf") {
      const pid=ctx.split("-")[1];
      if (cmd==="?"||cmd==="help") { out(`OSPF ${pid}:\n  network <ip> <wildcard> area <id>\n  passive-interface <name>\n  redistribute connected\n  exit`); return L; }
      if (cmd==="network"&&p[3]==="area"&&p[4]) { dev.ospfNets.push({net:p[1],wild:p[2],area:p[4]}); ok(`% OSPF network ${p[1]} area ${p[4]}.`); sync(); return L; }
      if (cmd==="passive-interface") { ok(`% Passive-interface ${p[1]} set.`); return L; }
      if (cmd==="redistribute") { ok(`% Redistributing ${p[1]}.`); return L; }
      err(`% Invalid OSPF command. Type '?'.`); return L;
    }
    if (mode==="config-acl") {
      const aclName=ctx.replace(/^(standard|extended)-/,"");
      if (cmd==="?"||cmd==="help") { out(`ACL '${aclName}':\n  permit|deny <src> [dst] [proto] [eq port]\n  exit`); return L; }
      if (cmd==="permit"||cmd==="deny") { const a=dev.aclDefs[aclName]; if(a){a.entries.push(input);ok(`% ACL entry added: ${input}`);sync();} return L; }
      err(`% Invalid ACL command.`); return L;
    }
    if (mode==="config-line") {
      if (cmd==="?"||cmd==="help") { out(`Line ${ctx}:\n  exec-timeout <min> <sec>\n  transport input ssh\n  login local\n  exit`); return L; }
      if (cmd==="exec-timeout") { ok(`% Exec-timeout set on ${ctx}.`); return L; }
      if (cmd==="transport") { ok(`% Transport ${p.slice(1).join(" ")} on ${ctx}.`); return L; }
      if (cmd==="login") { ok(`% Login ${p[1]} on ${ctx}.`); return L; }
      err(`% Invalid line command.`); return L;
    }
    err("% Unknown mode."); return L;
  }

  function showCmd(p,out,err,warn,inf,lo) {
    const sub=p[1]?.toLowerCase();
    if (!sub||sub==="?") { out("show version | interfaces [name] | ip interface brief | ip route | vlan | running-config | bgp summary | mac address-table | spanning-tree | snmp"); return []; }
    if (sub==="version") { out(`\n${dev.vendor} ${dev.model}\nSoftware Version ${dev.os}\nHostname: ${dev.hostname}\nUptime: ${INIT_DEVICES.find(x=>x.id===dev.id)?.uptime||"unknown"}\nSerial: SN${String(dev.id).padStart(9,"0")}\n`); return []; }
    if (sub==="interfaces") {
      const tgt=p.slice(2).join(" ");
      if (tgt) { const i=dev.interfaces[tgt]; if(!i){err(`% Interface '${tgt}' not found.`);return [];} out(`${tgt} is ${i.shutdown?"administratively ":""}${i.status}, line protocol is ${i.status}\n  Description: ${i.desc||"(none)"}\n  Speed: ${i.speed}\n  IP: ${i.ip||"unassigned"}\n  Mode: ${i.mode}`); }
      else { Object.entries(dev.interfaces).forEach(([n,i])=>out(`${n} is ${i.shutdown?"administratively ":""}${i.status}  desc:${i.desc||"-"}  ip:${i.ip||"none"}  ${i.speed} ${i.mode}`)); }
      return [];
    }
    if (sub==="ip") {
      const s2=p[2]?.toLowerCase();
      if (s2==="interface"&&p[3]?.toLowerCase()==="brief") { out("Interface                   IP-Address       Status   Protocol"); out("──────────────────────────────────────────────────────────────"); Object.entries(dev.interfaces).forEach(([n,i])=>out(`${n.padEnd(28)}${(i.ip||"unassigned").padEnd(17)}${i.status.padEnd(9)}${i.status}`)); return []; }
      if (s2==="route") { out("Codes: C-connected, S-static, B-BGP, O-OSPF\n"); Object.entries(dev.interfaces).filter(([,c])=>c.ip).forEach(([n,c])=>{const net=c.ip.split("/")[0].split(".").slice(0,3).join(".")+".0";out(`C    ${net}/24 via Direct, ${n}`);}); dev.staticRoutes.forEach(r=>out(`S    ${r}`)); return []; }
    }
    if (sub==="vlan") { out("VLAN   Name                    Status    Ports"); out("────   ──────────────────────  ────────  ─────────────"); Object.entries(dev.vlans).forEach(([id,v])=>{const ports=Object.entries(dev.interfaces).filter(([,i])=>i.vlan===id).map(([n])=>n).slice(0,4).join(", ");out(`${id.padEnd(7)}${v.name.padEnd(24)}${v.status.padEnd(10)}${ports}`);}); return []; }
    if (sub==="running-config"||sub==="run") {
      const lines=[`!\nversion ${dev.os}\n!\nhostname ${dev.hostname}\n!\nip routing`];
      if (dev.snmpCommunity) lines.push(`!\nsnmp-server community ${dev.snmpCommunity} RO`);
      Object.entries(dev.vlans).forEach(([id,v])=>lines.push(`!\nvlan ${id}\n name ${v.name}`));
      Object.entries(dev.interfaces).forEach(([name,i])=>{ lines.push(`!\ninterface ${name}`); if(i.desc)lines.push(` description ${i.desc}`); if(i.mode==="routed"&&i.ip){const [ip,c]=i.ip.split("/");lines.push(` ip address ${ip} ${cidrToMask(c)}`);} if(i.mode==="access")lines.push(` switchport mode access\n switchport access vlan ${i.vlan||1}`); if(i.mode==="trunk")lines.push(` switchport mode trunk`); lines.push(i.shutdown?" shutdown":" no shutdown"); });
      if (dev.bgpPeers.length){lines.push(`!\nrouter bgp 65001`);dev.bgpPeers.forEach(b=>lines.push(` neighbor ${b.peer} remote-as ${b.as}`));}
      lines.push("!\nend"); out(lines.join("\n")); return [];
    }
    if (sub==="bgp") { if(!dev.bgpPeers.length){warn("% No BGP peers.");return [];} out("Neighbor         AS       State          PfxRcv"); out("──────────────────────────────────────────────────"); dev.bgpPeers.forEach(b=>out(`${b.peer.padEnd(17)}${b.as.padEnd(9)}${b.state.padEnd(15)}${b.prefixes}`)); return []; }
    if (sub==="mac") { out("Vlan  Mac Address       Type     Ports"); ["0011.2233.4455","aabb.ccdd.eeff"].forEach((m,i)=>out(`${(i+1)*10}    ${m}  DYNAMIC  Gi1/0/${i+1}`)); return []; }
    if (sub==="spanning-tree") { out("VLAN0001  This bridge is the root"); Object.keys(dev.interfaces).slice(0,5).forEach(n=>out(`${n.padEnd(24)} Desg FWD 4`)); return []; }
    if (sub==="snmp") { out(`SNMP community: ${dev.snmpCommunity||"(none)"}  version: v2c/v3`); return []; }
    err(`% Unknown 'show' subcommand. Try 'show ?'`); return [];
  }
  return { run, prompt, pill };
}

/* ───────────────────────── Icons ───────────────────────────────────── */
const IC = {
  router:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="8" width="20" height="8" rx="2"/><path d="M6 12h.01M10 12h.01"/><path d="M18 8V6a2 2 0 00-2-2H8a2 2 0 00-2 2v2"/></svg>,
  switch:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h12M6 10v4M10 10v4M14 10v4M18 10v4"/></svg>,
  firewall:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  terminal:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  search:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  plus:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  refresh:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>,
  x:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  trash:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>,
  info:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  edit:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  layers:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>,
  back:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  check:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  archive:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8M10 12h4"/></svg>,
  history:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>,
  download:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  restore:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>,
  copy:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  diff:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/></svg>,
  clock:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  bolt:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  eye:<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  plug:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 2v6M15 2v6M12 8v4m-5 0h10a1 1 0 011 1v2a6 6 0 01-6 6 6 6 0 01-6-6v-2a1 1 0 011-1z"/></svg>,
  link:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>,
  warn:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
};
const SBIcon = ({n}) => {
  const m={
    grid:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
    devices:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
    map:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>,
    bell:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>,
    git:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/></svg>,
    archive:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8M10 12h4"/></svg>,
    chart:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    shield:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    plug:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M15 3l6 6-3 3-6-6 3-3zM9 21l-6-6 3-3 6 6-3 3z"/></svg>,
    settings:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  };
  return m[n]||null;
};
function devColor(t){ return ({router:{bg:"#1a2e3e",color:"#58a6ff"},switch:{bg:"#1a3e2a",color:"#3fb950"},firewall:{bg:"#3d2e1a",color:"#e3b341"},ap:{bg:"#2e1a3e",color:"#bc8cff"}})[t]||{bg:"#21262d",color:"#8b949e"}; }
function DevIcon({type,size=16}){ const c=devColor(type); const ico={router:IC.router,switch:IC.switch,firewall:IC.firewall}[type]||IC.switch; return <div style={{width:size+12,height:size+12,borderRadius:6,background:c.bg,color:c.color,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{React.cloneElement(ico,{width:size,height:size})}</div>; }

// Compact device summary that overlays in place (from topology/alerts/etc.)
// instead of navigating away. Live metrics come from the fleet summary map.
function QuickView({device:d, metrics, onClose, onOpenFull, onOpenConfigs}) {
  const col = devColor(d.type);
  const m = metrics || {};
  const cpu = m.cpu != null ? Math.round(m.cpu) : null;
  const mem = m.mem != null ? Math.round(m.mem) : null;
  const uptime = m.uptime || (d.uptime && d.uptime !== "—" ? d.uptime : "—");
  const ro = d.capability === "readonly";
  // recent config backups (read-only display) — skip for controller devices
  const [backups, setBackups] = useState(null);   // null=loading, []=none
  useEffect(() => {
    if (MOCK_MODE || ro) { setBackups([]); return; }
    let alive = true;
    api.listConfigs(d.id)
      .then(rows => { if (alive) setBackups((rows||[]).map(v=>({...v, ts:Date.parse(v.ts)})).sort((a,b)=>b.ts-a.ts)); })
      .catch(() => { if (alive) setBackups([]); });
    return () => { alive = false; };
  }, [d.id]);
  return (
    <>
      {/* click-away scrim — transparent so the page stays visible behind it */}
      <div className="qv-scrim" onMouseDown={onClose}/>
      <div className="qv-drawer">
        <div className="qv-hdr">
          <div className="di" style={{background:col.bg,color:col.color,width:34,height:34,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}>{IC[d.type]||IC.switch}</div>
          <div style={{flex:1,minWidth:0}}>
            <div className="qv-name">{d.name}</div>
            <div style={{fontSize:12,color:"#8b949e"}}>{d.ip} · {d.vendor} {d.model}</div>
          </div>
          <span className="qv-x" onClick={onClose} title="Close">{IC.x}</span>
        </div>
        <div className="qv-body">
          <div style={{marginBottom:12}}><span className={`sbadge ${d.status}`}><span style={{width:6,height:6,borderRadius:"50%",background:"currentColor",display:"inline-block"}}/>{d.status}</span></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            <div className="metric-card"><div className="metric-label">CPU</div><div className="metric-val">{cpu!=null?cpu+"%":"—"}</div></div>
            <div className="metric-card"><div className="metric-label">Memory</div><div className="metric-val">{mem!=null?mem+"%":"—"}</div></div>
            <div className="metric-card"><div className="metric-label">Uptime</div><div className="metric-val" style={{fontSize:14}}>{uptime}</div></div>
          </div>
          <div style={{fontSize:12,color:"#8b949e",lineHeight:1.9}}>
            <div><span style={{color:"#6e7681"}}>Type:</span> {d.type}{d.role?` · ${d.role}`:""}</div>
            <div><span style={{color:"#6e7681"}}>Protocol:</span> {d.protocol}{ro?" · read-only (controller-managed)":""}</div>
            {d.location && <div><span style={{color:"#6e7681"}}>Location:</span> {d.location}</div>}
            {d.os && <div><span style={{color:"#6e7681"}}>OS:</span> {d.os}</div>}
          </div>

          {!ro && (
            <div style={{marginTop:16}}>
              <div className="sec-title" style={{marginBottom:8}}>Recent config backups</div>
              {backups === null ? (
                <div style={{fontSize:12,color:"#8b949e"}}>Loading…</div>
              ) : backups.length === 0 ? (
                <div style={{fontSize:12,color:"#6e7681"}}>No backups yet for this device.</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {backups.slice(0,5).map((v,i)=>(
                    <div key={v.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:"#161b22",border:"1px solid #21262d",borderRadius:6}}>
                      <span style={{color:i===0?"#3fb950":"#6e7681",flexShrink:0}}>{IC.clock}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,color:"#e6edf3"}}>{tsAgo(v.ts)}{i===0 && <span style={{color:"#3fb950",marginLeft:6,fontSize:11}}>latest</span>}</div>
                        <div style={{fontSize:11,color:"#6e7681",fontFamily:"'IBM Plex Mono',monospace"}}>{tsFull(v.ts)} · #{v.hash}{v.trigger?` · ${v.trigger}`:""}</div>
                      </div>
                    </div>
                  ))}
                  {backups.length>5 && <div style={{fontSize:11,color:"#6e7681",textAlign:"center"}}>+{backups.length-5} older version{backups.length-5>1?"s":""}</div>}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="qv-footer" style={{display:"flex",gap:8}}>
          {onOpenConfigs && d.capability!=="readonly" && <button className="mbtn cancel" style={{flex:1}} onClick={onOpenConfigs}>Config archive</button>}
          <button className="mbtn add" style={{flex:1}} onClick={onOpenFull}>Full details ›</button>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Switch Faceplate ────────────────────────── */
function portShort(name){ const m=name.match(/(\d+([/.]\d+)*)$/); return m?m[1].replace(/\./g,"/"):name; }
function isMgmt(n){ return /^management/i.test(n)||n==="me0"||n.toLowerCase().startsWith("gigabitethernet0/0"); }
function isFiber(spd){ return ["10G","25G","40G","100G"].includes(spd); }
function portClass(i){ if(i.shutdown) return "admin"; if(i.status==="up") return "up"; return "down"; }

function SwitchFaceplate({device, selIface, onSelect}) {
  // Faceplate shows physical ports only. Logical interfaces (SVIs, loopbacks,
  // port-channels) are listed separately in the detail panel.
  const allEntries = Object.entries(device.interfaces || {});
  const entries = allEntries.filter(([,i]) => i.kind !== "logical");
  if (entries.length === 0) {
    return <div className="faceplate" style={{padding:"24px",textAlign:"center",color:"#6e7681",fontSize:13}}>
      No physical interface data yet for {device.name}.<br/>Interface enumeration runs on the next poll, or trigger a backup to pull live config.
    </div>;
  }
  const mgmt = entries.filter(([n])=>isMgmt(n));
  const data = entries.filter(([n])=>!isMgmt(n));
  const top = data.filter((_,i)=>i%2===0);
  const bot = data.filter((_,i)=>i%2===1);
  const Port = ([n,i]) => (
    <div key={n} className={`port ${portClass(i)} ${isFiber(i.speed)?"fiber":""} ${selIface===n?"sel":""}`}
      title={`${n}\n${i.desc||"(no description)"}\n${i.speed} · ${i.mode}${i.vlan?" · vlan "+i.vlan:""}${i.ip?" · "+i.ip:""}\nStatus: ${i.shutdown?"admin down":i.status}`}
      onClick={()=>onSelect(n)}>
      <span className="led"/><span className="pnum">{portShort(n)}</span>
    </div>
  );
  return (
    <div className="faceplate">
      <div className="fp-top">
        <span className="fp-brand">{device.vendor}</span>
        <span className="fp-model">{device.model}</span>
        <div className="fp-sysleds">
          {[["PWR","#3fb950"],["STS",device.status==="warn"?"#e3b341":"#3fb950"],["FAN","#3fb950"]].map(([l,c])=>(
            <div key={l} className="fp-sysled"><span className="led" style={{background:c}}/><span className="lbl">{l}</span></div>
          ))}
        </div>
      </div>
      <div className="fp-body">
        <div>
          <div className="fp-ports">
            <div className="fp-prow">{top.map(Port)}</div>
            <div className="fp-prow">{bot.map(Port)}</div>
          </div>
          <div className="fp-zone-lbl">{data.length} data ports</div>
        </div>
        {mgmt.length>0 && <>
          <div className="fp-zone-div"/>
          <div>
            <div className="fp-ports"><div className="fp-prow">{mgmt.map(Port)}</div></div>
            <div className="fp-zone-lbl">MGMT</div>
          </div>
        </>}
      </div>
      <div className="fp-legend">
        {[["#3fb950","Up"],["#484f58","Down"],["#f85149","Admin down"],["#58a6ff","Selected"]].map(([c,l])=>(
          <div key={l} className="fp-leg-item"><span className="fp-leg-dot" style={{background:c}}/>{l}</div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Interface Editor ────────────────────────── */
function InterfaceEditor({device, ifaceName, onBack, onApply, onSSH}) {
  const orig = device.interfaces[ifaceName];
  const [desc,setDesc]   = useState(orig.desc||"");
  const [mode,setMode]   = useState(orig.mode||"access");
  const [vlan,setVlan]   = useState(orig.vlan||"1");
  const [ip,setIp]       = useState(orig.ip?orig.ip.split("/")[0]:"");
  const [mask,setMask]   = useState(orig.ip?cidrToMask(orig.ip.split("/")[1]):"255.255.255.0");
  const [speed,setSpeed] = useState(orig.speed||"auto");
  const [enabled,setEnabled] = useState(!orig.shutdown);
  const [saved,setSaved] = useState(false);
  const [pending,setPending] = useState(null);   // {cfg, commands} awaiting confirm
  const [busy,setBusy] = useState(false);
  const [result,setResult] = useState(null);     // {ok, output, verify, error}

  const vlanOptions = Array.from(new Set([...Object.keys(device.vlans||{}), vlan])).filter(Boolean).sort((a,b)=>+a-+b);

  function buildCfg() {
    const cfg = { desc, mode, speed, shutdown:!enabled };
    if (mode==="access") { cfg.vlan=vlan; }
    else if (mode==="routed") { cfg.ip = ip?`${ip}/${maskToCidr(mask)}`:""; }
    return cfg;
  }

  function startApply() {
    if (MOCK_MODE) { onApply(ifaceName, {...buildCfg(), status: enabled?"up":"down"}); setSaved(true); setTimeout(()=>setSaved(false),3000); return; }
    const cfg = buildCfg();
    setBusy(true); setResult(null);
    api.previewIface(device.id, ifaceName, cfg)
      .then(r => { setBusy(false); setPending({ cfg, commands: r.commands }); })
      .catch(e => { setBusy(false); setResult({ ok:false, error:"Preview failed: "+e.message }); });
  }

  function confirmApply() {
    setBusy(true);
    api.applyIface(device.id, ifaceName, pending.cfg)
      .then(r => {
        setBusy(false); setPending(null); setResult(r);
        if (r.ok) { onApply(ifaceName, {...pending.cfg, status: enabled?"up":"down"}); setSaved(true); setTimeout(()=>setSaved(false),4000); }
      })
      .catch(e => { setBusy(false); setPending(null); setResult({ ok:false, error:"Apply failed: "+e.message }); });
  }
  function reset() {
    setDesc(orig.desc||""); setMode(orig.mode||"access"); setVlan(orig.vlan||"1");
    setIp(orig.ip?orig.ip.split("/")[0]:""); setMask(orig.ip?cidrToMask(orig.ip.split("/")[1]):"255.255.255.0");
    setSpeed(orig.speed||"auto"); setEnabled(!orig.shutdown);
  }

  return (
    <div className="dpane">
      <div className="ed-back" onClick={onBack}>{IC.back} Back to device</div>
      <div>
        <div className="ed-title">{ifaceName}</div>
        <div className="dsub">{device.name} · {device.vendor} · {orig.speed}</div>
      </div>

      <div className="tgl-row">
        <span className="tgl-label">Admin status — <span style={{color:enabled?"#3fb950":"#f85149"}}>{enabled?"enabled":"shutdown"}</span></span>
        <div className={`tgl ${enabled?"on":""}`} onClick={()=>setEnabled(v=>!v)}/>
      </div>

      <div className="ed-field">
        <label className="ed-label">Description</label>
        <input className="ed-input" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="e.g. Server-rack-A port 12"/>
      </div>

      <div className="ed-field">
        <label className="ed-label">Port mode</label>
        <div className="seg">
          {["access","trunk","routed"].map(m=>(
            <button key={m} className={`seg-btn ${mode===m?"on":""}`} onClick={()=>setMode(m)}>{m[0].toUpperCase()+m.slice(1)}</button>
          ))}
        </div>
      </div>

      {mode==="access" && (
        <div className="ed-field">
          <label className="ed-label">Access VLAN</label>
          <select className="ed-select" value={vlan} onChange={e=>setVlan(e.target.value)}>
            {vlanOptions.map(id=><option key={id} value={id}>VLAN {id} — {device.vlans[id]?.name||"unnamed"}</option>)}
          </select>
        </div>
      )}
      {mode==="trunk" && (
        <div className="ed-field">
          <label className="ed-label">Allowed VLANs (trunk)</label>
          <input className="ed-input" defaultValue={Object.keys(device.vlans||{}).join(",")} placeholder="1,10,20,100"/>
        </div>
      )}
      {mode==="routed" && (
        <div className="ed-field">
          <label className="ed-label">IP address / mask</label>
          <div className="frow2">
            <input className="ed-input" value={ip} onChange={e=>setIp(e.target.value)} placeholder="10.0.1.1"/>
            <input className="ed-input" value={mask} onChange={e=>setMask(e.target.value)} placeholder="255.255.255.0"/>
          </div>
        </div>
      )}

      <div className="ed-field">
        <label className="ed-label">Speed / duplex</label>
        <select className="ed-select" value={speed} onChange={e=>setSpeed(e.target.value)}>
          {["auto","100M","1G","10G","25G","40G","100G"].map(s=><option key={s} value={s}>{s==="auto"?"Auto-negotiate":s}</option>)}
        </select>
      </div>

      <div className="ed-field">
        <label className="ed-label">Generated config — pushed via {device.protocol}</label>
        <div className="cli-preview">
          <div className="cl h">interface {ifaceName}</div>
          {desc ? <div className="cl b">description {desc}</div> : <div className="cl neg">no description</div>}
          {mode==="access" && <><div className="cl b">switchport mode access</div><div className="cl b">switchport access vlan {vlan}</div></>}
          {mode==="trunk" && <div className="cl b">switchport mode trunk</div>}
          {mode==="routed" && (ip ? <div className="cl b">ip address {ip} {mask}</div> : <div className="cl b">no ip address</div>)}
          {speed!=="auto" && <div className="cl b">speed {speed.replace("M","").replace("G","000")==="100"?"100":speed}</div>}
          <div className={`cl ${enabled?"b":"neg"}`}>{enabled?"no shutdown":"shutdown"}</div>
        </div>
      </div>

      {saved && <div className="saved-toast">{IC.check} Configuration applied to {device.name} via SSH</div>}

      {pending && (
        <div style={{background:"#0d1117",border:"1px solid #d29922",borderRadius:8,padding:"12px 14px",marginTop:12}}>
          <div style={{fontSize:12,fontWeight:600,color:"#e3b341",marginBottom:8}}>Review commands to send to {device.name} ({device.ip})</div>
          <pre style={{fontSize:11,fontFamily:"'IBM Plex Mono',monospace",color:"#cdd9e5",background:"#010409",padding:"8px 10px",borderRadius:6,overflow:"auto",margin:0,whiteSpace:"pre-wrap"}}>{Array.isArray(pending.commands)?pending.commands.join("\n"):String(pending.commands||"")}</pre>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button className="ed-btn reset" onClick={()=>setPending(null)} disabled={busy}>Cancel</button>
            <button className="ed-btn apply" onClick={confirmApply} disabled={busy}>{busy?"Sending…":"Confirm & send to device"}</button>
          </div>
        </div>
      )}

      {result && (
        <div style={{background:"#0d1117",border:`1px solid ${result.ok?"#238636":"#f85149"}`,borderRadius:8,padding:"12px 14px",marginTop:12}}>
          <div style={{fontSize:12,fontWeight:600,color:result.ok?"#3fb950":"#f85149",marginBottom:8}}>
            {result.ok ? "✓ Applied successfully" : "✗ " + (result.error || "Device reported errors")}
          </div>
          {result.errors && result.errors.length>0 && <pre style={{fontSize:11,color:"#f85149",background:"#010409",padding:"8px 10px",borderRadius:6,margin:"0 0 8px",whiteSpace:"pre-wrap"}}>{result.errors.join("\n")}</pre>}
          {result.verify && <><div style={{fontSize:11,color:"#8b949e",marginBottom:4}}>Device config now:</div><pre style={{fontSize:11,fontFamily:"'IBM Plex Mono',monospace",color:"#cdd9e5",background:"#010409",padding:"8px 10px",borderRadius:6,overflow:"auto",margin:0,maxHeight:160,whiteSpace:"pre-wrap"}}>{result.verify}</pre></>}
        </div>
      )}

      <div className="ed-actions">
        <button className="ed-btn reset" onClick={reset} disabled={busy}>Reset</button>
        <button className="ed-btn apply" onClick={startApply} disabled={busy||!!pending}>{IC.check} {busy&&!pending?"Checking…":"Apply changes"}</button>
        <button className="ed-btn ssh" title="Configure via SSH terminal instead" onClick={onSSH}>{IC.terminal}</button>
      </div>
    </div>
  );
}

/* ───────────────────────── SSH Terminal ────────────────────────────── */
function SSHPane({device, onUpdate}) {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [pr, setPr] = useState({label:`${device.hostname}#`,cls:"exec"});
  const [pl, setPl] = useState({label:"EXEC",cls:"exec"});
  const cliRef = useRef(null); const termRef = useRef(null); const inputRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => { cliRef.current = buildCLI(device, onUpdate); setPr(cliRef.current.prompt()); setPl(cliRef.current.pill()); }, [device.id]);
  useEffect(()=>{ if(termRef.current) termRef.current.scrollTop=termRef.current.scrollHeight; },[lines]);
  useEffect(()=>()=>{ wsRef.current?.close(); }, []);   // close socket on unmount

  function connect() {
    setLines([]); setConnected(false);
    if (!MOCK_MODE) {
      // Real backend: open the authenticated WebSocket SSH stream.
      setLines([{type:"sys",text:`# Connecting to ${device.name} (${device.ip})…`}]);
      const ws = api.connectSSH(device.id);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => setLines(p=>[...p,{type:"out",text:e.data}]);
      ws.onclose = (e) => { setConnected(false); setLines(p=>[...p,{type:"sys",text: e.code===4401?"# Unauthorized — please sign in again.":"# Connection closed."}]); };
      ws.onerror = () => setLines(p=>[...p,{type:"err",text:"# WebSocket error."}]);
      return;
    }
    const steps=[
      [0,{t:"sys",m:`# SwitchDex SSH Gateway v2.0`}],
      [0,{t:"sys",m:`# Connecting to ${device.name} (${device.ip}:${device.sshPort})`}],
      [300,{t:"sys",m:"# TCP SYN...ACK (RTT 2ms)"}],
      [700,{t:"sys",m:"# SSH-2.0 — key exchange: curve25519-sha256"}],
      [1050,{t:"sys",m:"# Host key verification: OK"}],
      [1400,{t:"sys",m:`# Authenticating as netops...`}],
      [1900,{t:"info",m:`Connected to ${device.vendor} ${device.model} (${device.os})`}],
      [1901,{t:"sys",m:`# Type '?' for help. Use 'conf t' to configure.`}],
    ];
    steps.forEach(([d,l])=>setTimeout(()=>{ setLines(p=>[...p,{type:l.t,text:l.m}]); if(l.t==="info")setConnected(true); },d));
  }
  function submit() {
    const cmd=input.trim(); setInput(""); setHistIdx(-1); if(!cmd) return;
    setHistory(p=>[cmd,...p.slice(0,49)]);
    if (!MOCK_MODE) {
      // Real backend: echo locally and stream the command to the device shell.
      setLines(p=>[...p,{type:"prompt",text:`${pr.label} ${cmd}`}]);
      if(cmd==="clear"||cmd.toLowerCase()==="cls"){setLines([]);return;}
      wsRef.current?.send(cmd + "\n");
      return;
    }
    const cli=cliRef.current; const prNow=cli.prompt();
    const pcls=prNow.cls==="exec"?"prompt":prNow.cls==="config"?"prompt c":"prompt s";
    const promptLine={type:pcls,text:`${prNow.label} ${cmd}`};
    if(cmd==="clear"||cmd.toLowerCase()==="cls"){setLines([]);return;}
    const res=cli.run(cmd); setPr(cli.prompt()); setPl(cli.pill());
    if(res.some(r=>r.type==="sys_exit")){setLines(p=>[...p,promptLine,{type:"sys",text:"# Connection closed."}]);setConnected(false);return;}
    if(res.some(r=>r.type==="clear")){setLines([]);return;}
    setLines(p=>[...p,promptLine,...res]);
  }
  function onKey(e){
    if(e.key==="Enter"){submit();return;}
    if(e.key==="ArrowUp"){e.preventDefault();const i=Math.min(histIdx+1,history.length-1);setHistIdx(i);setInput(history[i]||"");}
    if(e.key==="ArrowDown"){e.preventDefault();const i=Math.max(histIdx-1,-1);setHistIdx(i);setInput(i===-1?"":history[i]||"");}
  }
  const modeColors={exec:"#39d353",config:"#58a6ff",sub:"#bc8cff",line:"#e3b341"};
  return (
    <div className="ssh-pane">
      <div className="ssh-hdr">
        <div className="ssh-dot" style={{background:connected?"#3fb950":"#3d4451"}}/>
        <span className="ssh-st">{connected?`${device.name} — ${device.ip} (${device.os})`:"Not connected"}</span>
        {connected && <span className={`mode-pill ${pl.cls}`}>{pl.label} MODE</span>}
        {!connected ? <button className="scb conn" onClick={connect}>Connect</button>
                    : <button className="scb disc" onClick={()=>{wsRef.current?.close();setConnected(false);setLines(p=>[...p,{type:"sys",text:"# Disconnected."}]);}}>Disconnect</button>}
      </div>
      <div className="terminal" ref={termRef} onClick={()=>inputRef.current?.focus()}>
        {lines.length===0 && <div className="tl sys"># Click Connect to open an SSH session to {device.name}</div>}
        {lines.map((l,i)=><div key={i} className={`tl ${l.type}`}>{l.text}</div>)}
      </div>
      <div className="tin-row">
        <span className="tprompt" style={{color:modeColors[pr.cls]||"#39d353"}}>{pr.label}</span>
        <input ref={inputRef} className="tinput" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={onKey} disabled={!connected} placeholder={connected?"type command or '?' for help…":""} spellCheck={false} autoComplete="off"/>
      </div>
    </div>
  );
}

/* ───────────────────────── Add Device Modal ────────────────────────── */
const VENDORS = [
  {vendor:"Arista",model:"DCS-7050CX3",os:"EOS 4.28.3M",type:"switch",sysDescr:"Arista Networks EOS version 4.28.3M running on DCS-7050CX3"},
  {vendor:"Cisco",model:"Catalyst 9300",os:"IOS-XE 17.9.3",type:"switch",sysDescr:"Cisco IOS Software, Catalyst L3 Switch Software"},
  {vendor:"Juniper",model:"EX4300-48T",os:"Junos 21.4R3",type:"switch",sysDescr:"Juniper Networks EX Series Ethernet Switch"},
  {vendor:"SONiC",model:"AS9516-32D",os:"SONiC 202205",type:"switch",sysDescr:"SONiC Software Version: SONiC.202205.1"},
];
function fingerprint(ip){ const seed=(ip.split(".").reduce((a,o)=>a+parseInt(o||0),0))%VENDORS.length; return VENDORS[seed]; }

function AddDeviceModal({onClose, onAdd}) {
  const [ip,setIp]=useState(""); const [authMode,setAuthMode]=useState("snmpv2");
  const [community,setCommunity]=useState("public"); const [snmpUser,setSnmpUser]=useState("");
  const [sshUser,setSshUser]=useState("netops"); const [sshPass,setSshPass]=useState(""); const [phase,setPhase]=useState("form");
  const [probeLog,setProbeLog]=useState([]); const [discovered,setDiscovered]=useState(null);
  const [devName,setDevName]=useState(""); const [devLocation,setDevLocation]=useState(""); const logRef=useRef(null);
  useEffect(()=>{ if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight; },[probeLog]);
  const addLog=(m,t="sys")=>setProbeLog(p=>[...p,{m,t}]);

  function startProbe() {
    if(!ip.trim())return; setPhase("probing"); setProbeLog([]);
    if (!MOCK_MODE) {
      // Real probe — ask the backend to query the device (SNMP/SSH).
      addLog(`Initiating discovery of ${ip}...`);
      addLog(authMode.startsWith("snmp")?`[→] SNMP ${authMode==="snmpv2"?"v2c":"v3"} — querying sysDescr...`:`[→] SSH ${ip} — grabbing banner...`);
      api.probeDevice({ ip, auth: authMode,
                        community: authMode.startsWith("snmp") ? community : "public",
                        username: authMode==="ssh"?sshUser:"", password: authMode==="ssh"?sshPass:"" })
        .then(fp => {
          if (!fp || fp.reachable === false) { addLog(`[✗] No response from ${ip}. Check reachability/credentials.`,"err"); setPhase("error"); return; }
          addLog(`[✓] sysDescr: "${fp.sysdescr||fp.os||""}"`,"info");
          addLog(`[✓] Vendor: ${fp.vendor}  Model: ${fp.model||"(unknown)"}`,"ok");
          addLog(`[✓] OS: ${fp.os||"(unknown)"}`,"ok");
          if (fp.hostname) addLog(`[✓] sysName: ${fp.hostname}`,"ok");
          if (fp.location) addLog(`[✓] sysLocation: ${fp.location}`,"ok");
          // Prefer the device's own sysName; fall back to a vendor-ip name.
          const name = fp.hostname || `${(fp.vendor||"device").toLowerCase()}-${(ip.split(".").pop()||"00").padStart(2,"0")}`;
          setDevName(name); setDevLocation(fp.location || "");
          setDiscovered({...fp, ip, name, location: fp.location || "", community});
          setPhase("discovered");
        })
        .catch(e => { addLog(`[✗] Probe failed: ${e.message}`,"err"); setPhase("error"); });
      return;
    }
    // ── simulated probe (demo only) ──
    const fp=fingerprint(ip);
    const steps=[
      [0,()=>addLog(`Initiating discovery of ${ip}...`)],
      [200,()=>addLog(`[→] ICMP ping ${ip}...`)],
      [600,()=>addLog(`[✓] Host reachable — RTT 2ms`,"ok")],
      [900,()=>addLog(authMode.startsWith("snmp")?`[→] SNMP ${authMode==="snmpv2"?"v2c community '"+community+"'":"v3 user '"+snmpUser+"'"} get sysDescr...`:`[→] SSH ${ip}:22 as ${sshUser}...`)],
      [1400,()=>addLog(authMode==="ssh"?`[✓] SSH authenticated — banner grabbed`:`[✓] SNMP auth accepted`,"ok")],
      [1800,()=>addLog(`[✓] sysDescr: "${fp.sysDescr}"`,"info")],
      [2200,()=>addLog(`[→] Pulling ifTable, entPhysicalTable, dot1q VLANs...`)],
      [2700,()=>addLog(`[✓] Vendor: ${fp.vendor}  Model: ${fp.model}`,"ok")],
      [3000,()=>addLog(`[✓] OS: ${fp.os}  ·  24 interfaces enumerated`,"ok")],
      [3300,()=>{ const name=`${fp.vendor.toLowerCase()}-sw-${(ip.split(".").pop()||"00").padStart(2,"0")}`; setDevName(name); setDiscovered({...fp,ip,name,community}); setPhase("discovered"); }],
    ];
    steps.forEach(([d,fn])=>setTimeout(fn,d));
  }
  function confirmAdd() {
    const d=discovered;
    const base={ id:Date.now(), name:devName||d.name, ip:d.ip, vendor:d.vendor, model:d.model, os:d.os,
      type:d.device_type||d.type||"switch", platform:d.platform,
      protocol:authMode.startsWith("snmp")?"SNMP":"SSH", status:"up",
      uptime:"0d 0h", location:devLocation||d.location||"Unknown", sshPort:22, hostname:devName||d.name,
      snmpCommunity:authMode.startsWith("snmp")?community:"public", ntpServers:[],
      bgpPeers:[], ospfNets:[], staticRoutes:[], aclDefs:[] };
    if (MOCK_MODE) {
      // demo only: synthesize a believable faceplate
      onAdd({ ...base, cpu:Math.floor(Math.random()*25+8), mem:Math.floor(Math.random()*40+20),
        interfaces:genSwitchIfaces(d.vendor,24,2),
        vlans:{"1":{name:"default",status:"active"},"100":{name:"USERS",status:"active"},"20":{name:"SERVERS",status:"active"}} });
    } else {
      // real device: no fabricated data — interfaces/VLANs come from the backend poll
      onAdd({ ...base, cpu:0, mem:0, interfaces:{}, vlans:{} });
    }
    onClose();
  }

  return (
    <div className="overlay">
      <div className="modal">
        <div className="modal-hdr">
          <div>
            <div className="modal-title">Add device manually</div>
            <div className="modal-sub">{phase==="form"?"Enter device IP and credentials to probe and identify.":phase==="probing"?"Probing — please wait...":phase==="error"?"Discovery failed — check the log below.":"Device discovered."}</div>
          </div>
          <div style={{cursor:"pointer",color:"#8b949e",padding:"0 0 0 12px"}} onClick={onClose}>{IC.x}</div>
        </div>
        <div className="modal-body">
          {phase==="form" && <>
            <label className="flabel">Device IP address</label>
            <input className="finput" value={ip} onChange={e=>setIp(e.target.value)} placeholder="e.g. 10.0.1.20" autoFocus onKeyDown={e=>e.key==="Enter"&&ip.trim()&&startProbe()}/>
            <label className="flabel" style={{marginBottom:8}}>Authentication method</label>
            <div className="auth-tabs">
              {[["snmpv2","SNMPv2c"],["snmpv3","SNMPv3"],["ssh","SSH"]].map(([k,l])=>(
                <button key={k} className={`auth-tab ${authMode===k?"on":""}`} onClick={()=>setAuthMode(k)}>{l}</button>
              ))}
            </div>
            {authMode==="snmpv2" && <><label className="flabel">Community string</label><input className="finput" value={community} onChange={e=>setCommunity(e.target.value)} placeholder="public"/></>}
            {authMode==="snmpv3" && <><div className="frow" style={{marginBottom:12}}><div><label className="flabel">Username</label><input className="finput" value={snmpUser} onChange={e=>setSnmpUser(e.target.value)} placeholder="netops"/></div><div><label className="flabel">Auth pass</label><input className="finput" type="password" placeholder="••••••••"/></div></div><label className="flabel">Auth / Priv</label><select className="finput"><option>SHA / AES-128</option><option>SHA-256 / AES-256</option></select></>}
            {authMode==="ssh" && <><div className="frow" style={{marginBottom:12}}><div><label className="flabel">Username</label><input className="finput" value={sshUser} onChange={e=>setSshUser(e.target.value)}/></div><div><label className="flabel">Password</label><input className="finput" type="password" value={sshPass} onChange={e=>setSshPass(e.target.value)} placeholder="••••••••"/></div></div></>}
          </>}
          {(phase==="probing"||phase==="discovered"||phase==="error") && <>
            {phase==="probing" && <div className="prog-bar"><div className="prog-fill" style={{width:"100%",animation:"prog 3.2s linear forwards"}}/></div>}
            <div className="probe-log" ref={logRef}>{probeLog.map((l,i)=><div key={i} className={`pl ${l.t} ${phase==="probing"&&i===probeLog.length-1?"spin":""}`}>{l.m}</div>)}</div>
          </>}
          {phase==="discovered" && discovered && <>
            <div className="discovered-card">
              <DevIcon type={discovered.type} size={20}/>
              <div className="disc-info">
                <div className="disc-name">{discovered.vendor} {discovered.model}</div>
                <div className="disc-meta">{discovered.ip}  ·  {authMode.toUpperCase()}  ·  port 22</div>
                <div className="disc-vendor">{discovered.os}</div>
              </div>
            </div>
            <label className="flabel">Device name (editable)</label>
            <input className="finput" value={devName} onChange={e=>setDevName(e.target.value)}/>
            <label className="flabel">Location (editable)</label>
            <input className="finput" value={devLocation} onChange={e=>setDevLocation(e.target.value)} placeholder={discovered.location ? "" : "e.g. DC1-Rack-A3 (not reported by device)"}/>
          </>}
        </div>
        <div className="modal-footer">
          <button className="mbtn cancel" onClick={onClose}>Cancel</button>
          {phase==="form" && <button className="mbtn go" onClick={startProbe} disabled={!ip.trim()}>Probe device</button>}
          {phase==="error" && <button className="mbtn go" onClick={()=>setPhase("form")}>Back / try again</button>}
          {phase==="discovered" && <button className="mbtn add" onClick={confirmAdd}>Add to inventory</button>}
        </div>
      </div>
      <style>{`@keyframes prog{from{width:0%}to{width:100%}}`}</style>
    </div>
  );
}

/* ───────────────────────── Edit Device Modal ──────────────────────── */
function EditDeviceModal({device, onClose, onSaved}) {
  const [name, setName] = useState(device.name || "");
  const [location, setLocation] = useState(device.location || "");
  const [protocol, setProtocol] = useState(device.protocol || "SNMP");
  const [sshPort, setSshPort] = useState(device.sshPort || 22);
  const [sshUser, setSshUser] = useState(device.sshUsername || "");
  const [snmpComm, setSnmpComm] = useState(device.snmpCommunity || "");
  const [sshPass, setSshPass] = useState("");        // write-only; blank = leave unchanged
  const [changePw, setChangePw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function save() {
    setErr(""); setBusy(true);
    const patch = { name, location, protocol, ssh_port: Number(sshPort) || 22,
                    ssh_username: sshUser, snmp_community: snmpComm };
    if (changePw) patch.ssh_password = sshPass;   // only send when explicitly changing
    if (MOCK_MODE) { setTimeout(()=>{ setBusy(false); onSaved({ ...device, name, hostname:name, location, protocol, sshPort:Number(sshPort)||22, sshUsername:sshUser, snmpCommunity:snmpComm, hasSshPassword: changePw ? !!sshPass : device.hasSshPassword }); }, 350); return; }
    api.editDevice(device.id, patch)
      .then(updated => { setBusy(false); onSaved(updated); })
      .catch(e => { setBusy(false); setErr(e.message || "Update failed."); });
  }

  return (
    <div className="overlay" onMouseDown={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-hdr">
          <div>
            <div className="modal-title">Edit device</div>
            <div className="modal-sub">{device.ip} · {device.vendor}{device.model?` ${device.model}`:""}</div>
          </div>
          <div style={{cursor:"pointer",color:"#8b949e"}} onClick={onClose}>{IC.x}</div>
        </div>
        <div className="modal-body">
          {err && <div style={{background:"#3d1a1a",color:"#f85149",border:"1px solid #5c2626",borderRadius:6,padding:"7px 10px",fontSize:12,marginBottom:12}}>{err}</div>}

          <label className="flabel">Display name</label>
          <input className="finput" value={name} onChange={e=>setName(e.target.value)} placeholder="device name" autoFocus/>

          <label className="flabel">Location</label>
          <input className="finput" value={location} onChange={e=>setLocation(e.target.value)} placeholder="e.g. DC1-Rack-A3 / Branch closet"/>

          <label className="flabel">Management protocol</label>
          <div className="auth-tabs">
            {["SNMP","SSH"].map(p=>(
              <button key={p} className={`auth-tab ${protocol===p?"on":""}`} onClick={()=>setProtocol(p)}>{p}</button>
            ))}
          </div>

          <div className="frow" style={{marginBottom:12}}>
            <div><label className="flabel">SNMP community</label><input className="finput" value={snmpComm} onChange={e=>setSnmpComm(e.target.value)} placeholder="public"/></div>
            <div><label className="flabel">SSH username</label><input className="finput" value={sshUser} onChange={e=>setSshUser(e.target.value)} placeholder="admin"/></div>
          </div>

          <label className="flabel">SSH password</label>
          {!changePw ? (
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{fontSize:12,color:"#8b949e"}}>{device.hasSshPassword ? "•••••••• (set)" : "(not set)"}</span>
              <button className="fbtn" onClick={()=>setChangePw(true)}>{device.hasSshPassword?"Change":"Set password"}</button>
            </div>
          ) : (
            <div style={{marginBottom:12}}>
              <input className="finput" type="password" value={sshPass} onChange={e=>setSshPass(e.target.value)} placeholder="new SSH password" style={{marginBottom:6}}/>
              <span style={{fontSize:11,color:"#6e7681",cursor:"pointer"}} onClick={()=>{setChangePw(false);setSshPass("");}}>Cancel password change</span>
            </div>
          )}

          <div className="frow">
            <div><label className="flabel">SSH port</label><input className="finput" value={sshPort} onChange={e=>setSshPort(e.target.value)} style={{marginBottom:0}}/></div>
            <div/>
          </div>
        </div>
        <div className="modal-footer">
          <button className="mbtn cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="mbtn go" onClick={save} disabled={busy||!name.trim()}>{busy?"Saving…":"Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Config Archive (device tab) ─────────────── */
function ConfigArchive({device, archive, onBackup, onRestore}) {
  const [versions, setVersions] = useState([]);     // normalized: ts in ms (newest first)
  const [loading, setLoading] = useState(!MOCK_MODE);
  const [loadErr, setLoadErr] = useState("");
  const [mode, setMode] = useState("list");          // list | view | diff
  const [viewVer, setViewVer] = useState(null);
  const [viewText, setViewText] = useState("");
  const [viewLoading, setViewLoading] = useState(false);
  const [sel, setSel] = useState([]);                // selected version ids for diff
  const [diffData, setDiffData] = useState(null);    // { rows, added, removed, a, b, error }
  const [diffLoading, setDiffLoading] = useState(false);
  const [busy, setBusy] = useState(false);           // backup-now in flight
  const [restoring, setRestoring] = useState(false);
  const [banner, setBanner] = useState(null);        // { kind:'ok'|'warn'|'err', text }
  const [confirmRestore, setConfirmRestore] = useState(null);
  // per-device archive settings (enable + interval), seeded from the device
  const [bkEnabled, setBkEnabled] = useState(device.backupEnabled !== false);
  const [bkInterval, setBkInterval] = useState(device.backupIntervalHours || 24);
  const [bkSaved, setBkSaved] = useState(false);
  function saveBackupSettings(enabled, interval){
    setBkEnabled(enabled); setBkInterval(interval);
    if (MOCK_MODE) { setBkSaved(true); setTimeout(()=>setBkSaved(false),1500); return; }
    api.editDevice(device.id, {backup_enabled:enabled, backup_interval_hours:Number(interval)})
      .then(()=>{ setBkSaved(true); setTimeout(()=>setBkSaved(false),1500); })
      .catch(()=>{});
  }
  const textCache = useRef({});                      // version id -> config text

  const readOnly = device.capability === "readonly";

  // ── load the version list ────────────────────────────────────────────
  function loadVersions() {
    setLoading(true); setLoadErr("");
    return api.listConfigs(device.id)
      .then(rows => {
        const norm = (rows || [])
          .map(v => ({ ...v, ts: Date.parse(v.ts) }))
          .sort((a, b) => b.ts - a.ts);
        setVersions(norm);
      })
      .catch(e => setLoadErr(e.message || "Failed to load version history"))
      .finally(() => setLoading(false));
  }

  // Real mode: fetch on device change. Mock mode: derive from the archive prop.
  useEffect(() => { if (!MOCK_MODE) loadVersions(); }, [device.id]);
  useEffect(() => {
    if (!MOCK_MODE) return;
    const entry = archive[device.id] || { versions: [] };
    setVersions([...entry.versions].sort((a, b) => b.ts - a.ts));
    setLoading(false);
  }, [archive, device.id]);

  function flash(kind, text) { setBanner({ kind, text }); }
  function toggleSel(id) {
    setSel(s => s.includes(id) ? s.filter(x => x !== id) : (s.length >= 2 ? [s[1], id] : [...s, id]));
  }
  function copyText(t) { navigator.clipboard?.writeText(t).catch(() => {}); }
  function downloadCfg(v, text) {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${device.hostname}_${new Date(v.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.cfg`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ── view a single version (text fetched lazily, then cached) ──────────
  function openView(v) {
    setViewVer(v); setMode("view");
    if (MOCK_MODE) { setViewText(v.text || ""); return; }
    if (textCache.current[v.id] != null) { setViewText(textCache.current[v.id]); return; }
    setViewLoading(true); setViewText("");
    api.getConfig(device.id, v.id)
      .then(r => { const t = r.text || ""; textCache.current[v.id] = t; setViewText(t); })
      .catch(e => setViewText(`! failed to load config: ${e.message}`))
      .finally(() => setViewLoading(false));
  }

  // ── diff two versions (server-side git diff in real mode) ─────────────
  function openDiff() {
    if (sel.length !== 2) return;
    const [a, b] = sel.map(id => versions.find(v => v.id === id)).sort((x, y) => x.ts - y.ts); // older → newer
    setMode("diff");
    if (MOCK_MODE) {
      const d = diffConfig(a.text, b.text);
      setDiffData({ rows: d, ...diffStats(d), a, b });
      return;
    }
    setDiffLoading(true); setDiffData({ a, b });
    api.diffConfigs(device.id, a.id, b.id)
      .then(r => setDiffData({ a, b, ...parseUnifiedDiff(r.diff || "") }))
      .catch(e => setDiffData({ a, b, error: e.message }))
      .finally(() => setDiffLoading(false));
  }

  // ── back up now ───────────────────────────────────────────────────────
  function runBackup() {
    if (MOCK_MODE) { setBusy(true); setTimeout(() => { onBackup(device.id); setBusy(false); }, 1400); return; }
    setBusy(true); setBanner(null);
    api.backupDevice(device.id)
      .then(r => {
        if (r && r.ok === false) { flash("err", "Backup failed: " + (r.error || "unknown error")); return; }
        if (r && r.changed === false) flash("warn", `No changes — running-config matches the latest archived version (#${r.hash}).`);
        else flash("ok", `New version archived${r && r.hash ? ` (#${r.hash})` : ""}.`);
        return loadVersions();
      })
      .catch(e => flash("err", "Backup failed: " + e.message))
      .finally(() => setBusy(false));
  }

  // ── restore a version to the live device ──────────────────────────────
  function doRestore(v) {
    setConfirmRestore(null);
    if (MOCK_MODE) { onRestore(device.id, v); setMode("list"); return; }
    setRestoring(true); setBanner(null);
    api.restoreConfig(device.id, v.id)
      .then(r => {
        if (r && r.ok === false) { flash("err", "Restore failed: " + (r.error || "unknown error")); return; }
        flash("ok", `Restored snapshot #${v.hash} — pushed to ${device.hostname} and saved. A new archive version was recorded.`);
        setMode("list");
        return loadVersions();
      })
      .catch(e => flash("err", "Restore failed: " + e.message))
      .finally(() => setRestoring(false));
  }

  const bannerEl = banner && (
    <div className={`cfg-banner ${banner.kind}`}>
      {banner.kind === "ok" ? IC.check : IC.warn}
      <span>{banner.text}</span>
      <span className="bx" onClick={() => setBanner(null)}>{IC.x}</span>
    </div>
  );

  // ── VIEW MODE ─────────────────────────────────────────────────────────
  if (mode === "view" && viewVer) {
    const lines = viewText.split("\n");
    return (
      <div className="dpane">
        <div className="ed-back" onClick={() => setMode("list")}>{IC.back} Back to history</div>
        {bannerEl}
        <div>
          <div className="ed-title" style={{ fontSize: 14 }}>{device.hostname} config</div>
          <div className="dsub">{tsFull(viewVer.ts)} · {viewVer.lines} lines · {viewVer.bytes} bytes · #{viewVer.hash}</div>
        </div>
        <div className="cfg-toolbar">
          <button className="cfg-btn" disabled={viewLoading || !viewText} onClick={() => copyText(viewText)}>{IC.copy} Copy</button>
          <button className="cfg-btn" disabled={viewLoading || !viewText} onClick={() => downloadCfg(viewVer, viewText)}>{IC.download} Download</button>
          {!readOnly && <button className="cfg-btn" disabled={viewLoading} onClick={() => setConfirmRestore(viewVer)}>{IC.restore} Restore this</button>}
        </div>
        {viewLoading ? (
          <div className="cfg-loading"><span className="cfg-spin" /> Fetching archived config…</div>
        ) : (
          <div className="cfg-view">
            {lines.map((l, i) => <div key={i} className="cv"><span className="ln">{i + 1}</span>{l}</div>)}
          </div>
        )}
        {confirmRestore && <RestoreConfirm device={device} version={confirmRestore} busy={restoring}
          onCancel={() => setConfirmRestore(null)} onConfirm={() => doRestore(confirmRestore)} />}
      </div>
    );
  }

  // ── DIFF MODE ─────────────────────────────────────────────────────────
  if (mode === "diff" && diffData) {
    const { a, b, rows, added, removed, error } = diffData;
    // Server diffs are already hunked; client (mock) diffs need context collapse.
    const hasHunks = rows && rows.some(r => r.type === "hunk");
    const display = !rows ? [] : (hasHunks ? rows : rows.filter((x, i, arr) => {
      if (x.type !== "ctx") return true;
      return arr.slice(Math.max(0, i - 2), i + 3).some(y => y.type !== "ctx");
    }));
    return (
      <div className="dpane">
        <div className="ed-back" onClick={() => setMode("list")}>{IC.back} Back to history</div>
        {bannerEl}
        <div className="ed-title" style={{ fontSize: 14 }}>Compare versions</div>
        <div className="diff-hdr">
          <span className="minus pm">− {tsAgo(a.ts)} (#{a.hash})</span>
          <span style={{ color: "#484f58" }}>→</span>
          <span className="plus pm">+ {tsAgo(b.ts)} (#{b.hash})</span>
          {!diffLoading && !error && <span style={{ marginLeft: "auto" }}><span className="plus">+{added}</span> <span className="minus">−{removed}</span></span>}
        </div>
        {diffLoading ? (
          <div className="cfg-loading"><span className="cfg-spin" /> Computing diff…</div>
        ) : error ? (
          <div className="cfg-banner err">{IC.warn}<span>Could not compute diff: {error}</span></div>
        ) : display.length === 0 ? (
          <div className="cfg-empty">No differences — these two versions are identical.</div>
        ) : (
          <div className="diff-view">
            {display.map((x, i) => (
              <div key={i} className={`dv ${x.type}`}>
                <span className="gut">{x.type === "add" ? "+" : x.type === "del" ? "−" : x.type === "hunk" ? "⋯" : " "}</span>{x.text || " "}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── LIST MODE ─────────────────────────────────────────────────────────
  return (
    <div className="dpane">
      <div className="dhdr">
        <DevIcon type={device.type} size={20} />
        <div>
          <div className="dname">{device.hostname}</div>
          <div className="dsub">{versions.length} archived version{versions.length === 1 ? "" : "s"} · pulled via {device.protocol === "SNMP" ? "SSH" : device.protocol}</div>
        </div>
      </div>

      {bannerEl}

      {readOnly ? (
        <div className="cfg-empty">This device is controller-managed (read-only). Config archival is handled by its controller and isn't available here.</div>
      ) : (
      <>
      <div className="cfg-toolbar">
        <button className="cfg-btn primary" onClick={runBackup} disabled={busy || restoring}>
          {busy ? IC.clock : IC.download} {busy ? "Pulling config…" : "Back up now"}
        </button>
        <button className="cfg-btn" disabled={sel.length !== 2} onClick={openDiff}>{IC.diff} Compare ({sel.length}/2)</button>
      </div>

      <div className="sched-bar" style={{marginBottom:12}}>
        <div style={{width:34,height:34,borderRadius:8,background:"#1a2e3e",color:"#58a6ff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{IC.clock}</div>
        <div className="sched-info">
          <div className="sched-title">Automatic archiving</div>
          <div className="sched-sub">
            {bkEnabled ? `Backed up every ${bkInterval}h, new version only on change` : "Disabled — this device is not archived automatically"}
            {device.lastBackupAt && bkEnabled ? ` · last run ${tsAgo(Date.parse(device.lastBackupAt))}` : ""}
            {bkSaved && <span style={{color:"#3fb950",marginLeft:8}}>✓ saved</span>}
          </div>
        </div>
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#e6edf3",cursor:"pointer",marginRight:10}}>
          <input type="checkbox" checked={bkEnabled} onChange={e=>saveBackupSettings(e.target.checked, bkInterval)}/> Enabled
        </label>
        <select className="finput" style={{width:120}} value={bkInterval} disabled={!bkEnabled}
          onChange={e=>saveBackupSettings(bkEnabled, e.target.value)}>
          <option value={1}>Every hour</option>
          <option value={6}>Every 6h</option>
          <option value={12}>Every 12h</option>
          <option value={24}>Daily</option>
          <option value={168}>Weekly</option>
        </select>
      </div>

      {loading ? (
        <div className="cfg-loading"><span className="cfg-spin" /> Loading version history…</div>
      ) : loadErr ? (
        <div className="cfg-banner err">{IC.warn}<span>{loadErr}</span><span className="bx" onClick={loadVersions}>{IC.refresh}</span></div>
      ) : versions.length === 0 ? (
        <div className="cfg-empty">No archived configs yet. Click “Back up now” to pull the running-config over SSH.</div>
      ) : (
        <div>
          <div className="sec-title">Version history — select two to diff</div>
          {versions.map((v, idx) => (
            <div key={v.id} className={`ver-row ${idx === 0 ? "current" : ""}`}>
              <div className={`ver-cb ${sel.includes(v.id) ? "on" : ""}`} onClick={() => toggleSel(v.id)}>{sel.includes(v.id) && IC.check}</div>
              <div className="ver-meta" onClick={() => openView(v)} style={{ cursor: "pointer" }}>
                <div className="ver-when">
                  {tsAgo(v.ts)}
                  {idx === 0 && <span className="trigger-tag manual" style={{ background: "#1a3e2a", color: "#3fb950" }}>current</span>}
                  <span className={`trigger-tag ${v.trigger}`}>{v.trigger}</span>
                </div>
                <div className="ver-sub">{tsFull(v.ts)} · {v.lines} lines · #{v.hash}{v.user ? ` · ${v.user}` : ""}</div>
              </div>
              <div className="ver-acts">
                <div className="va" title="View" onClick={() => openView(v)}>{IC.info}</div>
                <div className="va restore-a" title="Restore" onClick={() => setConfirmRestore(v)}>{IC.restore}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
      {confirmRestore && <RestoreConfirm device={device} version={confirmRestore} busy={restoring}
        onCancel={() => setConfirmRestore(null)} onConfirm={() => doRestore(confirmRestore)} />}
    </div>
  );
}

function RestoreConfirm({device, version, onCancel, onConfirm, busy=false}) {
  return (
    <div className="overlay">
      <div className="modal" style={{width:420}}>
        <div className="modal-hdr"><div><div className="modal-title" style={{color:"#e3b341",display:"flex",alignItems:"center",gap:7}}>{IC.warn} Restore configuration</div><div className="modal-sub">This pushes an archived config to a live device.</div></div></div>
        <div className="modal-body">
          <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:7,padding:"11px 13px",fontSize:12,lineHeight:1.7}}>
            <div style={{color:"#8b949e"}}>Target device</div>
            <div style={{fontFamily:"IBM Plex Mono,monospace",color:"#e6edf3",marginBottom:8}}>{device.hostname} ({device.ip})</div>
            <div style={{color:"#8b949e"}}>Restoring snapshot from</div>
            <div style={{fontFamily:"IBM Plex Mono,monospace",color:"#e6edf3"}}>{tsFull(version.ts)} · #{version.hash}</div>
          </div>
          <div style={{fontSize:12,color:"#e3b341",marginTop:12,lineHeight:1.5}}>
            The current running-config will be backed up first, then this version is pushed via {device.protocol==="SNMP"?"SSH":device.protocol} and saved to startup-config.
          </div>
        </div>
        <div className="modal-footer">
          <button className="mbtn cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="mbtn" style={{background:"#bc8cff22",border:"1px solid #bc8cff",color:"#bc8cff",opacity:busy?0.6:1,cursor:busy?"not-allowed":"pointer"}} onClick={busy?undefined:onConfirm} disabled={busy}>{busy?"Restoring…":"Restore & save"}</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Fleet config-mgmt view ──────────────────── */
function FleetConfigView({devices, archive, onBackupAll, onOpenDevice}) {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(!MOCK_MODE);
  const [data, setData] = useState({});   // device id -> { versions:[ms-ts...], failed:bool }
  const [tick, setTick] = useState(0);

  // Controller-managed devices are read-only; their configs aren't archived here.
  const managed = devices.filter(d => d.capability !== "readonly");

  // Real mode: pull each managed device's version list. Mock mode: read the prop.
  useEffect(() => {
    if (MOCK_MODE) {
      const m = {};
      managed.forEach(d => { const e = archive[d.id] || {versions:[]}; m[d.id] = { versions: e.versions.map(v=>v.ts).sort((a,b)=>b-a), last: [...e.versions].sort((a,b)=>b.ts-a.ts)[0], failed: e.lastStatus==="failed" }; });
      setData(m); setLoading(false); return;
    }
    let alive = true; setLoading(true);
    Promise.all(managed.map(d =>
      api.listConfigs(d.id)
        .then(rows => [d.id, (rows||[]).map(v=>({...v, ts:Date.parse(v.ts)})).sort((a,b)=>b.ts-a.ts), false])
        .catch(() => [d.id, [], true])
    )).then(triples => {
      if (!alive) return;
      const m = {};
      triples.forEach(([id, vs, failed]) => { m[id] = { versions: vs, last: vs[0] || null, failed }; });
      setData(m); setLoading(false);
    });
    return () => { alive = false; };
  }, [tick, devices.length]);

  const rows = managed.map(d => {
    const e = data[d.id] || { versions: [], last: null, failed: false };
    const last = e.last;
    const changed = last?.trigger === "change-detected";
    return { d, last, count: e.versions.length, status: e.failed ? "failed" : changed ? "changed" : "ok" };
  });
  const total = rows.length;
  const okCount = rows.filter(r=>r.status==="ok").length;
  const changedCount = rows.filter(r=>r.status==="changed").length;
  const failedCount = rows.filter(r=>r.status==="failed").length;
  const totalVersions = rows.reduce((a,r)=>a+r.count,0);

  function backupAll(){
    setRunning(true);
    Promise.resolve(onBackupAll())
      .catch(()=>{})
      .finally(()=>{ setRunning(false); setTick(t=>t+1); });
  }

  return (
    <div className="fleet-wrap">
      <div className="fleet-kpis">
        <div className="fkpi"><div className="fkpi-label">Devices under backup</div><div className="fkpi-val">{total}</div><div className="fkpi-sub" style={{color:"#3fb950"}}>{okCount} up to date</div></div>
        <div className="fkpi"><div className="fkpi-label">Recently changed</div><div className="fkpi-val" style={{color:changedCount?"#e3b341":"#e6edf3"}}>{changedCount}</div><div className="fkpi-sub" style={{color:"#8b949e"}}>last version was a change</div></div>
        <div className="fkpi"><div className="fkpi-label">Backup errors</div><div className="fkpi-val" style={{color:failedCount?"#f85149":"#e6edf3"}}>{failedCount}</div><div className="fkpi-sub" style={{color:"#8b949e"}}>need attention</div></div>
        <div className="fkpi"><div className="fkpi-label">Archived versions</div><div className="fkpi-val">{totalVersions}</div><div className="fkpi-sub" style={{color:"#8b949e"}}>across all hosts</div></div>
      </div>

      <div className="sched-bar">
        <div style={{width:34,height:34,borderRadius:8,background:"#1a2e3e",color:"#58a6ff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{IC.clock}</div>
        <div className="sched-info">
          <div className="sched-title">Scheduled backup — daily</div>
          <div className="sched-sub">SSH pull · running-config hashed for change detection · only changed configs create a new version</div>
        </div>
        <button className="cfg-btn primary" onClick={backupAll} disabled={running}>{running?IC.clock:IC.download} {running?"Backing up fleet…":"Run backup now"}</button>
      </div>

      <div className="fleet-tbl-card">
        <div className="fleet-tbl-hdr"><span className="t">Per-host backup status</span><span style={{fontSize:11,color:"#8b949e"}}>click a device to open its archive</span></div>
        {loading ? (
          <div className="cfg-loading"><span className="cfg-spin"/> Loading fleet backup status…</div>
        ) : rows.length === 0 ? (
          <div className="cfg-empty">No archivable devices. Controller-managed (read-only) devices are excluded.</div>
        ) : rows.map(({d,last,count,status})=>(
          <div key={d.id} className="fleet-row" onClick={()=>onOpenDevice(d.id)}>
            <DevIcon type={d.type} size={16}/>
            <div style={{flex:1,minWidth:0}}>
              <div className="fr-name">{d.hostname}</div>
              <div className="fr-meta">{d.ip} · {d.vendor} · {count} version{count===1?"":"s"}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="fr-meta">{last?`last: ${tsAgo(last.ts)}`:"never"}</div>
              {last && <div className="fr-meta" style={{color:"#484f58"}}>#{last.hash}</div>}
            </div>
            <span className={`bk-status ${status}`}>
              <span style={{width:6,height:6,borderRadius:"50%",background:"currentColor"}}/>
              {status==="ok"?(last?"up to date":"no backups"):status==="changed"?"changed":"error"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ───────────────────────── Main App ────────────────────────────────── */
function AppInner({auth, onLogout}) {
  const [devices, setDevices] = useState(MOCK_MODE ? INIT_DEVICES : []);
  const [loading, setLoading] = useState(!MOCK_MODE);
  const VIEWS = ["inventory","configmgmt","settings","integrations","topology","alerts","compliance","telemetry"];
  // Parse the URL hash into { view, selId }. Forms: #/inventory, #/devices/5
  function parseHash(){
    const h = (window.location.hash || "").replace(/^#\/?/, "");
    const [seg, id, mode] = h.split("/");
    if (seg === "devices") return { view: "inventory", selId: id ? Number(id) : null, full: mode === "full" };
    if (VIEWS.includes(seg)) return { view: seg, selId: null, full: false };
    return { view: "inventory", selId: null, full: false };
  }
  const _init = parseHash();
  const [selId, setSelId] = useState(_init.selId);
  const [fullId, setFullId] = useState(_init.full ? _init.selId : null);
  const [tab, setTab] = useState("detail");
  const [selIface, setSelIface] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [view, setView] = useState(_init.view);
  const [archive, setArchive] = useState(()=>MOCK_MODE ? seedArchive(INIT_DEVICES) : {});

  // URL → state: respond to back/forward and manual hash edits.
  useEffect(() => {
    const onNav = () => { const p = parseHash(); setView(p.view); setSelId(p.selId); setFullId(p.full ? p.selId : null); };
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => { window.removeEventListener("hashchange", onNav); window.removeEventListener("popstate", onNav); };
  }, []);

  // state → URL: keep the address bar in sync (so back/forward + refresh work).
  useEffect(() => {
    let want;
    if (fullId != null) want = `#/devices/${fullId}/full`;
    else if (view === "inventory" && selId != null) want = `#/devices/${selId}`;
    else want = `#/${view}`;
    if (window.location.hash !== want) {
      window.history.pushState(null, "", want);
    }
  }, [view, selId, fullId]);


  // Real mode: load inventory from the backend on mount.
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshStart = useRef(0);
  useEffect(() => {
    if (MOCK_MODE) return;
    let alive = true;
    api.listDevices()
      .then(ds => { if (alive) { setDevices(ds.map(normalizeDevice)); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); })
      .finally(() => {
        // hold the spinner for a visible minimum so a fast fetch still shows it
        const elapsed = Date.now() - refreshStart.current;
        const wait = Math.max(0, 1200 - elapsed);
        setTimeout(() => { if (alive) setRefreshing(false); }, wait);
      });
    return () => { alive = false; };
  }, [refreshTick]);
  function doRefresh() { if (refreshing) return; refreshStart.current = Date.now(); setRefreshing(true); setRefreshTick(t => t + 1); }

  // Fleet-wide latest cpu/mem/uptime, keyed by device id — powers the inventory table.
  const [fleetMetrics, setFleetMetrics] = useState({});
  useEffect(() => {
    if (MOCK_MODE) return;
    let alive = true;
    api.fleetSummary().then(m => { if (alive) setFleetMetrics(m || {}); }).catch(() => {});
    return () => { alive = false; };
  }, [refreshTick]);

  const sel = devices.find(d=>d.id===selId);

  // Live device-level metrics (latest sampled CPU/mem/uptime) for the detail panel.
  const [liveSummary, setLiveSummary] = useState(null);
  useEffect(() => {
    setLiveSummary(null);
    if (MOCK_MODE || !sel) return;
    let alive = true;
    api.metricSummary(sel.id)
      .then(s => { if (alive) setLiveSummary(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [selId, refreshTick]);
  // merged view: prefer freshly-sampled values, fall back to the device row
  const liveCpu = liveSummary && liveSummary.cpu != null ? Math.round(liveSummary.cpu) : (sel?.cpu ?? 0);
  const liveMem = liveSummary && liveSummary.mem != null ? Math.round(liveSummary.mem) : (sel?.mem ?? 0);
  const liveUptime = (liveSummary?.uptime) || ((sel?.uptime && sel.uptime !== "—") ? sel.uptime : "—");

  // Real mode: pull live interfaces from the device when its detail opens.
  useEffect(() => {
    if (MOCK_MODE || !sel) return;
    if (sel.interfaces && Object.keys(sel.interfaces).length) return;  // already have them
    let alive = true;
    api.deviceInterfaces(sel.id)
      .then(ifs => { if (alive && ifs && Object.keys(ifs).length) {
        setDevices(p=>p.map(d=>d.id===sel.id?{...d, interfaces:ifs}:d));
      }})
      .catch(()=>{});
    return () => { alive = false; };
  }, [selId]);
  const filtered = devices.filter(d=>{
    const s=search.toLowerCase();
    return (d.name.toLowerCase().includes(s)||d.ip.includes(s)||d.vendor.toLowerCase().includes(s)||d.model.toLowerCase().includes(s))&&(filterStatus==="all"||d.status===filterStatus);
  });
  const counts={up:devices.filter(d=>d.status==="up").length,warn:devices.filter(d=>d.status==="warn").length,down:devices.filter(d=>d.status==="down").length};

  function updateDevice(u){ setDevices(p=>p.map(d=>d.id===u.id?{...d,...u}:d)); }
  function addDevice(dev){
    if (!MOCK_MODE) {
      // Persist to backend, then adopt the server's canonical record (real id).
      api.addDevice({ name: dev.name, ip: dev.ip, vendor: dev.vendor, model: dev.model,
                      os: dev.os, device_type: dev.type, platform: (dev.platform||"ios"),
                      protocol: dev.protocol, location: dev.location, ssh_port: dev.sshPort||22,
                      snmp_community: dev.snmpCommunity||"" })
        .then(saved => { setDevices(p=>[...p, {...dev, ...saved, type: saved.type}]); setSelId(saved.id); setTab("detail"); })
        .catch(e => alert("Add device failed: " + e.message));
      return;
    }
    setDevices(p=>[...p,dev]); setSelId(dev.id); setTab("detail"); setSelIface(null);
  }
  function applyIface(name,cfg){ setDevices(p=>p.map(d=>d.id===selId?{...d,interfaces:{...d.interfaces,[name]:{...d.interfaces[name],...cfg}}}:d)); }
  function removeDevice(id){
    const d = devices.find(x=>x.id===id);
    if (!window.confirm(`Remove ${d?d.name:"this device"} from inventory? This removes it from SwitchDex; it does not change the device itself.`)) return;
    if (!MOCK_MODE) { api.deleteDevice(id).catch(e=>alert("Delete failed: "+e.message)); }
    setDevices(p=>p.filter(x=>x.id!==id));
    if (selId===id) setSelId(null);
  }
  function pickDevice(id){ setSelId(id); setTab("detail"); setSelIface(null); setView("inventory"); }
  // Quick-view overlay: opening a device from another view (topology, alerts,
  // archival) pops a summary in place rather than yanking you to the inventory.
  const [quickViewId, setQuickViewId] = useState(null);
  function openQuickView(id){ setQuickViewId(id); }
  function quickViewToFull(id){ setQuickViewId(null); pickDevice(id); }
  function quickViewToConfigs(id){ setQuickViewId(null); openDeviceConfigs(id); }

  // Pull running-config, hash it, store a new version only if it changed.
  function backupDevice(devId, trigger="manual") {
    if (!MOCK_MODE) { api.backupDevice(devId).catch(e=>console.error("backup failed", e)); return; }
    const dev = devices.find(d=>d.id===devId); if(!dev) return;
    const text = renderRunningConfig(dev); const hash = hashConfig(text);
    setArchive(prev=>{
      const entry = prev[devId] || {versions:[]};
      const last = [...entry.versions].sort((a,b)=>b.ts-a.ts)[0];
      const now = Date.now();
      if (last && last.hash===hash) {
        // no change — just record that a run happened
        return {...prev, [devId]:{...entry, lastStatus:"ok", lastRun:now}};
      }
      const ver = { id:`${devId}-${now}`, ts:now, hash, bytes:text.length, lines:text.split("\n").length,
        trigger: last ? (trigger==="manual"?"manual":"change-detected") : "manual", user:"netops", text };
      return {...prev, [devId]:{versions:[...entry.versions, ver], lastStatus:"ok", lastRun:now}};
    });
  }
  function backupAll(){
    if (!MOCK_MODE) { return api.backupAll().catch(e=>{ console.error("backup-all failed", e); throw e; }); }
    devices.forEach(d=>backupDevice(d.id,"scheduled"));
    return Promise.resolve();
  }

  function restoreConfig(devId, version) {
    if (!MOCK_MODE) { api.restoreConfig(devId, version.id).catch(e=>alert("Restore failed: "+e.message)); return; }
    // back up current state first, then store the restored version as newest
    backupDevice(devId, "manual");
    setArchive(prev=>{
      const entry = prev[devId] || {versions:[]};
      const now = Date.now();
      const ver = { id:`${devId}-${now}-r`, ts:now, hash:version.hash, bytes:version.bytes, lines:version.lines,
        trigger:"restore", user:"netops", text:version.text };
      return {...prev, [devId]:{...entry, versions:[...entry.versions, ver], lastStatus:"ok", lastRun:now}};
    });
  }
  function openDeviceConfigs(id){ setSelId(id); setView("inventory"); setTab("configs"); setSelIface(null); }

  return (
    <>
      <style>{css}</style>
      <div className="app">
        <div className="sidebar">
          <div className="sb-logo">{IC.layers}</div>
          {[["grid","Dashboard","dashboard"],["devices","Inventory","inventory"],["map","Topology","topology"],["bell","Alerts","alerts",true],["shield","Compliance","compliance"],["archive","Config Mgmt","configmgmt"],["chart","Telemetry","telemetry"],["plug","Integrations","integrations"],["settings","Settings","settings"]].map(([ic,lb,vw,badge])=>(
            <div key={lb} className={`sb-item ${view===vw?"active":""}`} title={lb}
              onClick={()=>{ if(["inventory","configmgmt","settings","integrations","topology","alerts","compliance","telemetry"].includes(vw)){ setView(vw); } }}>
              <SBIcon n={ic}/>{badge&&<span className="sb-badge"/>}
            </div>
          ))}
        </div>

        <div className="main">
          <div className="topbar">
            <span className="topbar-title">{view==="configmgmt" ? <>Config <span>Management</span></> : view==="settings" ? <>Settings <span>&amp; Access</span></> : view==="integrations" ? <>Integrations</> : view==="topology" ? <>Network <span>Topology</span></> : view==="alerts" ? <>Alerts <span>&amp; Notifications</span></> : view==="compliance" ? <>Compliance</> : view==="telemetry" ? <>Telemetry</> : <>Device <span>Inventory</span></>}</span>
            {view==="inventory" && <button className="tb-btn" onClick={()=>setShowAdd(true)}>{IC.plus} Add device</button>}
            <button className="tb-btn" onClick={doRefresh} disabled={refreshing} title="Reload device data and metrics" style={{minWidth:92,justifyContent:"center"}}>
              {refreshing
                ? <span style={{display:"inline-flex",animation:"sdx-spin 0.7s linear infinite"}}>{IC.refresh}</span>
                : <>{IC.refresh} Refresh</>}
            </button>
            <div className="user-chip" onClick={onLogout} title="Click to sign out">
              <div className="user-av">{auth.user.username.slice(0,2).toUpperCase()}</div>
              <div><div className="user-name">{auth.user.username}</div><div className="user-role">{auth.user.role} · sign out</div></div>
            </div>
          </div>

          {view==="settings" ? (
            <SettingsView auth={auth}/>
          ) : view==="telemetry" ? (
            <TelemetryView devices={devices} initialDeviceId={selId}/>
          ) : view==="compliance" ? (
            <ComplianceView auth={auth} devices={devices}/>
          ) : view==="alerts" ? (
            <AlertsView auth={auth} devices={devices} onOpenDevice={openQuickView}/>
          ) : view==="topology" ? (
            <TopologyView devices={devices} onOpenDevice={openQuickView}/>
          ) : view==="integrations" ? (
            <IntegrationsView auth={auth}/>
          ) : view==="configmgmt" ? (
            <FleetConfigView devices={devices} archive={archive} onBackupAll={backupAll} onOpenDevice={openQuickView}/>
          ) : (
          <div className={`content ${fullId!=null?"full":""}`}>
            <div className="left-pane">
              <div className="toolbar">
                <div className="search-wrap">{IC.search}<input className="search-input" placeholder="Search name, IP, vendor, model…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
                {["all","up","warn","down"].map(f=>(<button key={f} className={`fbtn ${filterStatus===f?"on":""}`} onClick={()=>setFilterStatus(f)}>{f==="all"?"All devices":f[0].toUpperCase()+f.slice(1)}</button>))}
                <div className="stat-row">{[["#3fb950",counts.up,"up"],["#e3b341",counts.warn,"warn"],["#f85149",counts.down,"down"]].map(([c,n,l])=>(<div key={l} className="chip"><div className="cdot" style={{background:c}}/>{n} {l}</div>))}</div>
              </div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Device</th><th>IP address</th><th>Vendor / Model</th><th>Protocol</th><th>Status</th><th>CPU</th><th>Uptime</th><th></th></tr></thead>
                  <tbody>
                    {filtered.map(d=>{ const col=devColor(d.type); const fm=fleetMetrics[d.id]||{}; const rowCpu=fm.cpu!=null?Math.round(fm.cpu):(d.cpu||0); const rowUptime=fm.uptime||((d.uptime&&d.uptime!=="—")?d.uptime:"—"); return (
                      <tr key={d.id} className={selId===d.id?"sel":""} onClick={()=>pickDevice(d.id)}>
                        <td><div className="dc"><div className="di" style={{background:col.bg,color:col.color}}>{IC[d.type]||IC.switch}</div><div><div style={{fontWeight:500,color:"#e6edf3"}}>{d.name}</div><div style={{fontSize:11,color:"#8b949e"}}>{d.location}</div></div></div></td>
                        <td><span className="mono">{d.ip}</span></td>
                        <td><div style={{fontWeight:500,fontSize:13,color:"#e6edf3"}}>{d.vendor}</div><div style={{fontSize:11,color:"#8b949e"}}>{d.model}</div></td>
                        <td><span className={`ptag ${d.protocol.toLowerCase().replace(/[^a-z0-9]/g,"")}`}>{d.protocol}</span>{d.capability==="readonly" && <span className="ro-badge" style={{marginLeft:5}} title="Read-only (controller-managed)">{IC.eye} RO</span>}</td>
                        <td><span className={`sbadge ${d.status}`}><span style={{width:6,height:6,borderRadius:"50%",background:"currentColor",display:"inline-block"}}/>{d.status}</span></td>
                        <td>{d.status!=="down"?(<div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:44,height:4,background:"#21262d",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${rowCpu}%`,background:rowCpu>80?"#f85149":rowCpu>60?"#e3b341":"#3fb950",borderRadius:2}}/></div><span className="mono" style={{fontSize:11}}>{rowCpu}%</span></div>):<span className="mono">—</span>}</td>
                        <td><span className="mono" style={{fontSize:11}}>{rowUptime}</span></td>
                        <td><div className="row-acts"><div className="act" title="Open full page" onClick={e=>{e.stopPropagation();setSelId(d.id);setFullId(d.id);setTab("detail");setSelIface(null);}}>{IC.info}</div><div className="act term" title="SSH Terminal" onClick={e=>{e.stopPropagation();setSelId(d.id);setTab("ssh");setSelIface(null);}}>{IC.terminal}</div><div className="act" title="Edit device" onClick={e=>{e.stopPropagation();setEditId(d.id);}}>{IC.edit}</div><div className="act" title="Remove device" onClick={e=>{e.stopPropagation();removeDevice(d.id);}} style={{color:"#f85149"}}>{IC.x}</div></div></td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className={`rpanel ${!sel?"hidden":""}`}>
              {!sel && fullId!=null && (
                <div className="ptabs">
                  <div className="pback" onClick={()=>{setFullId(null);}} style={{cursor:"pointer",fontSize:13,color:"#58a6ff"}}>‹ Back to inventory</div>
                  <div style={{padding:"0 12px",color:"#8b949e",fontSize:13}}>Device not found.</div>
                </div>
              )}
              {sel && <>
                <div className="ptabs">
                  {fullId!=null && <div className="pback" title="Back to inventory" onClick={()=>{setFullId(null);}} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:4,fontSize:13,color:"#58a6ff",marginRight:12}}>‹ Back</div>}
                  <div className={`ptab ${tab==="detail"?"active":""}`} onClick={()=>{setTab("detail");}}>{selIface?"Interface":"Details"}</div>
                  {sel.capability!=="readonly" && <div className={`ptab ${tab==="configs"?"active":""}`} onClick={()=>setTab("configs")}>Configs</div>}
                  {sel.capability!=="readonly" && <div className={`ptab ${tab==="ssh"?"active":""}`} onClick={()=>setTab("ssh")}>Terminal</div>}
                  <div className="pclose" title="Edit device" onClick={()=>setEditId(sel.id)} style={{marginLeft:"auto"}}>{IC.edit}</div>
                  <div className="pclose" title="Remove device" onClick={()=>removeDevice(sel.id)} style={{color:"#f85149"}}>{IC.trash || IC.x}</div>
                  <div className="pclose" title="Close" onClick={()=>{setSelId(null);setSelIface(null);setFullId(null);}}>{IC.x}</div>
                </div>

                {tab==="detail" && !selIface && (() => { const ro = sel.capability==="readonly"; return (
                  <div className="dpane">
                    <div className="dhdr">
                      <DevIcon type={sel.type} size={20}/>
                      <div>
                        <div className="dname">{sel.name}</div>
                        <div className="dsub">{sel.ip} · {sel.vendor} {sel.model}</div>
                        <div style={{marginTop:5,display:"flex",gap:6,alignItems:"center"}}>
                          <span className={`sbadge ${sel.status}`} style={{fontSize:11}}><span style={{width:6,height:6,borderRadius:"50%",background:"currentColor",display:"inline-block"}}/>{sel.status}</span>
                          {ro && <span className="ro-badge">{IC.eye} Read-only</span>}
                        </div>
                      </div>
                    </div>

                    {ro && (
                      <div className="ro-banner">{IC.eye}<div>Managed by {sel.vendor==="Ubiquiti"?"UniFi":"Omada"} controller — metrics are read-only. Configuration and SSH are handled in the {sel.vendor==="Ubiquiti"?"UniFi":"Omada"} controller.</div></div>
                    )}

                    <div>
                      <div className="sec-title">Front panel{ro?" — read-only view":" — click a port to configure"}</div>
                      <SwitchFaceplate device={sel} selIface={selIface} onSelect={ro?(()=>{}):((n)=>setSelIface(n))}/>
                    </div>

                    {ro && (
                      <div><div className="sec-title">Live metrics</div>
                        <div className="metric-grid">
                          {[["CPU",liveCpu+"%"],["Memory",liveMem+"%"],["Uptime",liveUptime],["Clients",(sel.interfaces?Object.values(sel.interfaces).filter(i=>i.status==="up").length*4:0)+""]].map(([k,v])=>(
                            <div className="metric-card" key={k}><div className="metric-label">{k}</div><div className="metric-val">{v}</div></div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div><div className="sec-title">System</div>
                      <div className="dgrid">{[["OS",sel.os],["Protocol",sel.protocol],["Location",sel.location],["Uptime",liveUptime],["CPU",sel.status!=="down"?liveCpu+"%":"—"],["Memory",sel.status!=="down"?liveMem+"%":"—"]].map(([k,v])=>(<div className="dkv" key={k}><div className="dkv-k">{k}</div><div className="dkv-v">{String(v)}</div></div>))}</div>
                    </div>

                    <DetailSparklines device={sel} onExpand={()=>setView("telemetry")}/>

                    {(() => {
                      const all = Object.entries(sel.interfaces || {});
                      const phys = all.filter(([,i]) => i.kind !== "logical");
                      const logical = all.filter(([,i]) => i.kind === "logical");
                      const IfRow = ([n,i]) => (
                        <div className="irow" key={n} onClick={ro?undefined:(()=>setSelIface(n))} style={ro?{cursor:"default"}:undefined}>
                          <span className="led" style={{width:6,height:6,borderRadius:"50%",background:i.shutdown?"#f85149":i.status==="up"?"#3fb950":"#484f58",display:"inline-block",flexShrink:0}}/>
                          <div className="iname">{n}</div>
                          {i.desc && <div style={{fontSize:11,color:"#8b949e",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{i.desc}</div>}
                          <div style={{fontSize:11,color:"#8b949e"}}>{i.speed}</div>
                          {i.vlan && <span className="vtag">vl{i.vlan}</span>}
                          {!ro && <span style={{color:"#484f58"}}>›</span>}
                        </div>
                      );
                      return <>
                        <div><div className="sec-title"><span>Physical interfaces ({phys.length})</span></div>
                          {phys.length ? phys.map(IfRow) : <div style={{fontSize:12,color:"#6e7681",padding:"4px 0"}}>No physical interfaces.</div>}
                        </div>
                        {logical.length > 0 && (
                          <div><div className="sec-title"><span>Logical interfaces ({logical.length})</span></div>
                            {logical.map(IfRow)}
                          </div>
                        )}
                      </>;
                    })()}

                    {Object.keys(sel.vlans||{}).length>0 && (
                      <div><div className="sec-title">VLANs</div><div style={{display:"flex",flexWrap:"wrap",gap:5}}>{Object.entries(sel.vlans||{}).map(([id,v])=>(<span key={id} className="vtag">{id} {v.name}</span>))}</div></div>
                    )}

                    {ro ? (
                      sel.controllerUrl ? (
                        <a className="ro-banner" href={sel.controllerUrl} target="_blank" rel="noopener noreferrer"
                           style={{justifyContent:"center",textDecoration:"none",cursor:"pointer",color:"inherit"}}
                           title={sel.controllerUrl}>
                          {IC.link}<div>Open in the {sel.vendor==="Ubiquiti"?"UniFi":"Omada"} controller to make changes</div>
                        </a>
                      ) : (
                        <div className="ro-banner" style={{justifyContent:"center"}}>{IC.link}<div>Open in the {sel.vendor==="Ubiquiti"?"UniFi":"Omada"} controller to make changes</div></div>
                      )
                    ) : (
                      <div style={{display:"flex",gap:8}}>
                        <button className="dbtn" style={{background:"#1f6feb",borderColor:"#388bfd"}} onClick={()=>setTab("configs")}>{IC.archive} Config archive</button>
                        <button className="dbtn" onClick={()=>setTab("ssh")}>{IC.terminal} SSH terminal</button>
                      </div>
                    )}
                  </div>
                ); })()}

                {tab==="detail" && selIface && (
                  <InterfaceEditor key={selIface} device={sel} ifaceName={selIface}
                    onBack={()=>setSelIface(null)} onApply={applyIface} onSSH={()=>setTab("ssh")}/>
                )}

                {tab==="configs" && (
                  <ConfigArchive key={sel.id} device={sel} archive={archive}
                    onBackup={(id)=>backupDevice(id,"manual")} onRestore={restoreConfig}/>
                )}

                {tab==="ssh" && <SSHPane key={sel.id} device={sel} onUpdate={updateDevice}/>}
              </>}
            </div>
          </div>
          )}
        </div>

        {showAdd && <AddDeviceModal onClose={()=>setShowAdd(false)} onAdd={addDevice}/>}
        {quickViewId != null && (() => { const qd = devices.find(d=>d.id===quickViewId); return qd ? (
          <QuickView device={qd} metrics={fleetMetrics[qd.id]} onClose={()=>setQuickViewId(null)}
            onOpenFull={()=>quickViewToFull(qd.id)} onOpenConfigs={()=>quickViewToConfigs(qd.id)}/>
        ) : null; })()}
        {editId != null && (() => { const ed = devices.find(d=>d.id===editId); return ed ? (
          <EditDeviceModal device={ed} onClose={()=>setEditId(null)}
            onSaved={(updated)=>{ setDevices(p=>p.map(d=>d.id===updated.id?{...d,...updated}:d)); setEditId(null); }}/>
        ) : null; })()}
      </div>
    </>
  );
}

/* ───────────────────────── Telemetry ───────────────────────────────── */
// Mock series generator: smooth, believable history for the demo.
function mockSeries(seed, points, base, amp, period, floor=0, ceil=100) {
  const now = Date.now(); const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const t = now - i * (period / points);
    const x = (t / 600000) + seed;
    const v = Math.max(floor, Math.min(ceil, base + amp * Math.sin(x) + (Math.random() * amp * 0.3 - amp * 0.15)));
    out.push({ t: new Date(t).toISOString(), v: Math.round(v * 10) / 10 });
  }
  return out;
}
const RANGE_MS = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3, "7d": 7 * 24 * 3600e3, "30d": 30 * 24 * 3600e3 };

// Pure-SVG line chart (no dependency). points: [{t, v}], scales to width/height.
function fmtTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function LineChart({ series, height = 130, color = "#58a6ff", fill = true, unit = "%", max = null, showAxis = true }) {
  const W = 100, H = 100; // viewBox units; svg scales via width/height
  const all = series.flatMap(s => s.points.map(p => p.v));
  const ymax = max != null ? max : Math.max(1, ...all) * 1.15;
  const n = Math.max(...series.map(s => s.points.length), 1);
  const xOf = (i, len) => (len <= 1 ? 0 : (i / (len - 1)) * W);
  const yOf = (v) => H - (v / ymax) * H;

  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null); // { frac, idx, pxX }

  // longest series drives the x-axis / hit-testing
  const primary = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0] || { points: [] });

  function onMove(e) {
    const el = wrapRef.current; if (!el || !primary.points.length) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(frac * (primary.points.length - 1));
    setHover({ idx, pxX: (idx / Math.max(1, primary.points.length - 1)) * rect.width, w: rect.width });
  }
  function onLeave() { setHover(null); }

  const hp = hover && primary.points[hover.idx];

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height }}
         onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
        {showAxis && [0.25, 0.5, 0.75].map(g => (
          <line key={g} x1="0" y1={H * g} x2={W} y2={H * g} stroke="#21262d" strokeWidth="0.4" />
        ))}
        {series.map((s, si) => {
          if (!s.points.length) return null;
          const col = s.color || color;
          const pts = s.points.map((p, i) => `${xOf(i, s.points.length)},${yOf(p.v)}`).join(" ");
          const area = `0,${H} ` + pts + ` ${xOf(s.points.length - 1, s.points.length)},${H}`;
          return (
            <g key={si}>
              {fill && series.length === 1 && <polygon points={area} fill={col} opacity="0.12" />}
              <polyline points={pts} fill="none" stroke={col} strokeWidth="1.2" vectorEffect="non-scaling-stroke"
                strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {/* hover guide line + dots, in viewBox units */}
        {hover && hp && (
          <g>
            <line x1={xOf(hover.idx, primary.points.length)} y1="0"
                  x2={xOf(hover.idx, primary.points.length)} y2={H}
                  stroke="#8b949e" strokeWidth="0.5" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            {series.map((s, si) => {
              const p = s.points[hover.idx]; if (!p) return null;
              return <circle key={si} cx={xOf(hover.idx, primary.points.length)} cy={yOf(p.v)}
                             r="1.6" fill={s.color || color} stroke="#0d1117" strokeWidth="0.6"
                             vectorEffect="non-scaling-stroke" />;
            })}
          </g>
        )}
      </svg>
      {/* tooltip */}
      {hover && hp && (
        <div style={{
          position: "absolute", top: 4,
          left: Math.min(Math.max(hover.pxX + 8, 4), (hover.w || 0) - 150),
          background: "#161b22", border: "1px solid #30363d", borderRadius: 6,
          padding: "5px 8px", fontSize: 11, color: "#e6edf3", pointerEvents: "none",
          fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap", zIndex: 5,
          boxShadow: "0 2px 8px rgba(0,0,0,.4)"
        }}>
          <div style={{ color: "#8b949e", marginBottom: 2 }}>{fmtTs(hp.t)}</div>
          {series.map((s, si) => {
            const p = s.points[hover.idx]; if (!p) return null;
            return <div key={si} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color || color, display: "inline-block" }} />
              {s.name ? s.name + ": " : ""}{p.v}{unit}
            </div>;
          })}
        </div>
      )}
    </div>
  );
}

function Sparkline({ points, color = "#3fb950", height = 26 }) {
  if (!points || !points.length) return <div style={{ flex: 1, height, background: "#0d1117", borderRadius: 4 }} />;
  const W = 100, H = 100;
  const vals = points.map(p => p.v); const ymax = Math.max(1, ...vals) * 1.15;
  const pts = points.map((p, i) => `${(i / (points.length - 1)) * W},${H - (p.v / ymax) * H}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ flex: 1, height, display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function fmtRate(v){ return v >= 1000 ? (v/1000).toFixed(1)+" Gbps" : Math.round(v)+" Mbps"; }

function TelemetryView({ devices, initialDeviceId }) {
  const manage = devices;
  const [devId, setDevId] = useState(initialDeviceId || (manage[0] && manage[0].id) || null);
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const dev = devices.find(d => d.id === devId);

  useEffect(() => {
    if (!devId) return;
    if (!MOCK_MODE) {
      Promise.all([api.metric(devId, "cpu", range), api.metric(devId, "mem", range)])
        .then(([cpu, mem]) => setData({ cpu: cpu.points, mem: mem.points, ifs: {} }))
        .catch(() => setData(null));
      return;
    }
    // mock
    const pts = range === "1h" ? 60 : range === "6h" ? 72 : range === "24h" ? 96 : range === "7d" ? 168 : 180;
    const ms = RANGE_MS[range];
    const cpu = mockSeries(devId, pts, 30 + devId * 4, 20, ms / 600000, 2, 98);
    const mem = mockSeries(devId + 50, pts, 45 + devId * 3, 12, ms / 600000, 8, 95);
    const ifnames = dev ? Object.keys(dev.interfaces || {}).slice(0, 4) : [];
    const ifs = {};
    (ifnames.length ? ifnames : ["Ethernet1", "Ethernet2"]).forEach((nm, i) => {
      ifs[nm] = { rx: mockSeries(devId + i + 10, pts, 250, 180, ms / 600000, 0, 1000),
                  tx: mockSeries(devId + i + 20, pts, 150, 110, ms / 600000, 0, 800) };
    });
    setData({ cpu, mem, ifs });
  }, [devId, range, dev]);

  const cur = (arr) => (arr && arr.length ? arr[arr.length - 1].v : 0);

  return (
    <div className="tel-wrap">
      <div className="tel-toolbar">
        <select className="set-select" style={{ width: 220 }} value={devId || ""} onChange={e => setDevId(Number(e.target.value))}>
          {manage.map(d => <option key={d.id} value={d.id}>{d.name} — {d.ip}</option>)}
        </select>
        <div className="tel-range">
          {["1h", "6h", "24h", "7d", "30d"].map(r => (
            <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
        {dev && dev.capability === "readonly" && <span className="ro-badge">{IC.eye} read-only source</span>}
      </div>

      {!data ? <div className="tel-empty">No telemetry yet — samples accumulate as the collector runs.</div> : (
        <div className="tel-grid">
          <div className="tel-card">
            <div className="tel-card-hdr"><span className="tel-card-title">CPU</span><span className="tel-card-cur" style={{ color: cur(data.cpu) > 80 ? "#f85149" : cur(data.cpu) > 60 ? "#e3b341" : "#3fb950" }}>{cur(data.cpu)}%</span></div>
            <LineChart series={[{ points: data.cpu }]} color="#58a6ff" max={100} />
          </div>
          <div className="tel-card">
            <div className="tel-card-hdr"><span className="tel-card-title">Memory</span><span className="tel-card-cur" style={{ color: cur(data.mem) > 85 ? "#f85149" : "#3fb950" }}>{cur(data.mem)}%</span></div>
            <LineChart series={[{ points: data.mem }]} color="#bc8cff" max={100} />
          </div>
        </div>
      )}
    </div>
  );
}

// Compact CPU/memory trend strip for the device detail panel.
function DetailSparklines({ device, onExpand }) {
  const [series, setSeries] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!MOCK_MODE) {
      Promise.all([api.metric(device.id, "cpu", "6h"), api.metric(device.id, "mem", "6h")])
        .then(([c, m]) => alive && setSeries({ cpu: c.points, mem: m.points }))
        .catch(() => alive && setSeries({ cpu: [], mem: [] }));
    } else {
      const pts = 48, ms = 6 * 3600e3;
      setSeries({
        cpu: mockSeries(device.id, pts, 30 + device.id * 4, 20, ms / 600000, 2, 98),
        mem: mockSeries(device.id + 50, pts, 45 + device.id * 3, 12, ms / 600000, 8, 95),
      });
    }
    return () => { alive = false; };
  }, [device.id]);
  if (device.status === "down") return null;
  const cur = (a) => (a && a.length ? a[a.length - 1].v : 0);
  return (
    <div>
      <div className="sec-title" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Trends (6h)</span>
        <span style={{ color: "#58a6ff", cursor: "pointer", textTransform: "none", letterSpacing: 0 }} onClick={onExpand}>Full telemetry ›</span>
      </div>
      <div className="spark-wrap" style={{ marginBottom: 6 }}>
        <span className="spark-label">CPU</span>
        <Sparkline points={series && series.cpu} color="#58a6ff" />
        <span className="spark-cur">{series ? cur(series.cpu) : "—"}%</span>
      </div>
      <div className="spark-wrap">
        <span className="spark-label">Mem</span>
        <Sparkline points={series && series.mem} color="#bc8cff" />
        <span className="spark-cur">{series ? cur(series.mem) : "—"}%</span>
      </div>
    </div>
  );
}

/* ───────────────────────── Compliance ──────────────────────────────── */
// Mock evaluation: applies policies to each device's rendered config.
function mockEvaluate(devices, policies) {
  const manage = devices.filter(d => (d.capability||"manage")==="manage");
  const results = manage.map(d => {
    const cfg = (typeof renderRunningConfig==="function") ? renderRunningConfig(d) : "";
    const checks = policies.filter(p=>p.enabled).map(p=>{
      const present = p.match==="regex" ? (()=>{try{return new RegExp(p.pattern,"m").test(cfg);}catch{return false;}})() : cfg.includes(p.pattern);
      const ok = p.kind==="require" ? present : !present;
      return { id:p.id, name:p.name, kind:p.kind, severity:p.severity, pass:ok };
    });
    const failed = checks.filter(c=>!c.pass);
    const status = failed.length ? "fail" : "pass";
    return { deviceId:d.id, device:d.name, ip:d.ip, vendor:d.vendor, status, checks,
             passed:checks.filter(c=>c.pass).length, total:checks.length, drift:false, hasBaseline:false };
  });
  const total=results.length, passing=results.filter(r=>r.status==="pass").length;
  return { score: total?Math.round(100*passing/total):100, total, passing,
           failing:results.filter(r=>r.status==="fail").length,
           drift:results.filter(r=>r.status==="drift").length, policyCount:policies.length, results };
}

const SEED_POLICIES = [];   // empty by default — admin writes all rules

function ComplianceView({auth, devices}) {
  const [tab, setTab] = useState("dashboard");   // dashboard | policies
  const [policies, setPolicies] = useState(SEED_POLICIES);
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name:"", description:"", kind:"require", pattern:"", match:"substring", severity:"warning" });
  const isAdmin = auth.user.role === "admin";

  useEffect(()=>{
    if (MOCK_MODE) { setData(mockEvaluate(devices, policies)); return; }
    api.compliance().then(setData).catch(()=>{});
    api.listPolicies().then(setPolicies).catch(()=>{});
  }, [policies.length]);

  function addPolicy() {
    if (!form.name || !form.pattern) return;
    const p = { id:Date.now(), enabled:true, scope:"", ...form };
    if (!MOCK_MODE) { api.createPolicy(p).then(()=>api.listPolicies().then(setPolicies)); }
    else { setPolicies(ps=>[...ps,p]); }
    setAdding(false); setForm({ name:"", description:"", kind:"require", pattern:"", match:"substring", severity:"warning" });
  }
  function delPolicy(id) {
    if (!MOCK_MODE) { api.deletePolicy(id).then(()=>api.listPolicies().then(setPolicies)); }
    else { setPolicies(ps=>ps.filter(p=>p.id!==id)); }
  }

  const d = data || { score:100, total:0, passing:0, failing:0, drift:0, results:[] };
  const scoreColor = d.score>=90?"#3fb950":d.score>=70?"#e3b341":"#f85149";
  const circ = 2*Math.PI*38;

  return (
    <div className="cmp-wrap">
      <div className="cmp-tabs">
        <button className={`fbtn ${tab==="dashboard"?"on":""}`} onClick={()=>setTab("dashboard")}>Dashboard</button>
        <button className={`fbtn ${tab==="policies"?"on":""}`} onClick={()=>setTab("policies")}>Policies ({policies.length})</button>
      </div>

      {tab==="dashboard" && <>
        <div className="cmp-score">
          <div className="cmp-gauge">
            <svg width="88" height="88" viewBox="0 0 88 88">
              <circle cx="44" cy="44" r="38" fill="none" stroke="#21262d" strokeWidth="8"/>
              <circle cx="44" cy="44" r="38" fill="none" stroke={scoreColor} strokeWidth="8" strokeLinecap="round"
                strokeDasharray={circ} strokeDashoffset={circ*(1-d.score/100)} transform="rotate(-90 44 44)"/>
            </svg>
            <div className="cmp-gauge-val"><div className="cmp-gauge-num" style={{color:scoreColor}}>{d.score}%</div><div className="cmp-gauge-lbl">compliant</div></div>
          </div>
          <div className="cmp-score-meta">
            <div className="cmp-score-title">Fleet compliance</div>
            <div className="cmp-score-sub">{d.policyCount===0 ? "No policies defined yet — add policies to start checking." : `${d.total} devices evaluated against ${d.policyCount} ${d.policyCount===1?"policy":"policies"}.`}</div>
            <div className="cmp-pills">
              <div className="cmp-pill"><span className="cmp-stat pass"/><b style={{color:"#3fb950"}}>{d.passing}</b> passing</div>
              <div className="cmp-pill"><span className="cmp-stat fail"/><b style={{color:"#f85149"}}>{d.failing}</b> failing</div>
              <div className="cmp-pill"><span className="cmp-stat drift"/><b style={{color:"#e3b341"}}>{d.drift}</b> drift</div>
            </div>
          </div>
        </div>

        {d.policyCount===0 ? (
          <div className="cmp-card"><div className="cmp-empty">Compliance checks your device configs against policies you define —<br/>e.g. require <code style={{color:"#58a6ff"}}>transport input ssh</code>, forbid <code style={{color:"#58a6ff"}}>snmp-server community public</code>.<br/><br/>{isAdmin ? <button className="al-btn" onClick={()=>setTab("policies")}>{IC.plus} Define your first policy</button> : "Ask an admin to define policies."}</div></div>
        ) : (
          <div className="cmp-card">
            {d.results.map(r=>(
              <div key={r.deviceId}>
                <div className="cmp-row" style={{cursor:"pointer"}} onClick={()=>setExpanded(expanded===r.deviceId?null:r.deviceId)}>
                  <span className={`cmp-stat ${r.status}`}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="cmp-name">{r.device}</div>
                    <div className="cmp-sub">{r.ip} · {r.vendor}{r.hasBaseline?" · baseline pinned":""}</div>
                  </div>
                  <div className="cmp-progress"><div className="cmp-progress-fill" style={{width:`${r.total?100*r.passed/r.total:100}%`,background:r.status==="pass"?"#3fb950":r.status==="drift"?"#e3b341":"#f85149"}}/></div>
                  <span className="cmp-sub" style={{width:46,textAlign:"right"}}>{r.passed}/{r.total}</span>
                  <span className={`cmp-badge ${r.status}`}>{r.status}</span>
                </div>
                {expanded===r.deviceId && (
                  <div style={{padding:"4px 15px 12px 35px",background:"#080b0f"}}>
                    {r.checks.length===0 ? <div className="cmp-sub">No policies in scope.</div> : r.checks.map(c=>(
                      <div className="cmp-check" key={c.id}>
                        <span className={`cmp-check-icon ${c.pass?"pass":"fail"}`}>{c.pass?IC.check:IC.x}</span>
                        <span style={{flex:1,color:c.pass?"#8b949e":"#e6edf3"}}>{c.name}</span>
                        <span className="cmp-sub">{c.kind}</span>
                        {!c.pass && <span className={`cmp-badge ${c.severity==="critical"?"fail":"drift"}`}>{c.severity}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </>}

      {tab==="policies" && (
        <div className="cmp-card">
          <div className="cmp-row" style={{background:"#010409"}}>
            <div style={{flex:1,fontSize:11,fontWeight:600,color:"#8b949e",textTransform:"uppercase",letterSpacing:".06em"}}>Policy</div>
            {isAdmin && !adding && <button className="al-btn" onClick={()=>setAdding(true)}>{IC.plus} Add policy</button>}
          </div>
          {adding && isAdmin && (
            <div style={{padding:"14px 15px",borderBottom:"1px solid #161b22",background:"#080b0f"}}>
              <div className="set-row2" style={{marginBottom:10}}>
                <div><label className="set-label">Name</label><input className="set-input" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. SSH transport only"/></div>
                <div><label className="set-label">Severity</label><select className="set-select" value={form.severity} onChange={e=>setForm(f=>({...f,severity:e.target.value}))}><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select></div>
              </div>
              <div className="set-row2" style={{marginBottom:10}}>
                <div><label className="set-label">Rule type</label><select className="set-select" value={form.kind} onChange={e=>setForm(f=>({...f,kind:e.target.value}))}><option value="require">Require (must contain)</option><option value="forbid">Forbid (must not contain)</option></select></div>
                <div><label className="set-label">Match</label><select className="set-select" value={form.match} onChange={e=>setForm(f=>({...f,match:e.target.value}))}><option value="substring">Substring</option><option value="regex">Regex</option></select></div>
              </div>
              <div className="set-field"><label className="set-label">Config pattern</label><input className="set-input" value={form.pattern} onChange={e=>setForm(f=>({...f,pattern:e.target.value}))} placeholder={form.kind==="require"?"transport input ssh":"snmp-server community public"}/></div>
              <div style={{display:"flex",gap:8,marginTop:6}}>
                <button className="al-btn" onClick={()=>setAdding(false)}>Cancel</button>
                <button className="al-btn resolve" onClick={addPolicy}>Save policy</button>
              </div>
            </div>
          )}
          {policies.length===0 && !adding && <div className="cmp-empty">No policies defined. {isAdmin?"Add one to start checking configs.":"Ask an admin to define policies."}</div>}
          {policies.map(p=>(
            <div className="cmp-row" key={p.id}>
              <span className={`cmp-badge ${p.kind==="require"?"pass":"fail"}`} style={{background:p.kind==="require"?"#1a3e2a":"#3d1a1a",color:p.kind==="require"?"#3fb950":"#f85149"}}>{p.kind}</span>
              <div style={{flex:1,minWidth:0}}>
                <div className="cmp-name">{p.name}</div>
                <div className="cmp-sub">{p.match}: <span style={{color:"#58a6ff"}}>{p.pattern}</span></div>
              </div>
              <span className={`cmp-badge ${p.severity==="critical"?"fail":"drift"}`}>{p.severity}</span>
              {isAdmin && <div className="va" title="Delete" onClick={()=>delPolicy(p.id)} style={{cursor:"pointer"}}>{IC.x}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Alerts ──────────────────────────────────── */
const NOW = Date.now();
const SEED_ALERTS = [
  { id:1, severity:"critical", title:"Device unreachable: edge-rtr-02", detail:"edge-rtr-02 (10.0.2.1) is unreachable — 3 consecutive poll failures", state:"open", device:"edge-rtr-02", openedAt:new Date(NOW-8*60000).toISOString() },
  { id:2, severity:"warning", title:"High CPU: dist-sw-04", detail:"CPU 71% exceeds 85% threshold sustained 5m", state:"open", device:"dist-sw-04", openedAt:new Date(NOW-23*60000).toISOString() },
  { id:3, severity:"info", title:"Config changed: core-rtr-01", detail:"Running-config changed (a1b2c3d4) — 142 lines, trigger scheduled", state:"acknowledged", device:"core-rtr-01", openedAt:new Date(NOW-70*60000).toISOString(), ackBy:"admin" },
  { id:4, severity:"warning", title:"High memory: access-sw-11", detail:"Memory 79% exceeds 75% threshold", state:"resolved", device:"access-sw-11", openedAt:new Date(NOW-180*60000).toISOString(), resolvedBy:"auto" },
];
const SEED_RULES = [
  { id:1, name:"Device unreachable", preset:"device_down", severity:"critical", duration:120, threshold:0, enabled:true, auto_resolve:true },
  { id:2, name:"High CPU", preset:"cpu_high", severity:"warning", duration:300, threshold:85, enabled:true, auto_resolve:true },
  { id:3, name:"High memory", preset:"mem_high", severity:"warning", duration:300, threshold:85, enabled:true, auto_resolve:true },
  { id:4, name:"Config changed", preset:"config_changed", severity:"info", duration:0, threshold:0, enabled:true, auto_resolve:false },
];
const SEED_CHANNELS = [
  { id:1, name:"NetOps email", kind:"email", enabled:true, min_severity:"warning", config:{to:"netops@example.com"} },
  { id:2, name:"Slack #alerts", kind:"webhook", enabled:true, min_severity:"warning", config:{url:"https://hooks.slack.com/…"} },
];

function alertAgo(iso){ const s=(Date.now()-new Date(iso).getTime())/1000; if(s<60)return"just now"; if(s<3600)return`${(s/60)|0}m ago`; if(s<86400)return`${(s/3600)|0}h ago`; return`${(s/86400)|0}d ago`; }

/* Rule editor modal — create/edit an alert rule. */
function RuleEditor({rule, devices, onSave, onClose}) {
  const [r, setR] = useState({...rule});
  const set = (k,v)=>setR(p=>({...p,[k]:v}));
  const isPreset = r.preset && r.preset!=="custom";
  const PRESETS = [["custom","Custom (metric/threshold)"],["device_down","Device down"],["cpu_high","CPU high"],["mem_high","Memory high"]];
  return (
    <div className="overlay" onMouseDown={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal" style={{width:440}}>
        <div className="modal-hdr"><div className="modal-title">{r.id?"Edit rule":"New alert rule"}</div></div>
        <div className="modal-body">
          <label className="flabel">Rule name</label>
          <input className="finput" value={r.name||""} onChange={e=>set("name",e.target.value)} placeholder="e.g. Core switch CPU"/>
          <label className="flabel">Type</label>
          <select className="finput" value={r.preset||"custom"} onChange={e=>set("preset",e.target.value)}>
            {PRESETS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
          </select>
          {r.preset==="custom" ? <>
            <div className="frow">
              <div><label className="flabel">Metric</label>
                <select className="finput" value={r.metric||"cpu"} onChange={e=>set("metric",e.target.value)}>
                  <option value="cpu">CPU %</option><option value="mem">Memory %</option>
                </select></div>
              <div><label className="flabel">Operator</label>
                <select className="finput" value={r.operator||">"} onChange={e=>set("operator",e.target.value)}>
                  {[">","<",">=","<=","==","!="].map(o=><option key={o} value={o}>{o}</option>)}
                </select></div>
            </div>
            <label className="flabel">Threshold</label>
            <input className="finput" type="number" value={r.threshold??85} onChange={e=>set("threshold",e.target.value)}/>
          </> : (r.preset==="cpu_high"||r.preset==="mem_high") && <>
            <label className="flabel">Threshold %</label>
            <input className="finput" type="number" value={r.threshold??85} onChange={e=>set("threshold",e.target.value)}/>
          </>}
          <div className="frow">
            <div><label className="flabel">Severity</label>
              <select className="finput" value={r.severity||"warning"} onChange={e=>set("severity",e.target.value)}>
                <option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option>
              </select></div>
            <div><label className="flabel">Hold for (sec)</label>
              <input className="finput" type="number" value={r.duration||0} onChange={e=>set("duration",e.target.value)} title="Condition must hold this long before firing"/></div>
          </div>
          <label className="flabel">Scope (devices)</label>
          <select className="finput" value={r.scope||""} onChange={e=>set("scope",e.target.value)}>
            <option value="">All devices</option>
            {devices.map(d=><option key={d.id} value={String(d.id)}>{d.name} ({d.ip})</option>)}
          </select>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#e6edf3",marginTop:4,cursor:"pointer"}}>
            <input type="checkbox" checked={r.auto_resolve!==false} onChange={e=>set("auto_resolve",e.target.checked)}/>
            Auto-resolve when condition clears
          </label>
        </div>
        <div className="modal-footer">
          <button className="mbtn cancel" onClick={onClose}>Cancel</button>
          <button className="mbtn add" onClick={()=>onSave(r)} disabled={!r.name}>Save rule</button>
        </div>
      </div>
    </div>
  );
}

/* Channel editor modal — configure a notification destination. */
function ChannelEditor({chan, onSave, onClose}) {
  const [c, setC] = useState({...chan, config:{...(chan.config||{})}});
  const set = (k,v)=>setC(p=>({...p,[k]:v}));
  const setCfg = (k,v)=>setC(p=>({...p,config:{...p.config,[k]:v}}));
  const [testMsg, setTestMsg] = useState(null);
  const KINDS = [["webhook","Webhook"],["email","Email (SMTP)"],["syslog","Syslog"],["discord","Discord"]];

  function test(){
    setTestMsg({t:"...",ok:null});
    api.testChannel({name:c.name||"test",kind:c.kind,enabled:true,config:c.config,min_severity:c.min_severity||"warning"})
      .then(res=>setTestMsg({t:res.ok?"Test sent successfully":(res.error||"Test failed"),ok:res.ok}))
      .catch(e=>setTestMsg({t:e.message||"Test failed",ok:false}));
  }

  return (
    <div className="overlay" onMouseDown={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal" style={{width:460}}>
        <div className="modal-hdr"><div className="modal-title">{c.id?"Edit channel":"New notification channel"}</div></div>
        <div className="modal-body">
          <label className="flabel">Channel name</label>
          <input className="finput" value={c.name||""} onChange={e=>set("name",e.target.value)} placeholder="e.g. NOC email"/>
          <label className="flabel">Type</label>
          <div className="auth-tabs">
            {KINDS.map(([k,l])=><button key={k} className={`auth-tab ${c.kind===k?"on":""}`} onClick={()=>set("kind",k)}>{l}</button>)}
          </div>

          {c.kind==="webhook" && <>
            <label className="flabel">Webhook URL</label>
            <input className="finput" value={c.config.url||""} onChange={e=>setCfg("url",e.target.value)} placeholder="https://hooks.example.com/..."/>
          </>}
          {c.kind==="discord" && <>
            <label className="flabel">Discord webhook URL</label>
            <input className="finput" value={c.config.url||""} onChange={e=>setCfg("url",e.target.value)} placeholder="https://discord.com/api/webhooks/..."/>
          </>}
          {c.kind==="syslog" && <>
            <div className="frow">
              <div><label className="flabel">Syslog host</label><input className="finput" value={c.config.host||""} onChange={e=>setCfg("host",e.target.value)} placeholder="10.0.0.50"/></div>
              <div><label className="flabel">Port</label><input className="finput" value={c.config.port||"514"} onChange={e=>setCfg("port",e.target.value)}/></div>
            </div>
          </>}
          {c.kind==="email" && <>
            <div className="frow">
              <div><label className="flabel">SMTP server</label><input className="finput" value={c.config.server||""} onChange={e=>setCfg("server",e.target.value)} placeholder="smtp.gmail.com"/></div>
              <div><label className="flabel">Port</label><input className="finput" value={c.config.port||"587"} onChange={e=>setCfg("port",e.target.value)}/></div>
            </div>
            <label className="flabel">From address</label>
            <input className="finput" value={c.config.from||""} onChange={e=>setCfg("from",e.target.value)} placeholder="switchdex@example.com"/>
            <label className="flabel">To address(es)</label>
            <input className="finput" value={c.config.to||""} onChange={e=>setCfg("to",e.target.value)} placeholder="noc@example.com"/>
            <div className="frow">
              <div><label className="flabel">Username</label><input className="finput" value={c.config.username||""} onChange={e=>setCfg("username",e.target.value)}/></div>
              <div><label className="flabel">Password</label><input className="finput" type="password" value={c.config.password||""} onChange={e=>setCfg("password",e.target.value)} placeholder="••••••••"/></div>
            </div>
          </>}

          <label className="flabel">Notify for severity ≥</label>
          <select className="finput" value={c.min_severity||"warning"} onChange={e=>set("min_severity",e.target.value)}>
            <option value="critical">Critical only</option><option value="warning">Warning and above</option><option value="info">All (info and above)</option>
          </select>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#e6edf3",marginTop:4,cursor:"pointer"}}>
            <input type="checkbox" checked={c.enabled!==false} onChange={e=>set("enabled",e.target.checked)}/> Enabled
          </label>
          {testMsg && <div style={{marginTop:10,fontSize:12,fontFamily:"'IBM Plex Mono',monospace",color:testMsg.ok===true?"#3fb950":testMsg.ok===false?"#f85149":"#8b949e"}}>{testMsg.t}</div>}
        </div>
        <div className="modal-footer">
          <button className="mbtn cancel" onClick={onClose}>Cancel</button>
          <button className="mbtn" style={{background:"#21262d",border:"1px solid #30363d",color:"#e6edf3"}} onClick={test}>Send test</button>
          <button className="mbtn add" onClick={()=>onSave(c)} disabled={!c.name}>Save channel</button>
        </div>
      </div>
    </div>
  );
}

function AlertsView({auth, onOpenDevice, devices=[]}) {
  const [tab, setTab] = useState("active");      // active | history | rules | channels
  const [alerts, setAlerts] = useState(SEED_ALERTS);
  const [rules, setRules] = useState(SEED_RULES);
  const [channels, setChannels] = useState(SEED_CHANNELS);
  const [editRule, setEditRule] = useState(null);     // rule object or {} for new
  const [editChan, setEditChan] = useState(null);     // channel object or {} for new
  const isAdmin = auth.user.role === "admin";

  function reloadRules(){ api.listRules().then(setRules).catch(()=>{}); }
  function reloadChannels(){ api.listChannels().then(setChannels).catch(()=>{}); }

  useEffect(()=>{
    if (MOCK_MODE) return;
    api.listAlerts().then(setAlerts).catch(()=>{});
    reloadRules();
    reloadChannels();
  }, []);

  function ack(id){
    if(!MOCK_MODE){ api.ackAlert(id).then(()=>api.listAlerts().then(setAlerts)); return; }
    setAlerts(a=>a.map(x=>x.id===id?{...x,state:"acknowledged",ackBy:auth.user.username}:x));
  }
  function resolve(id){
    if(!MOCK_MODE){ api.resolveAlert(id).then(()=>api.listAlerts().then(setAlerts)); return; }
    setAlerts(a=>a.map(x=>x.id===id?{...x,state:"resolved",resolvedBy:auth.user.username}:x));
  }
  function saveRule(r){
    const body = { name:r.name, enabled:r.enabled!==false, preset:r.preset||"custom",
      metric:r.metric||"", operator:r.operator||">", threshold:Number(r.threshold)||0,
      duration:Number(r.duration)||0, severity:r.severity||"warning", scope:r.scope||"",
      auto_resolve:r.auto_resolve!==false };
    const p = r.id ? api.updateRule(r.id, body) : api.addRule(body);
    p.then(()=>{ setEditRule(null); reloadRules(); }).catch(e=>alert("Save failed: "+e.message));
  }
  function delRule(id){ if(confirm("Delete this rule?")) api.deleteRule(id).then(reloadRules).catch(()=>{}); }
  function toggleRule(r){ api.updateRule(r.id, {...r, enabled:!r.enabled}).then(reloadRules).catch(()=>{}); }
  function saveChan(c){
    const body = { name:c.name, kind:c.kind||"webhook", enabled:c.enabled!==false,
      config:c.config||{}, min_severity:c.min_severity||"warning" };
    const p = c.id ? api.updateChannel(c.id, body) : api.addChannel(body);
    p.then(()=>{ setEditChan(null); reloadChannels(); }).catch(e=>alert("Save failed: "+e.message));
  }
  function delChan(id){ if(confirm("Delete this channel?")) api.deleteChannel(id).then(reloadChannels).catch(()=>{}); }

  const active = alerts.filter(a=>a.state!=="resolved");
  const resolved = alerts.filter(a=>a.state==="resolved");
  const kpis = {
    open: alerts.filter(a=>a.state==="open").length,
    ack: alerts.filter(a=>a.state==="acknowledged").length,
    crit: active.filter(a=>a.severity==="critical").length,
    warn: active.filter(a=>a.severity==="warning").length,
  };

  const sevIcon = (s)=> s==="critical"?IC.warn:s==="warning"?IC.bolt:IC.info;

  function AlertRow({a}) {
    return (
      <div className="al-row">
        <div className={`al-sev ${a.severity}`}/>
        <div className={`al-icon ${a.severity}`}>{sevIcon(a.severity)}</div>
        <div className="al-body" style={{cursor:a.deviceId?"pointer":"default"}} onClick={()=>a.deviceId&&onOpenDevice(a.deviceId)}>
          <div className="al-title">{a.title}</div>
          <div className="al-detail">{a.detail}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div className="al-meta">{alertAgo(a.openedAt)}</div>
          {a.ackBy && <div className="al-meta" style={{color:"#484f58"}}>ack: {a.ackBy}</div>}
          {a.resolvedBy && <div className="al-meta" style={{color:"#484f58"}}>resolved: {a.resolvedBy}</div>}
        </div>
        <span className={`al-state ${a.state}`}>{a.state}</span>
        {a.state==="open" && <button className="al-btn ack" onClick={()=>ack(a.id)}>Ack</button>}
        {a.state!=="resolved" && <button className="al-btn resolve" onClick={()=>resolve(a.id)}>Resolve</button>}
      </div>
    );
  }

  return (
    <div className="alerts-wrap">
      <div className="al-tabs">
        {[["active","Active"],["history","History"],["rules","Rules"],["channels","Channels"]].map(([k,l])=>(
          <button key={k} className={`fbtn ${tab===k?"on":""}`} onClick={()=>setTab(k)}>{l}</button>
        ))}
      </div>

      {tab==="active" && <>
        <div className="al-kpis">
          <div className="al-kpi"><div className="al-kpi-label">Open</div><div className="al-kpi-val" style={{color:kpis.open?"#f85149":"#e6edf3"}}>{kpis.open}</div></div>
          <div className="al-kpi"><div className="al-kpi-label">Acknowledged</div><div className="al-kpi-val" style={{color:"#e3b341"}}>{kpis.ack}</div></div>
          <div className="al-kpi"><div className="al-kpi-label">Critical</div><div className="al-kpi-val" style={{color:kpis.crit?"#f85149":"#e6edf3"}}>{kpis.crit}</div></div>
          <div className="al-kpi"><div className="al-kpi-label">Warning</div><div className="al-kpi-val" style={{color:kpis.warn?"#e3b341":"#e6edf3"}}>{kpis.warn}</div></div>
        </div>
        <div className="al-card">
          {active.length===0 ? <div className="al-empty">No active alerts — all clear.</div>
            : active.map(a=><AlertRow key={a.id} a={a}/>)}
        </div>
      </>}

      {tab==="history" && (
        <div className="al-card">
          {resolved.length===0 ? <div className="al-empty">No resolved alerts yet.</div>
            : resolved.map(a=><AlertRow key={a.id} a={a}/>)}
        </div>
      )}

      {tab==="rules" && (
        <div className="al-card">
          <div className="al-row" style={{background:"#010409"}}>
            <div className="al-body" style={{fontSize:11,fontWeight:600,color:"#8b949e",textTransform:"uppercase",letterSpacing:".06em"}}>Rule</div>
            <span style={{fontSize:11,color:"#8b949e",width:90}}>Condition</span>
            <span style={{fontSize:11,color:"#8b949e",width:70}}>Severity</span>
          </div>
          {rules.map(r=>(
            <div className="al-row" key={r.id}>
              <div className={`al-sev ${r.severity}`}/>
              <div className="al-body" style={{cursor:isAdmin?"pointer":"default"}} onClick={()=>isAdmin&&setEditRule(r)}>
                <div className="al-title">{r.name}</div>
                <div className="al-detail">{r.preset==="custom"?`${r.metric} ${r.operator} ${r.threshold}`:r.preset}{r.duration?` · held ${r.duration}s`:""}{r.auto_resolve?" · auto-resolve":""}</div>
              </div>
              <span className="al-meta" style={{width:90}}>{r.preset==="custom"?"custom":"preset"}{r.threshold?` · ${r.threshold}`:""}</span>
              <span className={`al-state ${r.severity==="critical"?"open":r.severity==="warning"?"acknowledged":"resolved"}`} style={{width:70,textAlign:"center"}}>{r.severity}</span>
              {isAdmin
                ? <span className={`al-state ${r.enabled?"resolved":""}`} style={{cursor:"pointer",background:r.enabled?undefined:"#21262d",color:r.enabled?undefined:"#8b949e"}} onClick={()=>toggleRule(r)} title="Toggle enabled">{r.enabled?"on":"off"}</span>
                : <span className={`al-state ${r.enabled?"resolved":""}`} style={{background:r.enabled?undefined:"#21262d",color:r.enabled?undefined:"#8b949e"}}>{r.enabled?"on":"off"}</span>}
              {isAdmin && <button className="al-btn" onClick={()=>setEditRule(r)} title="Edit">{IC.edit}</button>}
              {isAdmin && <button className="al-btn resolve" onClick={()=>delRule(r.id)} title="Delete" style={{color:"#f85149"}}>{IC.x}</button>}
            </div>
          ))}
          {isAdmin && <div className="al-row"><button className="al-btn" style={{margin:"0 auto"}} onClick={()=>setEditRule({preset:"custom",metric:"cpu",operator:">",threshold:85,severity:"warning",duration:0,auto_resolve:true,enabled:true})}>{IC.plus} Add custom rule</button></div>}
        </div>
      )}

      {tab==="channels" && (
        <div className="al-card">
          {channels.map(c=>(
            <div className="al-row" key={c.id}>
              <span className="chan-kind">{c.kind}</span>
              <div className="al-body" style={{cursor:isAdmin?"pointer":"default"}} onClick={()=>isAdmin&&setEditChan(c)}>
                <div className="al-title">{c.name}</div>
                <div className="al-detail">{c.config?.to||c.config?.url||c.config?.host||"configured"} · ≥ {c.min_severity}</div>
              </div>
              <span className={`al-state ${c.enabled?"resolved":""}`} style={{background:c.enabled?undefined:"#21262d",color:c.enabled?undefined:"#8b949e"}}>{c.enabled?"enabled":"off"}</span>
              {isAdmin && <button className="al-btn" onClick={()=>setEditChan(c)} title="Edit">{IC.edit}</button>}
              {isAdmin && <button className="al-btn resolve" onClick={()=>delChan(c.id)} title="Delete" style={{color:"#f85149"}}>{IC.x}</button>}
            </div>
          ))}
          {isAdmin && <div className="al-row"><button className="al-btn" style={{margin:"0 auto"}} onClick={()=>setEditChan({kind:"webhook",min_severity:"warning",enabled:true,config:{}})}>{IC.plus} Add channel (email · webhook · syslog · Discord)</button></div>}
        </div>
      )}

      {editRule && <RuleEditor rule={editRule} devices={devices} onSave={saveRule} onClose={()=>setEditRule(null)}/>}
      {editChan && <ChannelEditor chan={editChan} onSave={saveChan} onClose={()=>setEditChan(null)}/>}
    </div>
  );
}

/* ───────────────────────── Topology ────────────────────────────────── */
// Build graph from device list in mock mode (mirrors backend _infer_links).
function buildMockGraph(devices) {
  const roleOf = (d) => {
    if (d.role) return d.role;
    const n = (d.name + " " + d.type).toLowerCase();
    if (d.type === "firewall" || n.includes("edge") || n.includes("perimeter")) return "edge";
    if (n.includes("core")) return "core";
    if (n.includes("dist")) return "distribution";
    if (d.type === "router") return "core";
    return "access";
  };
  const nodes = devices.map(d => ({ id:d.id, name:d.name, ip:d.ip, type:d.type, vendor:d.vendor,
    status:d.status, role:roleOf(d), source:d.source||"open", capability:d.capability||"manage" }));
  const byRole = { core:[], distribution:[], access:[], edge:[] };
  nodes.forEach(n => byRole[n.role]?.push(n));
  const links = []; const add=(a,b)=>links.push({source:a.id,target:b.id,status:(a.status==="up"&&b.status==="up")?"up":"down"});
  const cores = byRole.core;
  for (let i=0;i<cores.length;i++) for (let j=i+1;j<cores.length;j++) add(cores[i],cores[j]);
  byRole.distribution.forEach((d,i)=>cores.length&&add(d,cores[i%cores.length]));
  const up = byRole.distribution.length?byRole.distribution:cores;
  byRole.access.forEach((a,i)=>up.length&&add(a,up[i%up.length]));
  byRole.edge.forEach(e=>cores.length&&add(e,cores[0]));
  return { nodes, links };
}

const ROLE_COLOR = { core:"#58a6ff", distribution:"#3fb950", access:"#bc8cff", edge:"#e3b341" };

// Format an LLDP port id for display. Some neighbors advertise the port as a
// MAC address (hex octets, e.g. "40 ED 00 12 0A FE") rather than a name; show
// those as a tidy MAC, and pass through real interface names unchanged.
function fmtPortId(v) {
  if (!v) return "—";
  const s = String(v).trim();
  const hex = s.replace(/[\s:]/g, "");
  if (/^[0-9A-Fa-f]{12}$/.test(hex)) {
    return hex.match(/.{2}/g).join(":").toLowerCase() + " (MAC)";
  }
  return s;
}

function TopologyView({devices, onOpenDevice}) {
  const [layout, setLayout] = useState("force");   // force | layered
  const [discovering, setDiscovering] = useState(false);
  const [discMsg, setDiscMsg] = useState(null);
  const [hoverLink, setHoverLink] = useState(null);   // {i, x, y}
  const [graph, setGraph] = useState(()=>MOCK_MODE?buildMockGraph(devices):{nodes:[],links:[]});
  const [pos, setPos] = useState({});               // id -> {x,y}
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const rafRef = useRef(null);
  const W = 900, H = 560;

  // load graph in real mode
  useEffect(()=>{
    if (MOCK_MODE) { setGraph(buildMockGraph(devices)); return; }
    api.getTopology().then(setGraph).catch(()=>setGraph({nodes:[],links:[]}));
  }, [devices]);

  function discover(){
    if (discovering) return;
    setDiscovering(true); setDiscMsg(null);
    api.discoverTopology()
      .then(res=>{
        const total = (res.results||[]).reduce((a,r)=>a+(r.neighbors||0),0);
        setDiscMsg(`Found ${total} neighbor link${total===1?"":"s"} across ${(res.results||[]).length} devices`);
        return api.getTopology().then(setGraph);
      })
      .catch(e=>setDiscMsg("Discovery failed: "+(e.message||"error")))
      .finally(()=>setDiscovering(false));
  }

  // layered positions: rows by role
  function layeredPositions(nodes) {
    const rows = ["core","distribution","access","edge"];
    const p = {};
    rows.forEach((role,ri)=>{
      const inRow = nodes.filter(n=>n.role===role);
      const y = 90 + ri*((H-150)/3);
      inRow.forEach((n,i)=>{ p[n.id] = { x: (W/(inRow.length+1))*(i+1), y, fx:true }; });
    });
    return p;
  }

  // force simulation (lightweight; runs ~120 ticks then settles)
  useEffect(()=>{
    cancelAnimationFrame(rafRef.current);
    const nodes = graph.nodes; if(!nodes.length){ setPos({}); return; }

    if (layout==="layered") { setPos(layeredPositions(nodes)); return; }

    // seed random positions near center
    const st = {};
    nodes.forEach((n,i)=>{ const a=(i/nodes.length)*Math.PI*2; st[n.id]={x:W/2+Math.cos(a)*180+(Math.random()*40-20), y:H/2+Math.sin(a)*150+(Math.random()*40-20), vx:0, vy:0}; });
    const linkPairs = graph.links.map(l=>[l.source,l.target]);
    let tick=0;
    const step=()=>{
      // repulsion
      const ids=Object.keys(st);
      for(let i=0;i<ids.length;i++){ for(let j=i+1;j<ids.length;j++){
        const a=st[ids[i]], b=st[ids[j]]; let dx=a.x-b.x, dy=a.y-b.y; let d2=dx*dx+dy*dy||0.01; let d=Math.sqrt(d2);
        const rep=9000/d2; const fx=dx/d*rep, fy=dy/d*rep; a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;
      }}
      // spring on links
      linkPairs.forEach(([s,t])=>{ const a=st[s],b=st[t]; if(!a||!b)return; let dx=b.x-a.x,dy=b.y-a.y; let d=Math.sqrt(dx*dx+dy*dy)||0.01; const k=(d-150)*0.01; const fx=dx/d*k,fy=dy/d*k; a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy; });
      // center gravity + integrate
      Object.values(st).forEach(n=>{ n.vx+=(W/2-n.x)*0.002; n.vy+=(H/2-n.y)*0.002; n.vx*=0.85;n.vy*=0.85; n.x+=n.vx;n.y+=n.vy; n.x=Math.max(40,Math.min(W-40,n.x)); n.y=Math.max(40,Math.min(H-40,n.y)); });
      setPos({...st}); tick++;
      if(tick<140) rafRef.current=requestAnimationFrame(step);
    };
    rafRef.current=requestAnimationFrame(step);
    return ()=>cancelAnimationFrame(rafRef.current);
  }, [graph, layout]);

  const nodeById = Object.fromEntries(graph.nodes.map(n=>[n.id,n]));

  return (
    <div className="topo-wrap">
      <div className="topo-toolbar">
        <div className="topo-seg">
          <button className={layout==="force"?"on":""} onClick={()=>setLayout("force")}>Force</button>
          <button className={layout==="layered"?"on":""} onClick={()=>setLayout("layered")}>Layered</button>
        </div>
        <span style={{fontSize:12,color:"#8b949e"}}>{graph.nodes.length} devices · {graph.links.length} links</span>
        {!MOCK_MODE && <button className="fbtn" onClick={discover} disabled={discovering} style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{display:"inline-flex",animation:discovering?"sdx-spin 0.7s linear infinite":"none"}}>{IC.refresh}</span>
          {discovering?"Discovering…":"Discover neighbors"}
        </button>}
        {discMsg && <span style={{fontSize:11,color:"#8b949e",fontFamily:"'IBM Plex Mono',monospace"}}>{discMsg}</span>}
        <div className="topo-legend">
          {Object.entries(ROLE_COLOR).map(([r,c])=>(<div key={r} className="topo-leg"><span className="topo-leg-dot" style={{background:c}}/>{r}</div>))}
          <div className="topo-leg"><span className="topo-leg-dot" style={{background:"#21262d",border:"1.5px dashed #8b949e"}}/>read-only</div>
        </div>
      </div>
      <div className="topo-canvas">
        <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
          {/* links */}
          {graph.links.map((l,i)=>{ const a=pos[l.source],b=pos[l.target]; if(!a||!b)return null;
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={l.status==="down"?"#5a2a2a":(hoverLink?.i===i?"#58a6ff":"#2c3440")}
                  strokeWidth={l.status==="down"?1:(hoverLink?.i===i?3:2)}
                  strokeDasharray={l.status==="down"?"4 3":"none"}/>
                {/* wide invisible hit area for easy hovering */}
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14}
                  style={{cursor:"pointer"}}
                  onMouseEnter={()=>setHoverLink({i, x:(a.x+b.x)/2, y:(a.y+b.y)/2})}
                  onMouseLeave={()=>setHoverLink(null)}/>
              </g>
            );
          })}
          {/* nodes */}
          {graph.nodes.map(n=>{ const p=pos[n.id]; if(!p)return null; const col=ROLE_COLOR[n.role]||"#8b949e";
            const ro=n.capability==="readonly"; const down=n.status==="down";
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} style={{cursor:"pointer"}}
                 onClick={()=>onOpenDevice(n.id)} onMouseEnter={()=>setHover(n.id)} onMouseLeave={()=>setHover(null)}>
                {hover===n.id && <circle r={26} fill="none" stroke={col} strokeWidth={1} opacity={0.5}/>}
                <circle r={18} fill={down?"#1a1014":"#161b22"} stroke={ro?"#8b949e":col} strokeWidth={2}
                        strokeDasharray={ro?"3 2":"none"} opacity={down?0.55:1}/>
                <circle r={5} cx={12} cy={-12} fill={down?"#f85149":n.status==="warn"?"#e3b341":"#3fb950"} stroke="#0a0d12" strokeWidth={1.5}/>
                <g transform="translate(-9,-9)" stroke={ro?"#8b949e":col} fill="none" strokeWidth={2} opacity={down?0.6:1}>
                  {n.type==="router" && <g><rect x="0" y="6" width="18" height="7" rx="1.5"/><path d="M4 9.5h.01M8 9.5h.01"/></g>}
                  {n.type==="switch" && <g><rect x="0" y="5" width="18" height="9" rx="1.5"/><path d="M3 9.5h12M4 7.5v4M8 7.5v4M12 7.5v4"/></g>}
                  {n.type==="firewall" && <path d="M9 17s7-3.5 7-8.5V3.5L9 1 2 3.5v5C2 13.5 9 17 9 17z"/>}
                  {n.type==="ap" && <g><path d="M3 10a8 8 0 0112 0"/><path d="M6 12a4 4 0 016 0"/><circle cx="9" cy="15" r="1" fill={col}/></g>}
                </g>
                <text className="topo-node-label" textAnchor="middle" y={32}>{n.name}</text>
                <text className="topo-node-sub" textAnchor="middle" y={42}>{n.ip}</text>
              </g>
            );
          })}
          {/* link hover tooltip: which ports connect the two devices */}
          {hoverLink && (()=>{
            const l=graph.links[hoverLink.i]; if(!l) return null;
            const byId=Object.fromEntries(graph.nodes.map(n=>[n.id,n]));
            const sName=byId[l.source]?.name||l.source, tName=byId[l.target]?.name||l.target;
            const lines=[`${sName} — ${tName}`,
                         `${sName}: ${fmtPortId(l.local_if)}`,
                         `${tName}: ${fmtPortId(l.peer_if)}`];
            const bw=Math.max(...lines.map(s=>s.length))*6.2+16, bh=lines.length*15+10;
            let bx=hoverLink.x+10, by=hoverLink.y-bh-6;
            if(bx+bw>W) bx=W-bw-4; if(by<0) by=hoverLink.y+10;
            return (
              <g pointerEvents="none">
                <rect x={bx} y={by} width={bw} height={bh} rx={6} fill="#161b22" stroke="#30363d"/>
                {lines.map((s,k)=>(
                  <text key={k} x={bx+8} y={by+16+k*15} fontSize={11}
                        fill={k===0?"#e6edf3":"#8b949e"} fontWeight={k===0?600:400}
                        fontFamily="'IBM Plex Mono', monospace">{s}</text>
                ))}
              </g>
            );
          })()}
        </svg>
        <div className="topo-hint">{layout==="force"?"Force-directed — physics layout":"Layered — by role (core → distribution → access → edge)"} · click a node for details · hover a link for ports</div>
      </div>
    </div>
  );
}

/* ───────────────────────── Integrations (controllers) ──────────────── */
const SEED_CONTROLLERS = [
  { id:1, name:"HQ UniFi", kind:"unifi", base_url:"https://10.0.9.2:8443", site:"default", enabled:true, last_status:"ok", device_count:3, poll_interval:300 },
  { id:2, name:"Branch Omada", kind:"omada", base_url:"https://10.0.9.3:8043", site:"Default", enabled:true, last_status:"ok", device_count:2, poll_interval:300 },
];

function IntegrationsView({auth}) {
  const [controllers, setControllers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name:"", kind:"unifi", base_url:"", site:"default",
    username:"", password:"", client_id:"", client_secret:"", controller_ident:"" });
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = auth.user.role === "admin";

  function load() {
    if (MOCK_MODE) { setControllers(SEED_CONTROLLERS); setLoading(false); return; }
    api.listControllers().then(cs => { setControllers(cs||[]); setLoading(false); })
      .catch(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function testConn() {
    if (!form.base_url) { setTestResult({ ok:false, msg:"Enter the controller URL first" }); return; }
    if (MOCK_MODE) { setTestResult({ ok:true, msg:`Reached ${form.kind} controller — devices visible (simulated)` }); return; }
    setBusy(true); setTestResult(null);
    api.testController(form)
      .then(r => { setBusy(false); setTestResult({ ok:r.ok, msg:r.message || (r.ok?"Connection OK":"Connection failed") }); })
      .catch(e => { setBusy(false); setTestResult({ ok:false, msg:e.message }); });
  }
  function save() {
    if (!form.name || !form.base_url) return;
    if (MOCK_MODE) {
      setControllers(c => [...c, { id:Date.now(), ...form, enabled:true, last_status:"ok", device_count: form.kind==="unifi"?3:2, poll_interval:300 }]);
      setAdding(false); setTestResult(null); resetForm(); return;
    }
    setBusy(true);
    api.addController(form)
      .then(() => { setBusy(false); setAdding(false); setTestResult(null); resetForm(); load(); })
      .catch(e => { setBusy(false); setTestResult({ ok:false, msg:"Save failed: "+e.message }); });
  }
  function del(id){
    if (MOCK_MODE) { setControllers(c=>c.filter(x=>x.id!==id)); return; }
    api.deleteController(id).then(load).catch(e=>setTestResult({ok:false,msg:"Delete failed: "+e.message}));
  }
  function sync(id){
    if (MOCK_MODE) { setTestResult({ok:true,msg:"Re-synced (simulated)"}); return; }
    setTestResult({ok:true,msg:"Syncing…"});
    api.syncController(id).then(r=>{ setTestResult({ok:true,msg:`Synced — ${r.device_count ?? "?"} devices`}); load(); })
      .catch(e=>setTestResult({ok:false,msg:"Sync failed: "+e.message}));
  }
  function resetForm(){ setForm({ name:"", kind:"unifi", base_url:"", site:"default", username:"", password:"", client_id:"", client_secret:"", controller_ident:"" }); }

  return (
    <div className="settings-wrap">
      <div className="ro-banner" style={{maxWidth:680,marginBottom:16}}>{IC.eye}
        <div>Controllers let SwitchDex pull <b style={{fontWeight:600}}>read-only metrics</b> from closed ecosystems (UniFi, Omada). Managed devices appear in inventory tagged read-only; configuration stays in the vendor controller. Omada's Open API also supports writes, reserved for a future managed mode.</div>
      </div>

      <div className="set-section">
        <div style={{display:"flex",alignItems:"center"}}>
          <div style={{flex:1}}><div className="set-h">Connected controllers</div><div className="set-desc" style={{marginBottom:0}}>Polled every 5 minutes for fresh telemetry.</div></div>
          {isAdmin && !adding && <button className="set-btn primary" onClick={()=>setAdding(true)}>{IC.plus} Add controller</button>}
        </div>
        <div style={{marginTop:14}}>
          {controllers.length===0 && <div style={{fontSize:13,color:"#6e7681",textAlign:"center",padding:"16px"}}>No controllers connected.</div>}
          {controllers.map(c=>(
            <div className="u-row" key={c.id}>
              <span className={`ptag ${c.kind}`} style={{fontSize:11}}>{c.kind==="unifi"?"UniFi":"Omada"}</span>
              <div className="u-name">{c.name}<div style={{fontSize:11,color:"#8b949e",fontWeight:400,fontFamily:"IBM Plex Mono,monospace"}}>{c.base_url} · site {c.site}</div></div>
              <span className="metric-label" style={{margin:0}}>{c.device_count} devices</span>
              <span className={`bk-status ${c.last_status==="ok"?"ok":"failed"}`}><span style={{width:6,height:6,borderRadius:"50%",background:"currentColor"}}/>{c.last_status==="ok"?"synced":"error"}</span>
              {isAdmin && <div className="va" title="Sync now" onClick={()=>sync(c.id)} style={{cursor:"pointer"}}>{IC.refresh}</div>}
              {isAdmin && <div className="va" title="Remove" onClick={()=>del(c.id)} style={{cursor:"pointer"}}>{IC.x}</div>}
            </div>
          ))}
        </div>
      </div>

      {adding && isAdmin && (
        <div className="set-section">
          <div className="set-h">Add controller</div>
          <div className="seg" style={{marginBottom:16}}>
            <button className={`seg-btn ${form.kind==="unifi"?"on":""}`} onClick={()=>setForm(f=>({...f,kind:"unifi"}))}>UniFi</button>
            <button className={`seg-btn ${form.kind==="omada"?"on":""}`} onClick={()=>setForm(f=>({...f,kind:"omada"}))}>Omada</button>
          </div>
          <div className="set-row2" style={{marginBottom:13}}>
            <div><label className="set-label">Name</label><input className="set-input" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></div>
            <div><label className="set-label">Site</label><input className="set-input" value={form.site} onChange={e=>setForm(f=>({...f,site:e.target.value}))}/></div>
          </div>
          <div className="set-field"><label className="set-label">Controller URL</label><input className="set-input" placeholder={form.kind==="unifi"?"https://10.0.9.2:8443":"https://10.0.9.3:8043"} value={form.base_url} onChange={e=>setForm(f=>({...f,base_url:e.target.value}))}/></div>
          {form.kind==="unifi" ? <>
            <div className="set-row2">
              <div><label className="set-label">Username</label><input className="set-input" value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/></div>
              <div><label className="set-label">Password</label><input className="set-input" type="password" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/></div>
            </div>
          </> : <>
            <div className="set-field"><label className="set-label">Omada Controller ID (omadacId)</label><input className="set-input" value={form.controller_ident} onChange={e=>setForm(f=>({...f,controller_ident:e.target.value}))}/></div>
            <div className="set-row2">
              <div><label className="set-label">Client ID</label><input className="set-input" value={form.client_id} onChange={e=>setForm(f=>({...f,client_id:e.target.value}))}/></div>
              <div><label className="set-label">Client secret</label><input className="set-input" type="password" value={form.client_secret} onChange={e=>setForm(f=>({...f,client_secret:e.target.value}))}/></div>
            </div>
          </>}
          <div style={{display:"flex",gap:8,marginTop:14}}>
            <button className="set-btn" onClick={()=>{setAdding(false);setTestResult(null);}}>Cancel</button>
            <button className="set-btn test" onClick={testConn}>Test connection</button>
            <button className="set-btn primary" onClick={save}>Save & sync</button>
          </div>
          {testResult && <div className={`test-result ${testResult.ok?"ok":"fail"}`}>{testResult.msg}</div>}
        </div>
      )}
      {!adding && testResult && <div className="set-section" style={{maxWidth:680}}><div className={`test-result ${testResult.ok?"ok":"fail"}`} style={{marginTop:0}}>{testResult.msg}</div></div>}
    </div>
  );
}

/* ───────────────────────── Settings → Users & LDAP ─────────────────── */
// Demo data store (in real deployment these call /api/auth/users and /api/auth/ldap)
const SEED_USERS = [
  { id: 1, username: "admin", role: "admin", source: "local", enabled: true },
];

function SettingsView({auth}) {
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState(SEED_USERS);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "operator" });
  const [ldap, setLdap] = useState({
    ldap_enabled: false, directory_type: "ad", server_uri: "", use_tls: true,
    base_dn: "", bind_dn: "", bind_password: "", user_attr: "sAMAccountName",
    user_filter: "", admin_group_dn: "",
  });
  const [testResult, setTestResult] = useState(null);
  const isAdmin = auth.user.role === "admin";

  function addUser() {
    if (!newUser.username) return;
    setUsers(u => [...u, { id: Date.now(), ...newUser, source: "local", enabled: true }]);
    setNewUser({ username: "", password: "", role: "operator" });
  }
  function delUser(id) {
    if (users.find(u => u.id === id)?.username === auth.user.username) return;
    setUsers(u => u.filter(x => x.id !== id));
  }
  function setDirType(t) {
    setLdap(l => ({ ...l, directory_type: t, user_attr: t === "ad" ? "sAMAccountName" : "uid" }));
  }
  function testLdap() {
    // real deployment: POST /api/auth/ldap/test
    setTestResult(ldap.server_uri
      ? { ok: true, msg: "Bind succeeded — directory reachable (simulated)" }
      : { ok: false, msg: "Enter a server URI first" });
  }

  if (!isAdmin) {
    return <div className="settings-wrap"><div className="set-section"><div className="set-h">Access restricted</div><div className="set-desc">Settings require the admin role. You're signed in as {auth.user.role}.</div></div></div>;
  }

  return (
    <div className="settings-wrap">
      <div style={{display:"flex",gap:8,marginBottom:18}}>
        <button className={`fbtn ${tab==="users"?"on":""}`} onClick={()=>setTab("users")}>Local users</button>
        <button className={`fbtn ${tab==="ldap"?"on":""}`} onClick={()=>setTab("ldap")}>LDAP / Active Directory</button>
      </div>

      {tab==="users" && <>
        <div className="set-section">
          <div className="set-h">Local accounts</div>
          <div className="set-desc">Local users authenticate against this appliance. Keep at least one local admin as a break-glass account in case the directory is unreachable.</div>
          {users.map(u=>(
            <div className="u-row" key={u.id}>
              <div className="u-av">{u.username.slice(0,2).toUpperCase()}</div>
              <div className="u-name">{u.username}</div>
              <span className={`role-tag ${u.role}`}>{u.role}</span>
              <span className="src-tag">{u.source}</span>
              {u.username!==auth.user.username && <div className="va" title="Delete" onClick={()=>delUser(u.id)} style={{cursor:"pointer"}}>{IC.x}</div>}
            </div>
          ))}
        </div>
        <div className="set-section">
          <div className="set-h">Add local user</div>
          <div className="set-row2" style={{marginBottom:12}}>
            <div><label className="set-label">Username</label><input className="set-input" value={newUser.username} onChange={e=>setNewUser(n=>({...n,username:e.target.value}))}/></div>
            <div><label className="set-label">Password</label><input className="set-input" type="password" value={newUser.password} onChange={e=>setNewUser(n=>({...n,password:e.target.value}))}/></div>
          </div>
          <div className="set-field"><label className="set-label">Role</label>
            <select className="set-select" value={newUser.role} onChange={e=>setNewUser(n=>({...n,role:e.target.value}))}>
              <option value="admin">admin — full control</option>
              <option value="operator">operator — configure devices</option>
              <option value="viewer">viewer — read only</option>
            </select>
          </div>
          <button className="set-btn primary" onClick={addUser}>{IC.plus} Create user</button>
        </div>
      </>}

      {tab==="ldap" && <>
        <div className="set-section">
          <div className="set-toggle-row" style={{borderBottom:"none",marginBottom:0,paddingBottom:0}}>
            <div><div className="set-h" style={{marginBottom:2}}>Directory authentication</div><div className="set-desc" style={{marginBottom:0}}>When enabled, login tries the directory first, then falls back to local accounts.</div></div>
            <div className={`tgl ${ldap.ldap_enabled?"on":""}`} onClick={()=>setLdap(l=>({...l,ldap_enabled:!l.ldap_enabled}))}/>
          </div>
        </div>

        {ldap.ldap_enabled && <>
          <div className="set-section">
            <div className="set-h">Directory type</div>
            <div className="seg" style={{marginBottom:16}}>
              <button className={`seg-btn ${ldap.directory_type==="ad"?"on":""}`} onClick={()=>setDirType("ad")}>Active Directory</button>
              <button className={`seg-btn ${ldap.directory_type==="openldap"?"on":""}`} onClick={()=>setDirType("openldap")}>OpenLDAP</button>
            </div>
            <div className="set-field"><label className="set-label">Server URI</label><input className="set-input" placeholder={ldap.use_tls?"ldaps://dc01.example.com:636":"ldap://dc01.example.com:389"} value={ldap.server_uri} onChange={e=>setLdap(l=>({...l,server_uri:e.target.value}))}/></div>
            <div className="set-toggle-row">
              <span style={{fontSize:13,color:"#e6edf3"}}>Use TLS (LDAPS)</span>
              <div className={`tgl ${ldap.use_tls?"on":""}`} onClick={()=>setLdap(l=>({...l,use_tls:!l.use_tls}))}/>
            </div>
            <div className="set-field"><label className="set-label">Base DN</label><input className="set-input" placeholder="DC=example,DC=com" value={ldap.base_dn} onChange={e=>setLdap(l=>({...l,base_dn:e.target.value}))}/></div>
          </div>

          <div className="set-section">
            <div className="set-h">Service account (for user lookups)</div>
            <div className="set-desc">A read-only bind account used to search for users and read group membership.</div>
            <div className="set-field"><label className="set-label">Bind DN</label><input className="set-input" placeholder={ldap.directory_type==="ad"?"CN=svc-switchdex,OU=Service,DC=example,DC=com":"cn=readonly,dc=example,dc=com"} value={ldap.bind_dn} onChange={e=>setLdap(l=>({...l,bind_dn:e.target.value}))}/></div>
            <div className="set-field"><label className="set-label">Bind password</label><input className="set-input" type="password" value={ldap.bind_password} onChange={e=>setLdap(l=>({...l,bind_password:e.target.value}))}/></div>
          </div>

          <div className="set-section">
            <div className="set-h">User & group mapping</div>
            <div className="set-row2" style={{marginBottom:13}}>
              <div><label className="set-label">User attribute</label><input className="set-input" value={ldap.user_attr} onChange={e=>setLdap(l=>({...l,user_attr:e.target.value}))}/></div>
              <div><label className="set-label">Extra filter (optional)</label><input className="set-input" placeholder="(memberOf=...)" value={ldap.user_filter} onChange={e=>setLdap(l=>({...l,user_filter:e.target.value}))}/></div>
            </div>
            <div className="set-field"><label className="set-label">Admin group DN — members get admin role</label><input className="set-input" placeholder="CN=NetOps-Admins,OU=Groups,DC=example,DC=com" value={ldap.admin_group_dn} onChange={e=>setLdap(l=>({...l,admin_group_dn:e.target.value}))}/></div>
            <div className="set-desc" style={{marginBottom:0}}>Users in this group sign in as admin; all other directory users get viewer access.</div>
          </div>
        </>}

        <div className="set-section">
          <div style={{display:"flex",gap:8}}>
            <button className="set-btn test" onClick={testLdap}>Test connection</button>
            <button className="set-btn primary" onClick={()=>setTestResult({ok:true,msg:"Settings saved (simulated)"})}>Save LDAP settings</button>
          </div>
          {testResult && <div className={`test-result ${testResult.ok?"ok":"fail"}`}>{testResult.msg}</div>}
        </div>
      </>}
    </div>
  );
}

/* ───────────────────────── Login screen ────────────────────────────── */
// Demo credentials (real deployment posts to /api/auth/login):
//   admin / admin   → admin role
//   anything else with a password → operator (simulates a directory user)
function LoginScreen({onLogin}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  function submit() {
    setErr(""); setBusy(true);
    if (!MOCK_MODE) {
      api.login(username, password)
        .then(d => { setBusy(false); onLogin({ user: d.user, mustChange: d.must_change_pw }); })
        .catch(e => { setBusy(false); setErr(e.message === "Unauthorized" ? "Invalid credentials." : e.message); });
      return;
    }
    setTimeout(() => {           // simulated round-trip
      setBusy(false);
      if (!username || !password) { setErr("Enter a username and password."); return; }
      if (username === "admin" && password === "admin") {
        onLogin({ user: { username: "admin", role: "admin", source: "local" } });
      } else if (password.length >= 3) {
        onLogin({ user: { username, role: "operator", source: "local" } });
      } else {
        setErr("Invalid credentials.");
      }
    }, 450);
  }

  return (
    <>
      <style>{css}</style>
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo">{IC.layers}</div>
          <div className="login-title">Switch<span>Dex</span></div>
          <div className="login-sub">Network Infrastructure Monitoring</div>
          {err && <div className="login-err">{err}</div>}
          <label className="login-label">Username</label>
          <input className="login-input" value={username} autoFocus
            onChange={e=>setUsername(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} />
          <label className="login-label">Password</label>
          <input className="login-input" type="password" value={password}
            onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} />
          <button className="login-btn" onClick={submit} disabled={busy}>{busy?"Signing in…":"Sign in"}</button>
          <div className="login-foot">Local or directory account. Demo: admin / admin.<br/>Directory users authenticate via LDAP / Active Directory when enabled.</div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Forced password change ─────────────────── */
function ForcePasswordChange({ auth, onDone, onLogout }) {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  function submit() {
    setErr("");
    if (pw.length < 8) { setErr("New password must be at least 8 characters."); return; }
    if (pw !== pw2) { setErr("New passwords do not match."); return; }
    if (pw === cur) { setErr("New password must be different from the current one."); return; }
    setBusy(true);
    if (!MOCK_MODE) {
      api.changePassword(cur, pw)
        .then(() => { setBusy(false); onDone(); })
        .catch(e => { setBusy(false); setErr(e.message === "Bad Request" ? "Current password is incorrect." : e.message); });
      return;
    }
    setTimeout(() => { setBusy(false); onDone(); }, 450);   // simulated
  }

  return (
    <>
      <style>{css}</style>
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo">{IC.layers}</div>
          <div className="login-title">Switch<span>Dex</span></div>
          <div className="login-sub">Set a new admin password</div>
          <div className="login-foot" style={{ marginTop: 10, marginBottom: 4 }}>
            This is the break-glass <strong>{auth.user.username}</strong> account. For security you must
            replace the temporary bootstrap password before continuing.
          </div>
          {err && <div className="login-err">{err}</div>}
          <label className="login-label">Current (bootstrap) password</label>
          <input className="login-input" type="password" value={cur} autoFocus
            onChange={e=>setCur(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} />
          <label className="login-label">New password</label>
          <input className="login-input" type="password" value={pw}
            onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} />
          <label className="login-label">Confirm new password</label>
          <input className="login-input" type="password" value={pw2}
            onChange={e=>setPw2(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} />
          <button className="login-btn" onClick={submit} disabled={busy}>{busy?"Updating…":"Set password & continue"}</button>
          <div className="login-foot">
            Minimum 8 characters. <span style={{ color: "#58a6ff", cursor: "pointer" }} onClick={onLogout}>Sign out instead</span>
          </div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Error boundary ─────────────────────────── */
class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state={err:null}; }
  static getDerivedStateFromError(err){ return {err}; }
  componentDidCatch(err,info){ console.error("SwitchDex render error:", err, info); }
  render(){
    if (this.state.err) {
      return (
        <div style={{padding:"40px",maxWidth:560,margin:"40px auto",fontFamily:"IBM Plex Sans,sans-serif",color:"#e6edf3",background:"#161b22",border:"1px solid #30363d",borderRadius:12}}>
          <div style={{fontSize:16,fontWeight:600,marginBottom:8}}>Something went wrong rendering this view.</div>
          <div style={{fontSize:13,color:"#8b949e",marginBottom:14}}>The rest of SwitchDex is fine — this panel hit an error. You can reload, or go back to the inventory.</div>
          <pre style={{fontSize:11,color:"#f85149",background:"#010409",padding:"10px 12px",borderRadius:6,overflow:"auto",marginBottom:14}}>{String(this.state.err && this.state.err.message || this.state.err)}</pre>
          <button onClick={()=>{ this.setState({err:null}); window.location.reload(); }}
            style={{padding:"8px 14px",borderRadius:6,border:"1px solid #2ea043",background:"#238636",color:"#fff",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ───────────────────────── Auth gate / root ───────────────────────── */
export default function App() {
  // Token persists in localStorage (real mode); session state in React.
  const [auth, setAuth] = useState(null);
  const [booting, setBooting] = useState(!MOCK_MODE);

  // On load, if we have a stored token, restore the session instead of
  // bouncing the user to the login screen on every refresh.
  useEffect(() => {
    if (MOCK_MODE) { setBooting(false); return; }
    const tok = _loadTok();
    if (!tok) { setBooting(false); return; }
    api.me()
      .then(user => { setAuth({ user, mustChange: false }); })
      .catch(() => { _setTok(null); })   // token invalid/expired → fall through to login
      .finally(() => setBooting(false));
  }, []);

  // Force logout if the backend rejects our token (expired/invalid).
  useEffect(() => {
    const onUnauth = () => setAuth(null);
    window.addEventListener("of-unauthorized", onUnauth);
    return () => window.removeEventListener("of-unauthorized", onUnauth);
  }, []);

  function logout() { if (!MOCK_MODE) api.logout(); setAuth(null); }

  if (booting) return (
    <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0d1117",color:"#8b949e",fontFamily:"'IBM Plex Sans',sans-serif",fontSize:14}}>
      <style>{css}</style>Restoring session…
    </div>
  );
  if (!auth) return <LoginScreen onLogin={setAuth} />;
  if (auth.mustChange) return <ForcePasswordChange auth={auth} onLogout={logout} onDone={()=>setAuth(a=>({...a, mustChange:false}))} />;
  return <ErrorBoundary><AppInner auth={auth} onLogout={logout} /></ErrorBoundary>;
}
