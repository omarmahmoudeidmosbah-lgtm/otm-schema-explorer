/* ================================================================ SAVED QUERIES + PARAMETERS (v1.9)
   Saved queries live in otm_saved_queries.json next to the script (folders, favourites, search,
   export/import). Queries saved from the Designer keep the diagram. :name / &name placeholders are
   asked for when the query runs (DB.XML has no bind variables, so values are put into the SQL). */

/* ---------- parameters ---------- */
const PARAM_RE = /(^|[^\w:&$#])(:|&&?)([A-Za-z_][\w$#]*)/g;
function findParams(sql) {
  const m = maskSql(sql || ""), out = [];
  let x; PARAM_RE.lastIndex = 0;
  while ((x = PARAM_RE.exec(m))) {
    const start = x.index + x[1].length, end = start + x[2].length + x[3].length;
    out.push({name: x[3].toUpperCase(), raw: x[2] + x[3], start, end});
  }
  return out;
}
const paramNames = sql => [...new Set(findParams(sql).map(p => p.name))];
function paramLit(v) {
  v = String(v ?? "").trim();
  if (v.startsWith("=")) return v.slice(1).trim() || "NULL";           // =SYSDATE - 7  → raw SQL
  if (!v.length || v.toUpperCase() === "NULL") return "NULL";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return "'" + v.replace(/'/g, "''") + "'";
}
function subParams(sql, values) {         // values: {NAME: text}; null → NULL everywhere (for Check SQL)
  const ps = findParams(sql); if (!ps.length) return sql;
  const m = maskSql(sql); let out = sql;
  for (const p of ps.slice().reverse()) {
    const v = values ? values[p.name] : null;
    const inList = /\bIN\s*\(\s*$/i.test(m.slice(0, p.start)) && /^\s*\)/.test(m.slice(p.end));
    const lit = v == null ? "NULL" : inList && !String(v).trim().startsWith("=")
      ? String(v).split(/[,\n;]/).map(s => s.trim()).filter(Boolean).map(paramLit).join(", ") || "NULL" : paramLit(v);
    out = out.slice(0, p.start) + lit + out.slice(p.end);
  }
  return out;
}
let PARAM_MEM = {}; try { PARAM_MEM = JSON.parse(localStorage.getItem("paramValues") || "{}"); } catch (e) {}
function askParams(names, title) {
  return new Promise(resolve => {
    const box = $("#prmModal");
    box.innerHTML = `<div class="modal-box dlg" style="width:560px"><div class="modal-h"><h2 style="margin:0">Values for ${esc(title || "this query")}</h2><span class="sp"></span><span class="rb" data-pm="cancel" style="font-size:18px">✕</span></div>
      <div class="prm-grid">${names.map(n => `<label class="mono">:${esc(n.toLowerCase())}</label><input type="text" data-pn="${esc(n)}" value="${esc(PARAM_MEM[n] ?? "")}" spellcheck="false">`).join("")}</div>
      <div class="small muted" style="margin-top:10px">Text is put in quotes for you (<span class="mono">MYDOMAIN.SH001</span> → <span class="mono">'MYDOMAIN.SH001'</span>), numbers stay numbers, inside <span class="mono">IN ( :list )</span> separate values with commas. Start with <span class="mono">=</span> to insert raw SQL (<span class="mono">=SYSDATE - 7</span>). Dates: write <span class="mono">TO_DATE(:from_date, 'YYYY-MM-DD')</span> in the SQL.</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-pm="cancel">Cancel</button><button class="btn primary" data-pm="ok">Run</button></div></div>`;
    box.style.display = "flex";
    const ins = [...box.querySelectorAll("[data-pn]")];
    setTimeout(() => (ins.find(i => !i.value) || ins[0]).focus(), 0);
    const done = ok => {
      box.style.display = "none";
      if (!ok) return resolve(null);
      const v = {}; ins.forEach(i => { v[i.dataset.pn] = i.value; PARAM_MEM[i.dataset.pn] = i.value; });
      try { localStorage.setItem("paramValues", JSON.stringify(PARAM_MEM)); } catch (e) {}
      resolve(v);
    };
    box.querySelectorAll("[data-pm]").forEach(b => b.onclick = () => done(b.dataset.pm === "ok"));
    box.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(true); } if (e.key === "Escape") done(false); };
    box.onmousedown = e => { if (e.target === box) done(false); };
  });
}
/* Returns the SQL with values filled in, or null when the user cancels. */
async function resolveParams(sql, title) {
  const names = paramNames(sql);
  if (!names.length) return sql;
  const v = await askParams(names, title);
  return v ? subParams(sql, v) : null;
}

/* ---------- saved queries ---------- */
var SV = {items: [], loaded: false, error: "", writable: true, open: {}, view: "saved"};   // var + function: safe to use before this part has run
try { SV.open = JSON.parse(localStorage.getItem("svOpen") || "{}"); } catch (e) {}
function svById(id) { return SV && SV.items ? SV.items.find(x => x.id === id) : null; }
const svNewId = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function svLoad() {
  try {
    const r = await api("/api/saved");
    SV.items = r.items || []; SV.error = r.error || ""; SV.writable = r.writable !== false; SV.loaded = true;
  } catch (e) { SV.error = e.message; }
  svRender(); if (typeof qtRender === "function") qtRender();
}
async function svOp(body) {
  const r = await api("/api/saved", body);
  if (r.error) { toast(r.error); svMsg(r.error, "err"); return null; }
  SV.items = r.items; svRender(); qtRender(); return r;
}
function svMsg(t, k) { const el = $("#svMsg"); if (!el) return; el.innerHTML = t ? `<div class="msg ${k || "info"}" style="margin-top:6px">${esc(t)}</div>` : ""; if (t) setTimeout(() => { if (el.textContent.includes(t.slice(0, 20))) el.innerHTML = ""; }, 6000); }
function svFolders() { return [...new Set(SV.items.map(x => x.folder || "").filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function svRender() {
  const el = $("#svList"); if (!el) return;
  if (SV.error) { el.innerHTML = `<div class="msg err">${esc(SV.error)}</div>`; return; }
  const f = $("#svSearch").value.trim().toLowerCase();
  const match = x => !f || [x.name, x.folder, x.desc, x.sql].some(v => (v || "").toLowerCase().includes(f));
  const list = SV.items.filter(match).sort((a, b) => a.name.localeCompare(b.name));
  if (!SV.items.length) { el.innerHTML = `<div class="muted small" style="padding:6px 2px">No saved queries yet. Write a query and press <b>Ctrl+S</b> (or ☆ Save). Use <span class="mono">:name</span> placeholders to be asked for values when it runs.</div>`; return; }
  if (!list.length) { el.innerHTML = '<div class="muted small" style="padding:6px 2px">Nothing matches.</div>'; return; }
  const row = x => {
    const ps = paramNames(x.sql);
    return `<div class="svi" data-sv="${esc(x.id)}" title="${esc((x.desc ? x.desc + "\n\n" : "") + x.sql.slice(0, 600))}">
      <span class="svstar${x.fav ? " on" : ""}" data-act="fav" title="${x.fav ? "Remove from favourites" : "Add to favourites"}">${x.fav ? "★" : "☆"}</span>
      <span class="svn">${esc(x.name)}${x.design ? '<span class="svd" title="Saved with its Designer diagram">◫</span>' : ""}${ps.length ? `<span class="svp">${ps.map(p => ":" + esc(p.toLowerCase())).join(" ")}</span>` : ""}</span>
      <span class="svact"><span data-act="runner" title="Open in Query Runner">▶</span><span data-act="designer" title="Open in Query Designer">◫</span><span data-act="edit" title="Rename / move / describe">✎</span><span data-act="dup" title="Duplicate">⧉</span><span data-act="del" title="Delete">🗑</span></span></div>`;
  };
  const favs = list.filter(x => x.fav);
  const groups = new Map();
  for (const x of list) { const g = x.folder || ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  const order = [...groups.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  el.innerHTML = (favs.length && !f ? `<div class="svg"><div class="svgh fav">★ Favourites</div>${favs.map(row).join("")}</div>` : "")
    + order.map(g => { const open = f || SV.open[g] !== false; return `<div class="svg"><div class="svgh" data-fold="${esc(g)}">${open ? "▾" : "▸"} ${esc(g || "No folder")} <span class="muted">${groups.get(g).length}</span></div>${open ? groups.get(g).map(row).join("") : ""}</div>`; }).join("");
}
/* open */
function svOpenRunner(x) {
  const t = openSql(x.sql, x.name);
  if (t) { t.savedId = x.id; t.title = x.name; qtRender(); qtStore(); }
}
function svOpenDesigner(x) {
  if (DESIGN.tables.length && !(DESIGN.savedId === x.id) && !confirm(`Open "${x.name}" in the Query Designer? The current diagram will be replaced.`)) return;
  showTab("design");
  if (x.design) { DESIGN = JSON.parse(JSON.stringify(x.design)); dNorm(); DESIGN.savedId = x.id; DS.dirty = false; DS.note = ""; render(); renderSteps(); dSave(); }
  else {
    DESIGN = dNewDesign(); DESIGN.savedId = x.id; render(); renderSteps();
    DS.lastGen = ""; dsqlSet(x.sql); DS.dirty = true; dsqlApply();       // build the diagram from the SQL
  }
  dmsg(`Opened "${x.name}".`, "ok");
}
function svOpen(x) { if (x.design) svOpenDesigner(x); else svOpenRunner(x); }
/* save dialog */
function svDialog(opts) {   // {sql, design, id?, name?, folder?, desc?, fav?, source}
  const box = $("#svModal"), existing = opts.id ? svById(opts.id) : null;
  const ps = paramNames(opts.sql);
  box.innerHTML = `<div class="modal-box dlg" style="width:600px"><div class="modal-h"><h2 style="margin:0">${existing ? "Save query" : "Save as a new query"}</h2><span class="sp"></span><span class="rb" data-sd="cancel" style="font-size:18px">✕</span></div>
    <div class="row"><label style="flex:1">Name<input type="text" id="sdName" value="${esc(opts.name || (existing && existing.name) || "")}" placeholder="e.g. Shipment cost by carrier"></label>
      <label style="width:200px">Folder<input type="text" id="sdFolder" list="sdFolders" value="${esc(opts.folder ?? (existing ? existing.folder : SV.lastFolder || ""))}" placeholder="e.g. Shipments"></label></div>
    <datalist id="sdFolders">${svFolders().map(f => `<option value="${esc(f)}">`).join("")}</datalist>
    <label style="margin-top:10px">Description (optional)<textarea id="sdDesc" rows="2" style="font-family:inherit">${esc(opts.desc ?? (existing ? existing.desc || "" : ""))}</textarea></label>
    <label class="inline" style="margin-top:8px"><input type="checkbox" id="sdFav" ${(existing ? existing.fav : opts.fav) ? "checked" : ""}> ★ Favourite</label>
    <div class="small muted" style="margin-top:8px">${opts.design ? "The Designer diagram is saved too — opening it brings the boxes, joins and steps back. " : ""}${ps.length ? `Parameters: ${ps.map(p => `<span class="mono">:${esc(p.toLowerCase())}</span>`).join(", ")} — you'll be asked for values when it runs.` : `Tip: use <span class="mono">:name</span> placeholders (e.g. <span class="mono">WHERE s.shipment_gid = :shipment_gid</span>) to be asked for values when it runs.`}</div>
    <details style="margin-top:8px"><summary class="small">SQL</summary><pre class="sql" style="max-height:200px;margin-top:6px">${esc(opts.sql)}</pre></details>
    <div id="sdMsg"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-sd="cancel">Cancel</button>${existing ? '<button class="btn" data-sd="new">Save as new</button>' : ""}<button class="btn primary" data-sd="save">${existing ? "Save" : "Save query"}</button></div></div>`;
  box.style.display = "flex";
  setTimeout(() => { const n = $("#sdName"); n.focus(); n.select(); }, 0);
  return new Promise(resolve => {
    const done = async mode => {
      if (mode === "cancel") { box.style.display = "none"; return resolve(null); }
      const name = $("#sdName").value.trim();
      if (!name) { $("#sdMsg").innerHTML = '<div class="msg err">Give the query a name.</div>'; return; }
      const now = new Date().toISOString();
      const asNew = mode === "new" || !existing;
      const item = {...(asNew ? {} : existing), id: asNew ? svNewId() : existing.id, name, folder: $("#sdFolder").value.trim(), desc: $("#sdDesc").value.trim(),
                    fav: $("#sdFav").checked, sql: opts.sql, design: opts.design || null, created: asNew ? now : existing.created || now, updated: now};
      if (asNew && SV.items.some(x => x.name.toLowerCase() === name.toLowerCase() && (x.folder || "") === item.folder) && !confirm(`There is already a query called "${name}" in this folder. Save another one with the same name?`)) return;
      SV.lastFolder = item.folder;
      const r = await svOp({op: "upsert", item});
      if (!r) { $("#sdMsg").innerHTML = `<div class="msg err">${esc(SV.error || "Could not save.")}</div>`; return; }
      box.style.display = "none"; resolve(item);
    };
    box.querySelectorAll("[data-sd]").forEach(b => b.onclick = () => done(b.dataset.sd));
    box.onkeydown = e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); done(existing ? "save" : "save"); } if (e.key === "Escape") done("cancel"); };
    box.onmousedown = e => { if (e.target === box) done("cancel"); };
  });
}
/* Ctrl+S in the Query Runner: update the linked saved query, or ask for a name. */
async function svSaveTab(forceDialog) {
  const t = qtCur(); if (!t) return;
  const sql = t.doc.getValue().trim();
  if (!sql || sql === ED_SAMPLE.trim()) return toast("Nothing to save — write a query first.");
  const linked = t.savedId && svById(t.savedId);
  if (linked && !forceDialog) {
    const changed = normSql(linked.sql) !== normSql(sql);
    const item = {...linked, sql, updated: new Date().toISOString()};
    if (changed && linked.design) item.design = null;       // the SQL changed here, so the diagram is rebuilt from it next time
    if (await svOp({op: "upsert", item})) toast(`Saved "${linked.name}"`);
    return;
  }
  const it = await svDialog({sql, id: linked ? linked.id : null, name: linked ? linked.name : t.title.match(/^Query \d+$/) ? "" : t.title});
  if (it) { t.savedId = it.id; t.title = it.name; qtRender(); qtStore(); toast(`Saved "${it.name}"`); }
}
async function svSaveDesigner() {
  dsqlApplyIfDirty();
  const sql = dCurrentSql();
  if (!sql || !sql.trim()) return dmsg("Nothing to save — add tables first.", "err");
  const design = DESIGN.customSql != null ? null : JSON.parse(JSON.stringify(DESIGN));
  if (design) delete design.savedId;
  const linked = DESIGN.savedId && svById(DESIGN.savedId);
  const it = await svDialog({sql, design, id: linked ? linked.id : null});
  if (it) { DESIGN.savedId = it.id; dSave(); dmsg(`Saved "${it.name}" with its diagram.`, "ok"); }
}
/* tab title marker: • when a linked tab differs from its saved version */
function svTabState(t) {
  if (!SV || !SV.loaded) return t.savedId ? "saved" : "";
  const x = t.savedId && svById(t.savedId);
  if (!x) return "";
  return normSql(x.sql) === normSql(t.doc.getValue()) ? "saved" : "modified";
}
/* export / import */
function svExport() {
  const data = JSON.stringify({format: "otm-explorer-saved-queries", version: 1, exported: new Date().toISOString(), items: SV.items}, null, 1);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], {type: "application/json"}));
  a.download = "otm_saved_queries_" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
}
async function svImport(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { return svMsg("That file isn't valid JSON.", "err"); }
  let items = Array.isArray(d) ? d : d && Array.isArray(d.items) ? d.items : null;
  if (!items) {        // a plain .sql file → one query
    return svMsg("Pick a file exported from the Saved list (otm_saved_queries_….json).", "err");
  }
  const r = await svOp({op: "import", items});
  if (r) svMsg(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} skipped (already up to date or invalid).`, "ok");
}

/* ---------- wiring ---------- */
(function initSaved() {
  const side = $("#sqSide");
  side.addEventListener("click", async e => {
    const tb = e.target.closest("[data-sq]");
    if (tb) { SV.view = tb.dataset.sq; side.querySelectorAll("[data-sq]").forEach(b => b.classList.toggle("on", b === tb)); $("#sqSaved").style.display = SV.view === "saved" ? "" : "none"; $("#sqHist").style.display = SV.view === "hist" ? "" : "none"; return; }
    const fold = e.target.closest("[data-fold]");
    if (fold) { const g = fold.dataset.fold; SV.open[g] = SV.open[g] === false; try { localStorage.setItem("svOpen", JSON.stringify(SV.open)); } catch (er) {} return svRender(); }
    const row = e.target.closest("[data-sv]"); if (!row) return;
    const x = svById(row.dataset.sv); if (!x) return;
    const act = e.target.closest("[data-act]") ? e.target.closest("[data-act]").dataset.act : "open";
    if (act === "open") svOpen(x);
    if (act === "runner") svOpenRunner(x);
    if (act === "designer") svOpenDesigner(x);
    if (act === "fav") svOp({op: "upsert", item: {...x, fav: !x.fav}});
    if (act === "edit") { const it = await svDialog({sql: x.sql, design: x.design, id: x.id}); if (it) QT.tabs.filter(t => t.savedId === it.id).forEach(t => t.title = it.name), qtRender(), qtStore(); }
    if (act === "dup") { const now = new Date().toISOString(); svOp({op: "upsert", item: {...x, id: svNewId(), name: x.name + " (copy)", fav: false, created: now, updated: now}}); }
    if (act === "del" && confirm(`Delete the saved query "${x.name}"?`)) { await svOp({op: "delete", id: x.id}); QT.tabs.filter(t => t.savedId === x.id).forEach(t => delete t.savedId); qtRender(); qtStore(); }
  });
  $("#svSearch").oninput = svRender;
  $("#svSaveCur").onclick = () => svSaveTab(false);
  $("#svExport").onclick = e => { e.preventDefault(); svExport(); };
  $("#svImport").onclick = e => { e.preventDefault(); $("#svFile").click(); };
  $("#svFile").onchange = e => { const f = e.target.files[0]; if (f) svImport(f); e.target.value = ""; };
  $("#dSave").onclick = svSaveDesigner;
  if (ED) {
    ED.setOption("extraKeys", Object.assign({}, ED.getOption("extraKeys"), {"Ctrl-S": () => svSaveTab(false), "Cmd-S": () => svSaveTab(false), "Shift-Ctrl-S": () => svSaveTab(true), "Shift-Cmd-S": () => svSaveTab(true)}));
    let tm = null; ED.on("changes", () => { clearTimeout(tm); tm = setTimeout(qtRender, 250); });
  }
  document.addEventListener("keydown", e => {       // Ctrl+S anywhere on the Query Runner page
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && $("#tab-query").classList.contains("active") && !e.target.closest(".modal")) { e.preventDefault(); svSaveTab(e.shiftKey); }
  });
  // save from history
  $("#history").addEventListener("click", e => {
    const s = e.target.closest("[data-hsave]"); if (!s) return;
    e.stopPropagation(); svDialog({sql: HISTORY[+s.dataset.hsave]});
  }, true);
  svLoad();
})();
