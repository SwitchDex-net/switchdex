/*
 * SwitchDex API client.
 *
 * Single place that talks to the backend: token storage, auth headers, every
 * REST endpoint, and the WebSocket SSH stream. Components call these functions
 * and never deal with fetch/headers/tokens directly.
 *
 * Base URL: same-origin "/api" by default (Caddy proxies it to the backend).
 * Override by setting window.SWITCHDEX_API before the app loads, e.g.
 *   <script>window.SWITCHDEX_API = "https://nms.example.com"</script>
 */

const BASE = (typeof window !== "undefined" && window.SWITCHDEX_API) || "";
const API = `${BASE}/api`;

// ── token storage (localStorage in the browser; guarded so it never throws) ──
let _token = null;
function loadToken() {
  if (_token) return _token;
  try { _token = localStorage.getItem("of_token"); } catch { _token = null; }
  return _token;
}
function setToken(t) {
  _token = t;
  try { t ? localStorage.setItem("of_token", t) : localStorage.removeItem("of_token"); } catch { /* ignore */ }
}
function clearToken() { setToken(null); }

// ── low-level fetch wrapper ──
async function req(path, { method = "GET", body, form } = {}) {
  const headers = {};
  const tok = loadToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API}${path}`, { method, headers, body: payload });

  if (res.status === 401) {            // token expired/invalid → force re-login
    clearToken();
    if (typeof window !== "undefined") window.dispatchEvent(new Event("of-unauthorized"));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// ── auth ──
export async function login(username, password) {
  const data = await req("/auth/login", { form: { username, password } });
  setToken(data.access_token);
  return data;                          // { access_token, user, must_change_pw }
}
export function logout() { clearToken(); }
export const me = () => req("/auth/me");
export const changePassword = (old_password, new_password) =>
  req("/auth/change-password", { method: "POST", body: { old_password, new_password } });
export const hasToken = () => !!loadToken();

// ── users (admin) ──
export const listUsers = () => req("/auth/users");
export const createUser = (u) => req("/auth/users", { method: "POST", body: u });
export const deleteUser = (id) => req(`/auth/users/${id}`, { method: "DELETE" });

// ── LDAP config (admin) ──
export const getLdap = () => req("/auth/ldap");
export const saveLdap = (cfg) => req("/auth/ldap", { method: "PUT", body: cfg });
export const testLdap = (cfg) => req("/auth/ldap/test", { method: "POST", body: cfg });

// ── inventory ──
export const listDevices = () => req("/devices");
export const probeDevice = (p) => req("/devices/probe", { method: "POST", body: p });
export const addDevice = (d) => req("/devices", { method: "POST", body: d });
export const deleteDevice = (id) => req(`/devices/${id}`, { method: "DELETE" });

// ── config archive ──
export const listConfigs = (id) => req(`/devices/${id}/configs`);
export const getConfig = (id, vid) => req(`/devices/${id}/configs/${vid}`);
export const diffConfigs = (id, a, b) => req(`/devices/${id}/configs/diff?a=${a}&b=${b}`);
export const backupDevice = (id) => req(`/devices/${id}/backup`, { method: "POST" });
export const restoreConfig = (id, vid) => req(`/devices/${id}/restore/${vid}`, { method: "POST" });
export const backupAll = () => req("/backup-all", { method: "POST" });

// ── integrations (UniFi / Omada controllers — read-only telemetry) ──
export const listControllers = () => req("/integrations");
export const addController = (c) => req("/integrations", { method: "POST", body: c });
export const testController = (c) => req("/integrations/test", { method: "POST", body: c });
export const syncController = (id) => req(`/integrations/${id}/sync`, { method: "POST" });
export const deleteController = (id) => req(`/integrations/${id}`, { method: "DELETE" });
export const deviceMetrics = (id) => req(`/integrations/devices/${id}/metrics`);

// ── topology ──
export const getTopology = () => req("/topology");

// ── alerts ──
export const listAlerts = (state = "") => req(`/alerts${state ? `?state=${state}` : ""}`);
export const alertSummary = () => req("/alerts/summary");
export const ackAlert = (id) => req(`/alerts/${id}/ack`, { method: "POST" });
export const resolveAlert = (id) => req(`/alerts/${id}/resolve`, { method: "POST" });
export const listRules = () => req("/alerts/rules");
export const createRule = (r) => req("/alerts/rules", { method: "POST", body: r });
export const updateRule = (id, r) => req(`/alerts/rules/${id}`, { method: "PUT", body: r });
export const deleteRule = (id) => req(`/alerts/rules/${id}`, { method: "DELETE" });
export const listChannels = () => req("/alerts/channels");
export const createChannel = (c) => req("/alerts/channels", { method: "POST", body: c });
export const deleteChannel = (id) => req(`/alerts/channels/${id}`, { method: "DELETE" });
export const testChannel = (c) => req("/alerts/channels/test", { method: "POST", body: c });

// ── compliance ──
export const compliance = () => req("/compliance");
export const complianceDevice = (id) => req(`/compliance/devices/${id}`);
export const listPolicies = () => req("/compliance/policies");
export const createPolicy = (p) => req("/compliance/policies", { method: "POST", body: p });
export const updatePolicy = (id, p) => req(`/compliance/policies/${id}`, { method: "PUT", body: p });
export const deletePolicy = (id) => req(`/compliance/policies/${id}`, { method: "DELETE" });
export const pinBaseline = (did, vid) => req(`/compliance/baselines/${did}/pin/${vid}`, { method: "POST" });
export const unpinBaseline = (did) => req(`/compliance/baselines/${did}`, { method: "DELETE" });
export const baselineDrift = (id) => req(`/compliance/devices/${id}/drift`);

// ── telemetry ──
export const metric = (id, metric, range = "24h", label = "") =>
  req(`/metrics/devices/${id}?metric=${metric}&range=${range}${label ? `&label=${encodeURIComponent(label)}` : ""}`);
export const metricInterfaces = (id, range = "24h") => req(`/metrics/devices/${id}/interfaces?range=${range}`);
export const metricSummary = (id) => req(`/metrics/devices/${id}/summary`);

// ── WebSocket SSH (token passed as query param — browsers can't set WS headers) ──
export function connectSSH(deviceId) {
  const tok = loadToken();
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const host = BASE ? BASE.replace(/^https?:\/\//, "") : location.host;
  return new WebSocket(`${scheme}://${host}/ws/ssh/${deviceId}?token=${encodeURIComponent(tok || "")}`);
}

export default {
  login, logout, me, changePassword, hasToken,
  listUsers, createUser, deleteUser,
  getLdap, saveLdap, testLdap,
  listDevices, probeDevice, addDevice, deleteDevice,
  listConfigs, getConfig, diffConfigs, backupDevice, restoreConfig, backupAll,
  listControllers, addController, testController, syncController, deleteController, deviceMetrics,
  getTopology,
  listAlerts, alertSummary, ackAlert, resolveAlert,
  listRules, createRule, updateRule, deleteRule,
  listChannels, createChannel, deleteChannel, testChannel,
  compliance, complianceDevice, listPolicies, createPolicy, updatePolicy, deletePolicy,
  pinBaseline, unpinBaseline, baselineDrift,
  metric, metricInterfaces, metricSummary,
  connectSSH,
};
