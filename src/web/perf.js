/* ================================================================ SPEED (v1.8)
   1. A results grid that only draws the rows on screen (drawing thousands of rows was the slowest part
      of the tool itself), with a fast, debounced filter.
   2. A timing breakdown for every run: waiting for OTM · transfer · this tool.
   3. Diagnose: explains why a query is slow (table sizes, indexes, SQL patterns, optional timing tests). */

/* ---------- virtual results grid ---------- */
function vgrid(wrap, data, opts = {}) {
  const cols = data.columns || [], all = data.rows || [];
  if (!cols.length) { wrap.innerHTML = '<div class="muted" style="padding:14px">No rows returned.</div>'; wrap.onscroll = null; return null; }
  const gt = opts.gidLinks === false ? cols.map(() => null) : cols.map(c => typeof tableFromCol === "function" ? tableFromCol(c) : null);
  const widths = cols.map((c, j) => {
    let m = c.length;
    for (let i = 0; i < Math.min(all.length, 400); i++) { const v = all[i][j]; if (v != null) { const L = String(v).length; if (L > m) m = L; } }
    return Math.round(Math.min(420, Math.max(64, m * 7.3 + 24 + (gt[j] ? 14 : 0))));
  });
  const numW = Math.max(44, String(all.length).length * 8 + 22);
  wrap.innerHTML = `<table class="res vg" style="width:${numW + widths.reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:${numW}px">${widths.map(w => `<col style="width:${w}px">`).join("")}</colgroup>
    <thead><tr><th>#</th>${cols.map(c => `<th title="${esc(c)}">${esc(c)}</th>`).join("")}</tr></thead><tbody></tbody></table>`;
  const tb = wrap.querySelector("tbody");
  const st = {view: null, rowH: 27, s: -1, e: -1};
  const cell = (v, j) => v == null ? '<td class="null">null</td>'
    : `<td title="${esc(v)}">${esc(v)}${gt[j] ? `<a class="go" data-t="${esc(gt[j])}" data-v="${esc(v)}" title="Open ${esc(gt[j])} in Record 360">↗</a>` : ""}</td>`;
  const n = () => st.view ? st.view.length : all.length;
  const rowAt = i => st.view ? all[st.view[i]] : all[i];
  const span = h => h > 0 ? `<tr class="vsp" style="height:${h}px"><td colspan="${cols.length + 1}"></td></tr>` : "";
  function draw(force) {
    const top = wrap.scrollTop, h = wrap.clientHeight || 500, N = n();
    const s = Math.max(0, Math.floor(top / st.rowH) - 25), e = Math.min(N, Math.ceil((top + h) / st.rowH) + 25);
    if (!force && s === st.s && e === st.e) return;
    st.s = s; st.e = e;
    let html = span(s * st.rowH);
    for (let i = s; i < e; i++) html += `<tr><td class="muted">${i + 1}</td>${rowAt(i).map(cell).join("")}</tr>`;
    tb.innerHTML = html + span((N - e) * st.rowH);
    if (!st.measured) { const r = tb.querySelector("tr:not(.vsp)"); if (r && r.offsetHeight) { st.measured = true; if (Math.abs(r.offsetHeight - st.rowH) > 0.5) { st.rowH = r.offsetHeight; draw(true); } } }
  }
  let raf = 0;
  wrap.onscroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(false); }); };
  wrap.scrollTop = 0; draw(true);
  return {
    count: () => n(),
    filter(text) {
      const f = (text || "").trim().toLowerCase();
      if (!f) st.view = null;
      else {
        if (!data._low) data._low = all.map(r => r.map(v => v == null ? "" : String(v).toLowerCase()).join("\u0001"));
        st.view = []; for (let i = 0; i < all.length; i++) if (data._low[i].includes(f)) st.view.push(i);
      }
      wrap.scrollTop = 0; draw(true);
      return n();
    }
  };
}
let RES_GRID = null, filterT = null;
function renderResults() {
  if (!LAST) return;
  RES_GRID = vgrid($("#resWrap"), LAST);
  const f = $("#resFilter").value;
  if (RES_GRID && f.trim()) RES_GRID.filter(f);
}
$("#resFilter").oninput = () => {
  clearTimeout(filterT);
  filterT = setTimeout(() => {
    if (!RES_GRID) return;
    const k = RES_GRID.filter($("#resFilter").value);
    const t = qtCur(), r = t && t.results[t.ri];
    if (r && !r.error) $("#runInfo").innerHTML = ($("#resFilter").value.trim() ? `<b>${k.toLocaleString()}</b> of ` : "") + timingHtml(r);
  }, 150);
};

/* ---------- timing ---------- */
const fmtS = ms => ms == null ? "?" : ms < 1000 ? (ms / 1000).toFixed(2) + " s" : ms < 10000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms / 1000) + " s";
const fmtMB = b => b == null ? "" : b < 1e6 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(1) + " MB";
function timingParts(r) {
  const tm = r.timing || {};
  const total = (r.clientMs || r.elapsedMs || 0) + (r.renderMs || 0);
  const otm = tm.otmMs, recv = tm.recvMs;
  const tool = otm != null ? Math.max(0, total - otm - (recv || 0)) : null;
  return {total, otm, recv, tool, bytes: tm.bytes};
}
function timingHtml(r) {
  const p = timingParts(r);
  const rows = `${r.rows.length.toLocaleString()} row(s)${r.truncated ? " (Max rows reached)" : ""}`;
  if (p.otm == null) return `${rows} · ${fmtS(p.total)} · ${esc(r.env || "")}`;
  const big = p.bytes > 8 * 1048576 ? ` · <span class="warnc" title="OTM refuses DB.XML replies over 10 MB">⚠ ${fmtMB(p.bytes)}, close to OTM's 10 MB limit</span>` : "";
  const slow = p.total > 5000 ? ` · <a href="#" data-diag="1">Why slow?</a>` : "";
  return `${rows} · <b>${fmtS(p.total)}</b> <span class="tbrk" title="Waiting for OTM = the database running the query + OTM building the XML.\nTransfer = receiving the reply.\nTool = reading and showing the rows on your computer.">— OTM ${fmtS(p.otm)} · transfer ${fmtS(p.recv)} (${fmtMB(p.bytes)}) · tool ${fmtS(p.tool)}</span> · ${esc(r.env || "")}${big}${slow}`;
}

/* ---------- Diagnose ---------- */
const DIAG = {seq: 0};
function diagClose() { $("#diagPanel").style.display = "none"; $("#diagPanel").innerHTML = ""; }
function analyseSql(sql) {
  const out = {tables: [], joins: [], filters: [], conds: [], fields: [], distinct: false, patterns: [], parsed: false};
  let m = null;
  try { const r = parseSelect(sql, []); if (!r.error) m = r.model; } catch (e) {}
  const masked = maskSql(sql);
  if (m) {
    out.parsed = true;
    out.tables = m.tables.map((t, i) => ({i, alias: t.alias, name: t.kind === "derived" ? null : t.name, kind: t.kind}));
    out.joins = m.joins; out.fields = m.fields; out.conds = m.conds; out.distinct = m.distinct;
    for (const f of m.fields) if (f.filter && f.item != null && f.expr == null) out.filters.push({item: f.item, col: f.col, text: f.filter});
  } else {
    const sc = parseScope(masked, 0);
    out.tables = [...sc.aliases.values()].map((e, i) => ({i, alias: e.alias, name: e.kind === "table" && !sc.ctes.has(e.table) ? e.table : null, kind: e.kind}));
  }
  const P = (sev, text) => out.patterns.push({sev, text});
  // conditions as text (filters on expressions, other conditions, extra ON conditions)
  const condTexts = [...out.conds.map(c => c.sql), ...out.joins.map(j => j.extra).filter(Boolean),
                     ...out.fields.filter(f => f.filter && f.expr != null).map(f => f.expr + " " + f.filter)];
  const aliasCol = new Map(out.tables.map(t => [t.alias.toUpperCase(), t]));
  // columns compared inside conditions (for the index check)
  for (const c of condTexts) {
    const T = sqlTokens(maskSql(c), 0);
    for (let k = 0; k + 2 < T.length; k++) if (T[k].id && T[k + 1].u === "." && T[k + 2].id && aliasCol.has(T[k].u)) out.filters.push({item: aliasCol.get(T[k].u).i, col: T[k + 2].u, text: c, inCond: true});
  }
  const fnRe = /\b(UPPER|LOWER|TRUNC|TO_CHAR|TO_NUMBER|NVL|COALESCE|SUBSTR|TRIM|LTRIM|RTRIM|CAST|DECODE|REPLACE)\s*\(\s*([A-Za-z_][\w$#]*)\s*\.\s*([A-Za-z_][\w$#]*)/gi;
  const seenFn = new Set();
  for (const c of condTexts) {
    let x; fnRe.lastIndex = 0;
    while ((x = fnRe.exec(maskSql(c)))) {
      const key = (x[1] + x[2] + x[3]).toUpperCase(); if (seenFn.has(key)) continue; seenFn.add(key);
      P("warn", `<b>${esc(x[1].toUpperCase())}(${esc(x[2])}.${esc(x[3].toUpperCase())})</b> in a condition: Oracle can't use an index on ${esc(x[3].toUpperCase())} when the column is wrapped in a function. ` +
        (/TRUNC|TO_CHAR/i.test(x[1]) ? `For dates, compare a range instead: <span class="mono">${esc(x[2])}.${esc(x[3].toUpperCase())} &gt;= DATE '2026-11-01' AND ${esc(x[2])}.${esc(x[3].toUpperCase())} &lt; DATE '2026-11-02'</span>.` : "Compare the column itself where you can."));
    }
  }
  const allCond = [...condTexts, ...out.fields.filter(f => f.filter).map(f => f.filter)].join("\n");
  if (/LIKE\s+'%/i.test(allCond)) P("warn", "<b>LIKE '%…'</b> (starts with a wildcard) can't use an index — the whole table is scanned. Use a prefix (<span class=\"mono\">LIKE 'ABC%'</span>) if you can.");
  if (/NOT\s+IN\s*\(\s*SELECT/i.test(maskSql(allCond))) P("warn", "<b>NOT IN (SELECT …)</b> is often slow and returns nothing if the subquery has a NULL. <span class=\"mono\">NOT EXISTS (SELECT 1 … WHERE …)</span> is usually faster.");
  if (out.conds.some(c => hasTopOr(c.sql) && sqlTokens(maskSql(c.sql), 0).filter(t => t.u === ".").length > 1)) P("info", "An <b>OR</b> between different columns can stop Oracle from using indexes. If it is slow, try two queries joined with UNION ALL.");
  if (out.fields.some(f => f.expr != null && f.output && /\(\s*SELECT\b/i.test(maskSql(f.expr)))) P("warn", "A <b>subquery in the SELECT list</b> runs once for every row returned — with thousands of rows that adds up. A JOIN (or a derived table) is usually much faster.");
  if (out.parsed && out.tables.length > 1) {      // tables with no join between them
    const g = new Map(out.tables.map(t => [t.i, new Set([t.i])]));
    for (const j of out.joins) { const A = g.get(j.a), B = g.get(j.b); if (A !== B) { for (const x of B) { A.add(x); g.set(x, A); } } }
    const groups = new Set(g.values());
    if (groups.size > 1) {
      const gs = [...groups].map(s => [...s].map(i => out.tables[i].alias));
      P("err", `<b>Missing join:</b> ${gs.slice(1).map(g => g.join(", ")).join(" and ")} ${gs.slice(1).flat().length > 1 ? "are" : "is"} not joined to ${gs[0].join(", ")} — every row is combined with every row (a cartesian product), which multiplies the work.`);
    }
  }
  const heavyOps = [];
  if (out.distinct) heavyOps.push("DISTINCT");
  if (out.fields.some(f => f.agg)) heavyOps.push("GROUP BY / aggregates");
  if (out.fields.some(f => f.sort)) heavyOps.push("ORDER BY");
  if (/\bOVER\s*\(/i.test(masked)) heavyOps.push("window functions");
  if (/\b(UNION|MINUS|INTERSECT)\b/i.test(masked)) heavyOps.push("UNION / MINUS");
  if (heavyOps.length) P("info", `Uses <b>${heavyOps.join(", ")}</b> — Oracle has to process all matching rows before it can return the first one, so <i>Max rows</i> doesn't make it faster.`);
  const views = out.tables.filter(t => t.name && /^(VIEW_|V_)|_V$|_VIEW$/.test(t.name));
  if (views.length) P("info", `<b>${views.map(t => esc(t.name)).join(", ")}</b> ${views.length > 1 ? "are views" : "is a view"} — a view can hide several joins, and OTM's domain filter is added to every table inside it.`);
  const realT = out.tables.filter(t => t.name).length;
  if (realT >= 5) P("info", `${realT} tables — OTM adds its domain security (VPD) filter to <i>each</i> of them, so every extra table costs more than in SQL Developer.`);
  return out;
}
async function diagSizes(names) {
  const owner = ($("#owner").value || "").trim().toUpperCase(), out = new Map();
  if (!names.length) return out;
  try {
    const r = await api("/api/query", {sql: `SELECT table_name AS T, num_rows AS N, TO_CHAR(last_analyzed, 'YYYY-MM-DD') AS D FROM all_tables WHERE ${owner ? `owner = ${q(owner)} AND ` : ""}table_name IN (${names.map(q).join(", ")})`, maxRows: 2000});
    if (!r.error) r.rows.forEach(row => out.set(row[r.columns.indexOf("T")], {n: row[r.columns.indexOf("N")] == null ? null : +row[r.columns.indexOf("N")], d: row[r.columns.indexOf("D")]}));
    else out.error = r.error;
  } catch (e) { out.error = e.message; }
  return out;
}
const fmtRows = n => n == null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
async function diagnose() {
  const t = qtCur(); if (!t) return;
  const sql0 = sqlForAction(false); if (!sql0) return;
  if (!CONNECTED) return msg("#qMsg", "Connect first (Connection tab).", "err");
  const sql = await resolveParams(sql0, t.title); if (sql == null) return;
  const my = ++DIAG.seq, panel = $("#diagPanel");
  panel.style.display = "block";
  panel.innerHTML = `<div class="diag-h"><b>🩺 Why is this query slow?</b><span class="sp"></span><span class="rb" data-dg="close">✕</span></div><div class="muted small">Analysing the SQL and reading table sizes and indexes…</div>`;
  const A = analyseSql(sql);
  const names = [...new Set(A.tables.filter(x => x.name).map(x => x.name))];
  const sizes = await diagSizes(names);
  const colsToCheck = [...new Set([...A.filters.map(f => f.col), ...A.joins.flatMap(j => j.pairs.flat())].filter(Boolean))];
  const isIdx = colsToCheck.length && typeof indexInfo === "function" ? await indexInfo(colsToCheck) : () => null;
  if (my !== DIAG.seq) return;
  const last = t.results.find(r => !r.error && normSql(r.sql) === normSql(sql));
  DIAG.ctx = {sql, A, sizes, isIdx, last, env: envLabel()};
  diagRender();
}
function tableChecks(A, sizes, isIdx) {
  const rows = [];
  for (const tb of A.tables) {
    if (!tb.name) { rows.push({alias: tb.alias, name: "(subquery)", size: null, notes: ["derived table — its own query runs first"]}); continue; }
    const sz = sizes.get(tb.name), notes = [], issues = [];
    const fl = A.filters.filter(f => f.item === tb.i);
    const flCols = [...new Set(fl.map(f => f.col))];
    const jc = [...new Set(A.joins.flatMap(j => j.a === tb.i ? j.pairs.map(p => p[0]) : j.b === tb.i ? j.pairs.map(p => p[1]) : []))];
    const mark = c => { const x = isIdx(tb.name, c); return x === true ? `${esc(c)} <span class="okc">indexed ✓</span>` : x === false ? `${esc(c)} <span class="badc">no index ✗</span>` : esc(c); };
    const fCols = [...new Set(fl.filter(f => !f.inCond).map(f => f.col))], cCols = [...new Set(fl.filter(f => f.inCond).map(f => f.col))].filter(c => !fCols.includes(c));
    if (fCols.length) notes.push("filtered on " + fCols.map(mark).join(", "));
    if (cCols.length) notes.push("in a condition: " + cCols.map(mark).join(", "));
    if (jc.length) notes.push("joined on " + jc.map(mark).join(", "));
    const big = sz && sz.n != null && sz.n > 300000;
    const idxFilter = flCols.some(c => isIdx(tb.name, c) === true), idxJoin = jc.some(c => isIdx(tb.name, c) === true);
    if (big && !flCols.length && !idxJoin) issues.push(`no filter, and its join column${jc.length > 1 ? "s aren't" : " isn't"} indexed → Oracle likely reads all ${fmtRows(sz.n)} rows`);
    else if (big && flCols.length && !idxFilter && !idxJoin && flCols.every(c => isIdx(tb.name, c) === false)) issues.push(`filter columns have no index → likely a full scan of ${fmtRows(sz.n)} rows`);
    rows.push({alias: tb.alias, name: tb.name, size: sz, notes, issues});
  }
  return rows;
}
function diagRender() {
  const c = DIAG.ctx, panel = $("#diagPanel"); if (!c) return;
  const {A, sizes, isIdx, last, measure} = c;
  const tchk = tableChecks(A, sizes, isIdx);
  const lines = [];
  // 1. where did the time go (last full run)
  if (last) {
    const p = timingParts(last), share = x => p.total ? Math.round(100 * x / p.total) : 0;
    const where = p.otm == null ? "" : p.total < 1500 ? `This run was fast (${fmtS(p.total)}) — nothing to fix in this one.` : share(p.otm) >= 60 ? `<b>${share(p.otm)}% of the time was inside OTM</b> (database + building the reply) — the query itself is the slow part.`
      : share(p.recv) >= 40 ? `<b>${share(p.recv)}% of the time was the transfer</b> of ${fmtMB(p.bytes)} — the reply is big: select fewer columns or rows.`
      : share(p.tool) >= 40 ? `<b>${share(p.tool)}% of the time was this tool</b> showing the rows — lower Max rows.` : "The time is spread between OTM, the transfer and this tool.";
    lines.push(`<div class="diag-sec"><h4>Last run of this query</h4><div class="tbar">${p.otm != null ? `<span style="flex:${p.otm || 1}" class="b-otm" title="OTM">OTM ${fmtS(p.otm)}</span><span style="flex:${p.recv || 1}" class="b-net" title="Transfer">transfer ${fmtS(p.recv)}</span><span style="flex:${p.tool || 1}" class="b-tool" title="This tool">tool ${fmtS(p.tool)}</span>` : ""}</div>
      <div class="small">${last.rows.length.toLocaleString()} rows · ${fmtMB(p.bytes)} · total ${fmtS(p.total)} · ${esc(last.env || "")}. ${where}</div>
      ${p.bytes && last.rows.length ? `<div class="small muted">Each row is about ${fmtMB(p.bytes / last.rows.length)} of XML, so OTM's 10 MB reply limit is reached at about ${Math.floor(10 * 1048576 / (p.bytes / last.rows.length)).toLocaleString()} rows.</div>` : ""}</div>`);
  } else lines.push(`<div class="diag-sec small muted">Run the query once (▶ Run) to see how its time splits between OTM, the transfer and this tool.</div>`);
  // 2. measurements
  if (measure) lines.push(`<div class="diag-sec"><h4>Timing tests</h4>${measure.html}</div>`);
  else lines.push(`<div class="diag-sec"><h4>Timing tests</h4><div class="small">Runs your query twice more: once for the <b>first row only</b> and once to <b>count all rows</b> (no data sent back). Comparing them shows whether Oracle is slow to start or simply has a lot to read. On PROD, mind that this repeats the work.</div>
    <button class="btn small" data-dg="measure" style="margin-top:6px">Run timing tests</button></div>`);
  // 3. tables
  lines.push(`<div class="diag-sec"><h4>Tables in the query</h4>${sizes.error ? `<div class="small muted">Couldn't read table sizes: ${esc(oraShort(sizes.error))}</div>` : ""}
    <table class="dtab"><tr><th>Table</th><th>Rows (Oracle statistics)</th><th>Filters / joins</th></tr>${tchk.map(r => `<tr class="${r.issues && r.issues.length ? "bad" : ""}"><td class="mono">${esc(r.name)} <span class="muted">${esc(r.alias)}</span></td>
      <td>${r.size ? fmtRows(r.size.n) + (r.size.d ? ` <span class="muted small">(${esc(r.size.d)})</span>` : "") : r.name === "(subquery)" ? "—" : '<span class="muted">view / unknown</span>'}</td>
      <td class="small">${r.notes.join(" · ") || '<span class="muted">no filter, no join</span>'}${(r.issues || []).map(i => `<div class="badc">⚠ ${i}</div>`).join("")}</td></tr>`).join("")}</table></div>`);
  // 4. patterns
  const P = A.patterns;
  lines.push(`<div class="diag-sec"><h4>Things in the SQL that cost time</h4>${P.length ? P.map(p => `<div class="dp ${p.sev}">${p.sev === "err" ? "✗" : p.sev === "warn" ? "⚠" : "ℹ"} ${p.text}</div>`).join("") : '<div class="small muted">Nothing obvious — see the table checks above.</div>'}</div>`);
  // 5. OTM specifics
  lines.push(`<div class="diag-sec"><h4>OTM itself</h4><div class="small">• OTM adds its <b>domain security (VPD) filter to every table</b> in the query for normal users — Oracle's own docs say this can hurt performance. The same SQL often runs faster in SQL Developer, or as DBA.ADMIN, which doesn't get those filters. Fewer tables = fewer filters.<br>
    • DB.XML replies are capped at <b>10 MB</b> — wide <span class="mono">SELECT *</span> on OTM tables (some have 200+ columns) reaches it quickly.<br>
    • The helper waits up to 5 minutes for OTM, then stops waiting (OTM may still finish the query in the background).</div></div>`);
  $("#diagPanel").innerHTML = `<div class="diag-h"><b>🩺 Why is this query slow?</b><span class="small muted">${esc(c.env)}</span><span class="sp"></span><span class="rb" data-dg="close" title="Close">✕</span></div>` + lines.join("");
}
async function diagMeasure() {
  const c = DIAG.ctx; if (!c) return;
  const my = DIAG.seq;
  c.measure = {html: '<div class="small muted">Running: first row…</div>'}; diagRender();
  const tag = "otmx_" + Date.now().toString(36);
  const run = async (sql, n) => { const r = await api("/api/query", {sql, maxRows: n}); return r; };
  const first = await run(`/* ${tag} */\n${c.sql}`, 1);
  if (my !== DIAG.seq) return;
  c.measure.html = '<div class="small muted">Running: count all rows…</div>'; diagRender();
  const cnt = await run(`SELECT COUNT(*) AS N FROM (\n${c.sql}\n)`, 1);
  if (my !== DIAG.seq) return;
  // execution plan — only works if this OTM user may read V$SQL (often not allowed on OTM Cloud)
  let plan = null, planErr = null;
  try {
    const id = await run(`SELECT sql_id AS ID, child_number AS CN FROM v$sql WHERE sql_text LIKE '%${tag}%' AND sql_text NOT LIKE '%v$sql%' ORDER BY last_active_time DESC`, 1);
    if (id.error) planErr = id.error;
    else if (id.rows.length) {
      const p = await run(`SELECT plan_table_output AS L FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(${q(id.rows[0][0])}, ${+id.rows[0][1] || 0}, 'TYPICAL'))`, 500);
      if (p.error) planErr = p.error; else plan = p.rows.map(r => r[0] == null ? "" : r[0]).join("\n");
    } else planErr = "statement not found in V$SQL";
  } catch (e) { planErr = e.message; }
  if (my !== DIAG.seq) return;
  const fOtm = first.error ? null : (first.timing || {}).otmMs, cOtm = cnt.error ? null : (cnt.timing || {}).otmMs;
  const N = cnt.error || !cnt.rows.length ? null : +cnt.rows[0][0];
  const fullOtm = c.last && c.last.timing ? c.last.timing.otmMs : null;
  const v = [];
  if (first.error) v.push(`<div class="dp err">✗ The query failed: ${esc(oraShort(first.error))}</div>`);
  else if (cOtm != null) {
    if (fOtm < 2000 && cOtm > 3 * Math.max(fOtm, 500)) v.push(`<div class="dp info">ℹ Oracle finds the first row quickly (${fmtS(fOtm)}) but needs ${fmtS(cOtm)} to go through all ${N != null ? N.toLocaleString() : ""} rows → the query matches <b>a lot of data</b>. Add filters (dates, domain, status) or fewer rows.</div>`);
    else if (fOtm >= 2000 && cOtm >= 0.6 * fOtm) v.push(`<div class="dp warn">⚠ Even the first row takes ${fmtS(fOtm)} → Oracle must do most of the work before returning anything: a <b>full scan of a big table</b>, a sort/group/DISTINCT over many rows, or an expensive join. Check the table list below for tables without an indexed filter or join.</div>`);
    else v.push(`<div class="dp info">ℹ First row ${fmtS(fOtm)}, all rows counted in ${fmtS(cOtm)}.</div>`);
    if (fullOtm != null && cOtm != null && fullOtm > 2 * cOtm + 1500) v.push(`<div class="dp warn">⚠ Counting all rows takes ${fmtS(cOtm)}, but the full run spent ${fmtS(fullOtm)} inside OTM → most of that is <b>building and sending the XML</b> for the columns you selected. Select only the columns you need (avoid <span class="mono">SELECT *</span> on wide OTM tables).</div>`);
  }
  c.measure.html = `<table class="dtab"><tr><th>Test</th><th>Time inside OTM</th><th>Result</th></tr>
      <tr><td>First row only</td><td>${first.error ? "—" : fmtS(fOtm)}</td><td>${first.error ? `<span class="badc">${esc(oraShort(first.error))}</span>` : first.rows.length ? "1 row" : "no rows"}</td></tr>
      <tr><td>Count all rows</td><td>${cnt.error ? "—" : fmtS(cOtm)}</td><td>${cnt.error ? `<span class="badc">${esc(oraShort(cnt.error))}</span>` : (N != null ? N.toLocaleString() + " rows" : "")}</td></tr>
      ${fullOtm != null ? `<tr><td>Your last full run</td><td>${fmtS(fullOtm)}</td><td>${c.last.rows.length.toLocaleString()} rows returned</td></tr>` : ""}</table>${v.join("")}
    <details style="margin-top:6px"${plan ? " open" : ""}><summary class="small">Execution plan</summary>${plan ? `<pre class="sql" style="max-height:320px;font-size:11.5px">${esc(plan)}</pre>`
      : `<div class="small muted">Not available: ${esc(oraShort(planErr || ""))}. Reading plans needs access to V$SQL, which OTM Cloud users normally don't have — Oracle Support or your DBA can get it for a given query.</div>`}</details>`;
  diagRender();
}
$("#btnDiag").onclick = diagnose;
document.addEventListener("click", e => {
  const d = e.target.closest("[data-diag]"); if (d) { e.preventDefault(); return diagnose(); }
  const b = e.target.closest("[data-dg]"); if (!b) return;
  if (b.dataset.dg === "close") diagClose();
  if (b.dataset.dg === "measure") { b.disabled = true; diagMeasure(); }
});
