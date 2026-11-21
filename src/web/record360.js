/* ================================================================ RECORD 360 (v1.6)
   Open any record by GID and see everything around it. Only primary-key / indexed lookups run
   automatically, so it is safe on PROD; links over non-indexed columns are counted on request. */
const R360 = {stack: [], cur: null, seq: 0, links: [], showEmpty: false};
const IDX = new Map();   // profile -> {cols: Map(col -> Set(tables)), failed}
const DETECT_TABLES = ["SHIPMENT", "ORDER_RELEASE", "ORDER_BASE", "LOCATION", "INVOICE", "VOUCHER", "SERVPROV", "ITEM", "PACKAGED_ITEM",
  "SHIP_UNIT", "S_SHIP_UNIT", "ORDER_RELEASE_LINE", "ORDER_MOVEMENT", "SHIPMENT_GROUP", "RATE_OFFERING", "RATE_GEO", "CORPORATION",
  "CONTACT", "EQUIPMENT_GROUP", "DRIVER", "POWER_UNIT", "JOB", "CLAIM", "QUOTE", "TENDER_COLLABORATION", "BOOKING_LINE_AMENDMENT"];
const rq = async (sql, maxRows = 500) => { const r = await api("/api/query", {sql, maxRows}); if (r.error) throw new Error(r.error); return r; };
const rowsObj = r => r.rows.map(row => { const o = {}; r.columns.forEach((c, i) => o[c] = row[i]); return o; });
const shortGid = v => { const s = String(v ?? ""); const i = s.indexOf("."); return i > 0 && i < s.length - 1 ? s.slice(i + 1) : s; };
const oraShort = m => ((String(m).match(/ORA-\d{5}[^\n]*/) || [String(m).split("\n")[0]])[0]).slice(0, 160);

function tableFromCol(col) {
  if (!col || !/_GID$/.test(col)) return null;
  const parts = col.slice(0, -4).split("_");
  for (let i = 0; i < parts.length; i++) { const c = parts.slice(i).join("_"); if (TABLESET.has(c)) return c; }
  return null;
}
/* Which table does TABLE.COL point to?  Relationship data first, then OTM's naming rule. */
function gidTarget(table, col) {
  if (!col || !/_GID$/.test(col)) return null;
  if (table && col === table + "_GID") return table;
  let best = null;
  for (const i of ADJ.get(table) || []) {
    const e = SCHEMA.edges[i];
    if (e.c === table && e.cc.length === 1 && e.cc[0] === col && (!best || SRC_RANK[e.src] < SRC_RANK[best.src])) best = e;
  }
  return best ? best.p : tableFromCol(col);
}
function keyCol(t) {
  const k = SCHEMA.columns[t];
  if (!k || k.some(c => c[0] === t + "_GID")) return t + "_GID";
  return (k.find(c => /_GID$/.test(c[0])) || k[0])[0];
}
function nameCol(t) {
  const k = (SCHEMA.columns[t] || []).map(c => c[0]); if (!k.length) return null;
  for (const c of [t + "_NAME", t + "_DESC", t + "_DESCRIPTION", "DESCRIPTION", "NAME"]) if (k.includes(c)) return c;
  return k.find(c => /_(NAME|DESC|DESCRIPTION)$/.test(c) && c !== "DOMAIN_NAME") || null;
}
function myDomain() { const p = pById(CUR_PID); const u = (p && p.user) || ""; return u.includes(".") ? u.split(".")[0] : ""; }
const glink = (t, v, label) => `<a class="gl" data-t="${esc(t)}" data-v="${esc(v)}" title="Open ${esc(t)} ${esc(v)} in Record 360">${esc(label ?? v)}</a>`;

/* ---------- open / detect ---------- */
function r360Go(t, v) { showTab("r360"); $("#rVal").value = v; $("#rTable").value = t || ""; r360Open(t, v); }
async function r360Submit() {
  const v = $("#rVal").value.trim(); if (!v) return;
  const t = $("#rTable").value.trim().toUpperCase();
  if (t) return r360Open(t, v, $("#rKey").value || null);
  r360Detect(v);
}
async function r360Detect(v) {
  if (!CONNECTED) return msg("#rMsg", "Connect first (Connection tab).", "err");
  const tries = [v]; if (!v.includes(".") && myDomain()) tries.push(myDomain() + "." + v);
  const cands = DETECT_TABLES.filter(t => TABLESET.has(t));
  msg("#rMsg", `Looking for ${tries.join(" / ")} in ${cands.length} main OTM objects…`, "info");
  const found = [];
  const one = async t => { try { const r = await rq(`SELECT ${q(t)} AS T, ${keyCol(t)} AS V FROM ${t} WHERE ${keyCol(t)} IN (${tries.map(q).join(", ")})`, 5); rowsObj(r).forEach(o => found.push(o)); } catch (e) {} };
  try {
    const r = await rq(cands.map(t => `SELECT ${q(t)} AS T, ${keyCol(t)} AS V FROM ${t} WHERE ${keyCol(t)} IN (${tries.map(q).join(", ")})`).join("\nUNION ALL\n"), 50);
    rowsObj(r).forEach(o => found.push(o));
  } catch (e) {                                   // one table not readable → check them one by one
    let i = 0; await Promise.all([0, 1, 2, 3].map(async () => { while (i < cands.length) await one(cands[i++]); }));
  }
  if (found.length === 1) { msg("#rMsg", ""); $("#rTable").value = found[0].T; return r360Open(found[0].T, found[0].V); }
  if (!found.length) return msg("#rMsg", `Not found in ${cands.join(", ")}.\nPick the table (or check the domain prefix) and click Open.`, "err");
  $("#rMsg").innerHTML = `<div class="msg info">Found in ${found.length} tables — pick one: ${found.map(o => glink(o.T, o.V, o.T)).join(" · ")}</div>`;
}
async function r360Open(table, value, key, push = true) {
  if (!CONNECTED) return msg("#rMsg", "Connect first (Connection tab).", "err");
  table = String(table).toUpperCase().trim(); value = String(value).trim(); key = key || keyCol(table);
  const my = ++R360.seq;
  msg("#rMsg", `Loading ${table} ${value}…`, "info");
  let rec, used = value;
  try {
    rec = rowsObj(await rq(`SELECT * FROM ${table} WHERE ${key} = ${q(value)}`, 2))[0];
    if (!rec && !value.includes(".") && myDomain()) { used = myDomain() + "." + value; rec = rowsObj(await rq(`SELECT * FROM ${table} WHERE ${key} = ${q(used)}`, 2))[0]; }
  } catch (e) { if (my === R360.seq) msg("#rMsg", oraShort(e.message), "err"); return; }
  if (my !== R360.seq) return;
  if (!rec) return msg("#rMsg", `No ${table} with ${key} = ${value}${used !== value ? " (also tried " + used + ")" : ""}.`, "err");
  msg("#rMsg", "");
  $("#rVal").value = used; $("#rTable").value = table; r360KeyOptions();
  R360.cur = {table, key, value: used, rec, pid: CUR_PID};
  if (push) {
    const last = R360.stack[R360.stack.length - 1];
    if (!last || last.table !== table || last.value !== used) R360.stack.push({table, key, value: used});
    if (R360.stack.length > 15) R360.stack.shift();
  }
  renderCrumbs(); renderRecord();
  loadParentNames(my); loadRelated(my);
}
function renderCrumbs() {
  $("#rCrumbs").innerHTML = R360.stack.map((s, i) => i === R360.stack.length - 1
    ? `<span class="cur">${esc(s.table)} · ${esc(shortGid(s.value))}</span>`
    : `<a data-ci="${i}">${esc(s.table)} · ${esc(shortGid(s.value))}</a><span class="muted">›</span>`).join(" ");
}

/* ---------- the record ---------- */
function renderRecord() {
  const c = R360.cur; if (!c) return;
  const known = (SCHEMA.columns[c.table] || []).map(x => x[0]);
  const cols = [...new Set([...known, ...Object.keys(c.rec)])];
  const show = cols.filter(k => R360.showEmpty || (c.rec[k] != null && c.rec[k] !== ""));
  $("#rBody").innerHTML = `
  <div class="card">
    <div class="rhead"><span class="ttag">${esc(c.table)}</span><h2>${esc(c.value)}</h2><span class="envtag ${envCls((pById(c.pid) || {}).env)}">${esc(envLabel(pById(c.pid)))}</span><span class="sp"></span>
      <label class="inline small"><input type="checkbox" id="rEmpty"${R360.showEmpty ? " checked" : ""}> Show empty fields</label>
      <button class="btn small" id="rToRunner">Open in Query Runner</button><button class="btn small" id="rRefresh">Refresh</button></div>
    <div class="hl-row" id="rHl"></div>
    <div class="fields">${show.map(k => {
      const v = c.rec[k];
      if (v == null || v === "") return `<div class="fld"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="v null">—</span></div>`;
      const t = k !== c.key ? gidTarget(c.table, k) : null;
      const val = t && TABLESET.has(t) ? glink(t, v) + `<span class="gl-t">${esc(t)}</span><span class="gl-n" data-pn="${esc(k)}"></span>` : esc(v);
      return `<div class="fld"><span class="k" title="${esc(k)}">${esc(k)}</span><span class="v" title="${esc(v)}">${val}</span></div>`;
    }).join("")}</div>
  </div>
  <div class="card">
    <div class="rhead"><h2 style="font-family:inherit">Related records</h2><span class="small muted" id="rRelInfo"></span><span class="sp"></span><button class="btn small" id="rCountAll" style="display:none">Count the rest</button></div>
    <div id="rRel" style="margin-top:10px"><div class="muted small">Looking for related records…</div></div>
  </div>`;
  $("#rEmpty").onchange = e => { R360.showEmpty = e.target.checked; renderRecord(); renderRel(); loadParentNames(R360.seq); renderHighlights(); };
  $("#rRefresh").onclick = () => r360Open(c.table, c.value, c.key, false);
  $("#rToRunner").onclick = () => openSql(`SELECT t.*\nFROM ${c.table} t\nWHERE t.${c.key} = ${q(c.value)}`, `${c.table} ${shortGid(c.value)}`);
  $("#rCountAll").onclick = () => countLinks(R360.links.filter(l => l.n == null && !l.busy), R360.seq, true);
}
async function loadParentNames(my) {
  const c = R360.cur; if (!c) return;
  const want = [];
  for (const k of Object.keys(c.rec)) {
    if (k === c.key) continue;
    const t = gidTarget(c.table, k), nc = t && nameCol(t);
    if (nc && keyCol(t) === t + "_GID") want.push({k, t, nc, v: c.rec[k]});
  }
  if (!want.length) return;
  const sql = want.slice(0, 40).map((w, j) => `SELECT ${j} AS K, ${w.nc} AS N FROM ${w.t} WHERE ${w.t}_GID = ${q(w.v)}`).join("\nUNION ALL\n");
  try {
    const r = rowsObj(await rq(sql, 100));
    if (my !== R360.seq) return;
    r.forEach(o => { const w = want[+o.K]; const el = w && document.querySelector(`[data-pn="${CSS.escape(w.k)}"]`); if (el && o.N) el.textContent = o.N; });
  } catch (e) {}
}

/* ---------- related records ---------- */
function incomingLinks(table, rec) {
  const out = new Map();
  for (const i of ADJ.get(table) || []) {
    const e = SCHEMA.edges[i];
    if (e.p !== table || (e.c === table && e.cc.join() === e.pc.join())) continue;
    const vals = e.pc.map(c => rec[c]);
    if (vals.some(v => v == null || v === "")) continue;
    const k = e.c + "|" + e.cc.join(",");
    if (out.has(k)) { const o = out.get(k); if (SRC_RANK[e.src] < SRC_RANK[o.src]) o.src = e.src; continue; }
    out.set(k, {k, table: e.c, cols: e.cc, vals, src: e.src, cond: e.cc.map((c, j) => `${c} = ${q(vals[j])}`).join(" AND ")});
  }
  return [...out.values()];
}
async function indexInfo(cols) {
  if (!IDX.has(CUR_PID)) IDX.set(CUR_PID, {cols: new Map(), failed: false});
  const st = IDX.get(CUR_PID);
  const need = [...new Set(cols)].filter(c => !st.cols.has(c));
  const owner = ($("#owner").value || "").trim().toUpperCase();
  for (let i = 0; i < need.length && !st.failed; i += 200) {
    const chunk = need.slice(i, i + 200);
    try {
      const r = await rq(`SELECT table_name AS T, column_name AS C FROM all_ind_columns WHERE ${owner ? `table_owner = ${q(owner)} AND ` : ""}column_position = 1 AND column_name IN (${chunk.map(q).join(", ")})`, 200000);
      chunk.forEach(c => st.cols.set(c, new Set()));
      rowsObj(r).forEach(o => st.cols.has(o.C) && st.cols.get(o.C).add(o.T));
    } catch (e) { st.failed = true; }
  }
  return (t, c) => st.failed ? null : (st.cols.get(c) || new Set()).has(t);
}
async function loadRelated(my) {
  const c = R360.cur;
  const links = incomingLinks(c.table, c.rec);
  R360.links = links;
  if (!links.length) { $("#rRel").innerHTML = `<div class="muted small">No tables are known to point to ${esc(c.table)}. (Sync the schema to find more links.)</div>`; return; }
  const isIdx = await indexInfo(links.map(l => l.cols[0]));
  if (my !== R360.seq) return;
  for (const l of links) {
    const ix = isIdx(l.table, l.cols[0]);
    l.indexed = ix;
    l.auto = ix === true || l.src === "fk" || l.src === "builtin" || l.src === "import" || (ix === null && l.cols[0] === c.key);
  }
  renderRel();
  await countLinks(links.filter(l => l.auto), my, false);
  if (my !== R360.seq) return;
  renderHighlights();
}
async function countLinks(list, my, manual) {
  const B = 25, batches = [];
  for (let i = 0; i < list.length; i += B) batches.push(list.slice(i, i + B));
  list.forEach(l => l.busy = true); renderRel();
  const doOne = async l => { try { l.n = +(rowsObj(await rq(`SELECT COUNT(*) AS N FROM ${l.table} WHERE ${l.cond}`, 2))[0] || {N: 0}).N; } catch (e) { l.err = oraShort(e.message); } l.busy = false; };
  let bi = 0;
  const worker = async () => {
    while (bi < batches.length) {
      const b = batches[bi++];
      try {
        const r = await rq(b.map((l, j) => `SELECT ${j} AS K, COUNT(*) AS N FROM ${l.table} WHERE ${l.cond}`).join("\nUNION ALL\n"), 1000);
        b.forEach(l => { l.n = 0; l.busy = false; });
        rowsObj(r).forEach(o => { const l = b[+o.K]; if (l) l.n = +o.N; });
      } catch (e) { for (const l of b) await doOne(l); }   // isolate the table that failed
      if (my !== R360.seq) return;
      renderRel();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (my === R360.seq) { renderRel(); if (manual) renderHighlights(); }
}
function relKind(l) {
  if (l.cols[0] !== R360.cur.key) return null;
  if (/_STATUS$/.test(l.table)) return "st";
  if (/_REFNUM$/.test(l.table)) return "rf";
  if (/_REMARK$/.test(l.table)) return "rm";
  return null;
}
async function renderHighlights() {
  const c = R360.cur, my = R360.seq; if (!c || !$("#rHl")) return;
  const hl = R360.links.filter(l => l.n > 0 && relKind(l)).slice(0, 8);
  if (!hl.length) { $("#rHl").innerHTML = ""; return; }
  const chips = [];
  for (const l of hl) {
    if (!l.rows) { try { l.rows = rowsObj(await rq(`SELECT * FROM ${l.table} WHERE ${l.cond}`, 60)); } catch (e) { l.rows = []; } }
    if (my !== R360.seq) return;
    const kind = relKind(l);
    for (const o of l.rows) {
      const ks = Object.keys(o);
      if (kind === "st" && o.STATUS_TYPE_GID) chips.push(`<span class="hchip st" title="${esc(l.table)}"><b>${esc(shortGid(o.STATUS_TYPE_GID))}</b>${esc(shortGid(o.STATUS_VALUE_GID))}</span>`);
      if (kind === "rf") { const qc = ks.find(k => /REFNUM_QUAL_GID$/.test(k)), vc = ks.find(k => /REFNUM_VALUE$/.test(k)); if (qc && vc) chips.push(`<span class="hchip rf" title="${esc(l.table)}"><b>${esc(shortGid(o[qc]))}</b>${esc(o[vc])}</span>`); }
      if (kind === "rm") { const qc = ks.find(k => /REMARK_QUAL_GID$/.test(k)), vc = ks.find(k => /REMARK_TEXT$/.test(k)); if (vc) chips.push(`<span class="hchip rm" title="${esc(o[vc])}"><b>${esc(shortGid(o[qc] || "REMARK"))}</b>${esc(String(o[vc]).slice(0, 70))}</span>`); }
    }
  }
  $("#rHl").innerHTML = chips.join("");
}
function renderRel() {
  const c = R360.cur; if (!c || !$("#rRel")) return;
  const L = R360.links;
  const withRows = L.filter(l => l.n > 0).sort((a, b) => b.n - a.n || a.table.localeCompare(b.table));
  const empty = L.filter(l => l.n === 0);
  const pending = L.filter(l => l.n == null && l.busy);
  const manual = L.filter(l => l.n == null && !l.busy);
  const via = l => l.cols.length === 1 && l.cols[0] === c.key ? "" : `<span class="via">via ${esc(l.cols.join(", "))}</span>`;
  const row = l => `<div class="rel${l.open ? " open" : ""}" data-k="${esc(l.k)}"><div class="rh" data-act="toggle">
      <span class="cnt">${l.n.toLocaleString()}</span><span class="tn">${esc(l.table)}</span>${via(l)}<span class="sp"></span>
      <span class="small muted">${SRC_LABEL[l.src] || l.src}</span><span class="caret">${l.open ? "▾" : "▸"}</span></div>
      ${l.open ? `<div class="rb">${l.html || '<div class="muted small">Loading…</div>'}</div>` : ""}</div>`;
  $("#rRelInfo").textContent = `${withRows.length} with data · ${empty.length} empty` + (pending.length ? ` · counting ${pending.length}…` : "") + (manual.length ? ` · ${manual.length} not counted` : "");
  $("#rCountAll").style.display = manual.length ? "" : "none";
  $("#rCountAll").textContent = `Count the rest (${manual.length})`;
  $("#rRel").innerHTML =
    (withRows.length ? withRows.map(row).join("") : (pending.length ? "" : '<div class="muted small">No related records found.</div>'))
    + (manual.length ? `<details class="relgrp"><summary>Not counted automatically (${manual.length}) — the link column has no index, so counting could be slow on big tables</summary>
        ${manual.map(l => `<div class="relm" data-k="${esc(l.k)}"><span class="tn">${esc(l.table)}</span>${via(l)}<span class="sp"></span>${l.err ? `<span class="small" style="color:var(--accent)" title="${esc(l.err)}">error</span>` : ""}<button class="btn small" data-act="count">Count</button></div>`).join("")}</details>` : "")
    + (empty.length ? `<details class="relgrp"><summary>Empty (${empty.length})</summary><div class="small mono muted" style="padding:6px 10px;line-height:1.8">${empty.map(l => esc(l.table) + (l.cols[0] !== c.key ? ` <span style="opacity:.7">(${esc(l.cols.join(","))})</span>` : "")).join(" · ")}</div></details>` : "");
}
async function openRel(l) {
  l.open = !l.open; renderRel();
  if (!l.open || l.html) return;
  const my = R360.seq;
  try {
    const r = await rq(`SELECT * FROM ${l.table} WHERE ${l.cond}`, 50);
    if (my !== R360.seq) return;
    const own = l.table + "_GID";
    const cell = (col, v) => {
      if (v == null) return '<td class="null">null</td>';
      const t = col === own ? l.table : gidTarget(l.table, col);
      if (t && TABLESET.has(t) && !(t === R360.cur.table && v === R360.cur.value)) return `<td title="${esc(v)}">${glink(t, v)}</td>`;
      return `<td title="${esc(v)}">${esc(v)}</td>`;
    };
    l.html = `<div class="res-wrap" style="max-height:320px"><table class="res"><thead><tr><th>#</th>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>`
      + r.rows.map((row, i) => `<tr><td class="muted">${i + 1}</td>${row.map((v, j) => cell(r.columns[j], v)).join("")}</tr>`).join("") + `</tbody></table></div>`
      + `<div class="row" style="margin-top:6px;align-items:center"><span class="small muted">${l.n > r.rows.length ? `Showing ${r.rows.length} of ${l.n.toLocaleString()}.` : ""}</span><span class="sp" style="flex:1"></span><button class="btn small" data-act="runner">Open in Query Runner</button></div>`;
  } catch (e) { l.html = `<div class="msg err">${esc(oraShort(e.message))}</div>`; }
  renderRel();
}
function r360Shown() {
  R360_ENV();
  if (!R360.cur) setTimeout(() => $("#rVal").focus(), 0);
}
function R360_ENV() {
  const p = pById(CUR_PID); if (!p || !$("#rEnv")) return;
  $("#rEnv").className = "envtag " + envCls(p.env); $("#rEnv").textContent = envLabel(p);
  if (R360.cur && R360.cur.pid !== CUR_PID) msg("#rMsg", `This record was loaded from ${envLabel(pById(R360.cur.pid))}. Click Refresh to load it from ${envLabel(p)}.`, "info");
}
function r360KeyOptions() {        // only needed for tables without a TABLE_GID column
  const t = $("#rTable").value.trim().toUpperCase(), k = SCHEMA.columns[t];
  const sel = $("#rKey");
  if (!k || k.some(c => c[0] === t + "_GID")) { $("#rKeyLbl").style.display = "none"; sel.innerHTML = ""; return; }
  const def = keyCol(t);
  sel.innerHTML = k.map(c => `<option${c[0] === def ? " selected" : ""}>${esc(c[0])}</option>`).join("");
  $("#rKeyLbl").style.display = "";
}
const SRC_LABEL = {fk: "foreign key", builtin: "known OTM join", inferred: "matched by name", import: "imported"};

/* ---------- wiring ---------- */
$("#rOpen").onclick = r360Submit;
$("#rVal").addEventListener("keydown", e => { if (e.key === "Enter") r360Submit(); });
$("#rTable").addEventListener("keydown", e => { if (e.key === "Enter") r360Submit(); });
$("#rTable").addEventListener("input", r360KeyOptions);
$("#tab-r360").addEventListener("click", e => {
  const a = e.target.closest("a.gl");
  if (a) { e.preventDefault(); $("#rVal").value = a.dataset.v; $("#rTable").value = a.dataset.t; r360KeyOptions(); return r360Open(a.dataset.t, a.dataset.v); }
  const cr = e.target.closest("[data-ci]");
  if (cr) { const s = R360.stack[+cr.dataset.ci]; R360.stack = R360.stack.slice(0, +cr.dataset.ci + 1); return r360Open(s.table, s.value, s.key, false); }
  const act = e.target.closest("[data-act]"); if (!act) return;
  const box = act.closest("[data-k]"); const l = box && R360.links.find(x => x.k === box.dataset.k); if (!l) return;
  if (act.dataset.act === "toggle") openRel(l);
  if (act.dataset.act === "count") countLinks([l], R360.seq, true);
  if (act.dataset.act === "runner") openSql(`SELECT c.*\nFROM ${l.table} c\nWHERE ${l.cols.map((col, j) => `c.${col} = ${q(l.vals[j])}`).join("\n  AND ")}`, l.table);
});
/* GID cells in Query Runner results open Record 360 */
$("#resWrap").addEventListener("click", e => { const a = e.target.closest("a.go"); if (a) { e.preventDefault(); r360Go(a.dataset.t, a.dataset.v); } });
