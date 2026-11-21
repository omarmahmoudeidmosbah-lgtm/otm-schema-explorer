/* ================================================================ ENVIRONMENTS (v1.6)
   Saved connection profiles (no passwords). The helper keeps one live session per profile in memory,
   and every OTM request carries the profile id, so a query always goes to the environment shown. */
var CUR_PID = null;
let PROFILES = [], LIVE = new Set(), FORM_PID = null;
const DEF_SERVLET = "/GC3/glog.integration.servlet.DBXMLServlet?command=xmlExport";
const pById = id => PROFILES.find(p => p.id === id);
const envCls = env => ({DEV: "dev", TEST: "test", UAT: "test", PROD: "prod"}[env] || "other");
function pStore() { try { localStorage.setItem("profiles", JSON.stringify(PROFILES)); localStorage.setItem("activeProfile", CUR_PID || ""); } catch (e) {} }
function guessEnv(url) {
  const u = (url || "").toLowerCase();
  return /prod|prd/.test(u) ? "PROD" : /uat/.test(u) ? "UAT" : /test|tst|qa\b|stg|stage/.test(u) ? "TEST" : /dev/.test(u) ? "DEV" : "OTHER";
}
function hostName(url) { try { return new URL(url).hostname.split(".")[0]; } catch (e) { return "My OTM"; } }
function loadProfiles(st) {
  try { PROFILES = JSON.parse(localStorage.getItem("profiles") || "[]"); } catch (e) { PROFILES = []; }
  if (!Array.isArray(PROFILES) || !PROFILES.length) {           // first run: migrate the single v1.5 connection
    let c = {}; try { c = JSON.parse(localStorage.getItem("conn") || "{}"); } catch (e) {}
    const url = c.url || (st && st.envUrl) || "", user = c.user || (st && st.envUser) || "";
    PROFILES = [{id: "default", name: url ? hostName(url) : "My OTM", env: guessEnv(url), url, user, servlet: c.servlet || DEF_SERVLET, insecure: false}];
  }
  CUR_PID = localStorage.getItem("activeProfile") || PROFILES[0].id;
  if (!pById(CUR_PID)) CUR_PID = PROFILES[0].id;
  LIVE = new Set((st && st.sessions) || []);
  pStore();
}
function envLabel(p) { p = p || pById(CUR_PID); return p ? `${p.env} · ${p.name}` : ""; }
function setConnected() {                       // kept for older code paths: state now comes from LIVE + CUR_PID
  CONNECTED = LIVE.has(CUR_PID);
  renderEnv();
}
function renderEnv() {
  const p = pById(CUR_PID);
  CONNECTED = !!p && LIVE.has(CUR_PID);
  const cls = p ? envCls(p.env) : "other";
  document.querySelector("header").className = "env-" + cls;
  $("#envDot").className = "envdot" + (CONNECTED ? " on" : "");
  $("#connBadge").innerHTML = p ? `<span class="envtag ${cls}">${esc(p.env)}</span> ${esc(p.name)}${p.user ? ` · ${esc(p.user)}` : ""}${CONNECTED ? "" : ' <span style="opacity:.6">(not connected)</span>'}` : "Not connected";
  $("#runEnv").className = "envtag " + cls; $("#runEnv").textContent = p ? p.env + " · " + p.name : "";
  $("#edWrap").classList.toggle("prod", !!p && p.env === "PROD");
  if (window.R360_ENV) R360_ENV();
  renderPList();
}
function renderPList() {
  $("#pList").innerHTML = PROFILES.map(p => `<div class="pitem${p.id === FORM_PID ? " sel" : ""}" data-p="${esc(p.id)}">
      <span class="envtag ${envCls(p.env)}">${esc(p.env)}</span>
      <span class="pn"><b>${esc(p.name)}</b><span class="small muted">${esc(p.user || "")}${p.url ? " · " + esc(hostName(p.url)) : ""}</span></span>
      <span class="pst">${p.id === CUR_PID ? '<span class="pill">in use</span>' : ""}${LIVE.has(p.id) ? '<span class="envdot on" title="connected"></span>' : ""}</span></div>`).join("");
  $("#pList").querySelectorAll("[data-p]").forEach(d => d.onclick = () => pFill(d.dataset.p));
}
function pFill(id) {
  const p = pById(id); if (!p) return;
  FORM_PID = id;
  $("#pName").value = p.name || ""; $("#pEnv").value = p.env || "OTHER";
  $("#cUrl").value = p.url || ""; $("#cUser").value = p.user || ""; $("#cPass").value = "";
  $("#cServlet").value = p.servlet || DEF_SERVLET; $("#cInsecure").checked = !!p.insecure;
  $("#pTitle").textContent = p.name ? `${p.name}` : "Connect to OTM";
  $("#pUse").style.display = LIVE.has(id) && id !== CUR_PID ? "" : "none";
  $("#cPass").placeholder = LIVE.has(id) ? "(connected — kept in memory)" : "";
  msg("#cMsg", "");
  renderPList();
}
function pFromForm() {
  const p = pById(FORM_PID); if (!p) return null;
  const url = $("#cUrl").value.trim();
  Object.assign(p, {name: $("#pName").value.trim() || hostName(url), env: $("#pEnv").value, url, user: $("#cUser").value.trim(),
                    servlet: $("#cServlet").value.trim() || DEF_SERVLET, insecure: $("#cInsecure").checked});
  pStore(); return p;
}
function useProfile(id, quiet) {
  if (!pById(id)) return;
  CUR_PID = id; pStore(); renderEnv();
  if (typeof COL_TRIED !== "undefined") COL_TRIED.clear();
  if (!LIVE.has(id)) {
    pFill(id); showTab("connect"); $("#cPass").focus();
    msg("#cMsg", `Enter the password for ${pById(id).name} to connect.`, "info");
  } else if (!quiet) toast(`Now using ${envLabel()}`);
}
function toast(t) {
  let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = t; el.className = "show " + envCls((pById(CUR_PID) || {}).env);
  clearTimeout(el._t); el._t = setTimeout(() => el.className = "", 2200);
}
$("#btnConnect").onclick = async () => {
  const p = pFromForm(); if (!p) return;
  if (!p.url || !p.user) return msg("#cMsg", "Enter the URL and user.", "err");
  const body = {profile: p.id, url: p.url, user: p.user, password: $("#cPass").value, servlet: p.servlet, insecure: p.insecure};
  if (!body.password) body.useEnvPass = true;
  msg("#cMsg", "Testing connection…", "info"); $("#btnConnect").disabled = true;
  try {
    const r = await api("/api/connect", body);
    if (r.error) { LIVE.delete(p.id); renderEnv(); msg("#cMsg", r.error, "err"); return; }
    LIVE = new Set(r.sessions || [...LIVE, p.id]);
    CUR_PID = p.id; pStore(); renderEnv(); pFill(p.id);
    const t = r.test.rows[0] || [];
    msg("#cMsg", `Connected to ${p.name} (${p.env}). DB.XML servlet answered${t[1] ? " (database user " + t[1] + ")" : ""}.` +
      (SCHEMA.meta.source === "Built-in starter pack" ? "\nNext: Schema Data → Sync now, to load your instance's real relationships." : ""), "ok");
  } finally { $("#btnConnect").disabled = false; }
};
$("#btnDisconnect").onclick = async () => {
  const id = FORM_PID || CUR_PID;
  const r = await api("/api/disconnect", {profile: id});
  LIVE = new Set(r.sessions || []); renderEnv(); pFill(id);
  msg("#cMsg", "Disconnected — password cleared from the helper.", "info");
};
$("#pUse").onclick = () => useProfile(FORM_PID);
$("#pSave").onclick = () => { pFromForm(); renderEnv(); pFill(FORM_PID); msg("#cMsg", "Saved.", "ok"); };
$("#pNew").onclick = () => {
  const id = "p" + Date.now().toString(36);
  const cur = pById(CUR_PID) || {};
  PROFILES.push({id, name: "New environment", env: "DEV", url: "", user: cur.user || "", servlet: DEF_SERVLET, insecure: false});
  pStore(); pFill(id); $("#pName").select();
};
$("#pDel").onclick = async () => {
  const p = pById(FORM_PID); if (!p) return;
  if (PROFILES.length === 1) return msg("#cMsg", "This is the only environment — edit it instead.", "err");
  if (!confirm(`Delete the environment "${p.name}"?`)) return;
  if (LIVE.has(p.id)) { const r = await api("/api/disconnect", {profile: p.id}); LIVE = new Set(r.sessions || []); }
  PROFILES = PROFILES.filter(x => x.id !== p.id);
  if (CUR_PID === p.id) CUR_PID = PROFILES[0].id;
  pStore(); renderEnv(); pFill(CUR_PID);
};
$("#pEnv").onchange = () => { pFromForm(); renderEnv(); };
$("#pName").oninput = () => { $("#pTitle").textContent = $("#pName").value || "Connect to OTM"; };
$("#pName").onchange = () => { pFromForm(); renderEnv(); };

/* header menu */
$("#envBtn").onclick = e => {
  e.stopPropagation();
  const m = $("#envMenu");
  if (m.style.display !== "none") { m.style.display = "none"; return; }
  m.innerHTML = PROFILES.map(p => `<div class="emi${p.id === CUR_PID ? " cur" : ""}" data-p="${esc(p.id)}"><span class="envtag ${envCls(p.env)}">${esc(p.env)}</span><span class="pn"><b>${esc(p.name)}</b><span class="small">${esc(p.user || "")}</span></span><span class="small ${LIVE.has(p.id) ? "on" : "off"}">${LIVE.has(p.id) ? "● connected" : "○ needs password"}</span></div>`).join("")
    + `<div class="emi manage" data-manage="1">Manage environments…</div>`;
  m.style.display = "block";
  m.querySelectorAll("[data-p]").forEach(d => d.onclick = () => { m.style.display = "none"; useProfile(d.dataset.p); });
  m.querySelector("[data-manage]").onclick = () => { m.style.display = "none"; pFill(CUR_PID); showTab("connect"); };
};
document.addEventListener("click", e => { if (!e.target.closest("#envSw")) $("#envMenu").style.display = "none"; });
