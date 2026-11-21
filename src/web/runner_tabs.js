/* ================================================================ QUERY TABS (v1.7)
   Each editor tab has its own SQL document (with its own undo history) and its own results.
   "Run all" runs every statement in the tab and gives each result its own result tab. */
const QT = {tabs: [], active: null, seq: 1};
const qtCur = () => QT.tabs.find(t => t.id === QT.active) || null;
let qtSaveT = null;
function qtStore() {
  clearTimeout(qtSaveT);
  qtSaveT = setTimeout(() => {
    try { localStorage.setItem("runnerTabs", JSON.stringify({tabs: QT.tabs.map(t => ({title: t.title, sql: t.doc.getValue(), savedId: t.savedId || null})), active: QT.tabs.findIndex(t => t.id === QT.active)})); } catch (e) {}
  }, 300);
}
function qtNew(sql, title, activate = true) {
  const id = QT.seq++;
  const t = {id, title: title || `Query ${id}`, doc: CodeMirror.Doc(sql || "", "text/x-otmsql"), results: [], ri: 0, running: false, unseen: false};
  QT.tabs.push(t);
  if (activate) qtActivate(id); else qtRender();
  qtStore();
  return t;
}
function qtActivate(id) {
  if (!pFindTab(id)) return;
  clearMarks();
  QT.active = id;
  const t = qtCur(); t.unseen = false;
  ED.swapDoc(t.doc);
  qtRender(); showResult(t); setRunButtons(t);
  if (t.running) $("#runInfo").textContent = "Running…";
  setTimeout(() => { ED.refresh(); ED.focus(); edStatus(); }, 0);
  qtStore();
}
const pFindTab = id => QT.tabs.some(t => t.id === id);
function qtClose(id) {
  const t = QT.tabs.find(x => x.id === id); if (!t) return;
  if (t.running) return toast("This tab is still running a query.");
  const st = typeof svTabState === "function" ? svTabState(t) : "";
  if (st === "modified" ? !confirm(`"${t.title}" has changes that aren't saved. Close it anyway?`)
      : st !== "saved" && t.doc.getValue().trim() && t.doc.getValue().trim() !== ED_SAMPLE.trim() && !confirm(`Close "${t.title}"? Its SQL will be removed (it isn't saved — press Ctrl+S first to keep it).`)) return;
  const i = QT.tabs.indexOf(t);
  QT.tabs.splice(i, 1);
  if (!QT.tabs.length) return qtNew("", "Query 1");
  if (QT.active === id) qtActivate(QT.tabs[Math.max(0, i - 1)].id); else { qtRender(); qtStore(); }
}
function qtRender() {
  $("#qTabs").innerHTML = QT.tabs.map(t => `<div class="qtab${t.id === QT.active ? " on" : ""}" data-q="${t.id}" title="${esc(t.title)} — double-click to rename">
      ${t.savedId && typeof svTabState === "function" && svTabState(t) ? `<span class="qt-sv" title="Saved query">★</span>` : ""}<span class="qt-t">${esc(t.title)}</span>${typeof svTabState === "function" && svTabState(t) === "modified" ? '<span class="qt-mod" title="Changed since it was saved — Ctrl+S to save">•</span>' : ""}${t.running ? '<span class="qt-spin" title="Running"></span>' : t.unseen ? '<span class="qt-dot" title="New results"></span>' : ""}
      <span class="qt-x" data-x="${t.id}" title="Close tab">×</span></div>`).join("")
    + `<button class="qtab-add" id="qtAdd" title="New query tab">+</button>`;
}
/* Put SQL in the runner: reuse the current tab if it is empty, otherwise open a new tab. */
function openSql(sql, title) {
  const t = qtCur();
  const cur = t ? t.doc.getValue().trim() : "x";
  if (t && !t.running && (!cur || cur === ED_SAMPLE.trim())) {
    t.doc.setValue(sql); t.doc.clearHistory(); t.results = []; t.ri = 0;
    if (title) t.title = title;
    delete t.savedId;
    qtActivate(t.id);
    showTab("query"); return t;
  }
  const n = qtNew(sql, title);
  showTab("query"); return n;
}

/* ---------- results ---------- */
function firstTable(sql) {
  const m = maskSql(sql).match(/\bFROM\s+(?:[A-Za-z_][\w$#]*\.)?([A-Za-z_][\w$#]*)/i);
  return m ? m[1].toUpperCase() : null;
}
function splitStatements(text) {
  const m = maskSql(text), out = []; let a = 0;
  for (let i = 0; i <= m.length; i++) if (i === m.length || m[i] === ";") {
    let s = a, e = i;
    while (s < e && /\s/.test(m[s])) s++;
    while (e > s && /\s/.test(m[e - 1])) e--;
    if (m.slice(s, e).trim()) out.push({start: s, end: e, text: text.slice(s, e)});
    a = i + 1;
  }
  return out;
}
async function execOne(sql, signal, orig) {
  const res = {sql, orig: orig || sql, title: firstTable(sql) || "Result", env: envLabel()};
  const t0 = performance.now();
  try {
    const r = await api("/api/query", {sql, maxRows: +$("#maxRows").value || 500}, signal);
    res.clientMs = Math.round(performance.now() - t0);
    if (r.error) res.error = r.error;
    else {
      Object.assign(res, r);
      res.info = `${r.rows.length.toLocaleString()} row(s)${r.truncated ? " (limit reached)" : ""} · ${fmtS(res.clientMs)} · ${res.env}`;
      const h0 = orig || sql;
      HISTORY = [h0, ...HISTORY.filter(h => h !== h0)].slice(0, 30);
      try { localStorage.setItem("history", JSON.stringify(HISTORY)); } catch (e) {}
      renderHistory();
    }
  } catch (e) {
    res.error = e.name === "AbortError" ? "Stopped — the tool stopped waiting for this query. OTM may keep running it for a while in the background." : e.message;
  }
  return res;
}
function setRunButtons(t) {
  if (!t || t.id !== QT.active) return;
  $("#btnRun").innerHTML = t.running ? '■ Stop<span class="kbd">stop waiting</span>' : '▶ Run<span class="kbd">Ctrl+Enter</span>';
  $("#btnRun").classList.toggle("stop", !!t.running);
  $("#btnRunAll").disabled = !!t.running;
  $("#btnRun").disabled = false;
}
function stopQuery() { const t = qtCur(); if (t && t.running && t.abort) t.abort.abort(); }
function renderResultTabs(t) {
  const el = $("#resTabs");
  if (!t || t.results.length < 2) { el.innerHTML = ""; el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = t.results.map((r, i) => `<span class="rtab${i === t.ri ? " on" : ""}${r.error ? " err" : ""}" data-ri="${i}" title="${esc(r.sql)}">${i + 1} · ${esc(r.title)} <small>${r.error ? "error" : r.rows.length.toLocaleString() + " rows"}</small></span>`).join("");
}
function showResult(t) {
  renderResultTabs(t);
  const r = t && t.results[t.ri];
  LAST = r && !r.error ? r : null;
  $("#btnExport").disabled = !(LAST && LAST.rows.length);
  if (!r) { msg("#qMsg", ""); $("#resWrap").innerHTML = '<div class="muted" style="padding:14px">Results appear here.</div>'; return; }
  if (r.error) {
    showOracleError(r.error, null);
    $("#resWrap").innerHTML = '<div class="muted" style="padding:14px">This statement failed — see the message above.</div>';
    $("#runInfo").textContent = "";
  } else {
    msg("#qMsg", "");
    const t0 = performance.now(); renderResults();
    const done = () => { if (r.renderMs == null) r.renderMs = Math.round(performance.now() - t0); if (t.id === QT.active && t.results[t.ri] === r) $("#runInfo").innerHTML = timingHtml(r); };
    requestAnimationFrame(() => setTimeout(done, 0));
    $("#runInfo").innerHTML = timingHtml(r);
  }
}
async function runQuery() {
  const t = qtCur(); if (!t) return;
  if (t.running) return;
  const orig = sqlForAction(true); if (!orig) return;
  const rng = actionRange();
  clearMarks();
  if (!CONNECTED) return msg("#qMsg", "Not connected — go to the Connection tab.", "err");
  const sql = await resolveParams(orig, t.title); if (sql == null) return;
  t.running = true; t.abort = new AbortController(); qtRender(); msg("#qMsg", ""); setRunButtons(t);
  const started = Date.now();
  const tick = setInterval(() => { if (t.id === QT.active && t.running) $("#runInfo").textContent = `Running… ${Math.round((Date.now() - started) / 1000)} s (waiting for OTM)`; }, 1000);
  $("#runInfo").textContent = "Running…";
  const res = await execOne(sql, t.abort.signal, orig);
  clearInterval(tick);
  t.running = false; t.abort = null; t.results = [res]; t.ri = 0;
  if (t.id === QT.active) {
    setRunButtons(t);
    showResult(t);
    if (res.error && /ORA-\d{5}/.test(res.error)) showOracleError(res.error, rng);   // underline in the editor
  } else t.unseen = true;
  qtRender();
}
async function runAll() {
  const t = qtCur(); if (!t || t.running) return;
  const stmts = splitStatements(t.doc.getValue());
  if (!stmts.length) return;
  if (!CONNECTED) return msg("#qMsg", "Not connected — go to the Connection tab.", "err");
  clearMarks();
  const names = paramNames(stmts.map(s => s.text).join("\n"));
  let vals = {};
  if (names.length) { vals = await askParams(names, t.title); if (!vals) return; }
  t.running = true; t.abort = new AbortController(); t.results = []; t.ri = 0; qtRender(); msg("#qMsg", ""); setRunButtons(t);
  for (let i = 0; i < stmts.length; i++) {
    if (t.abort.signal.aborted) break;
    if (t.id === QT.active) $("#runInfo").textContent = `Running ${i + 1} of ${stmts.length}…`;
    t.results.push(await execOne(names.length ? subParams(stmts[i].text, vals) : stmts[i].text, t.abort.signal, stmts[i].text));
    if (t.id === QT.active) { renderResultTabs(t); if (i === 0) showResult(t); }
  }
  t.running = false; t.abort = null;
  const firstErr = t.results.findIndex(r => r.error);
  if (t.id === QT.active) {
    setRunButtons(t);
    showResult(t);
    if (firstErr >= 0) toast(`Statement ${firstErr + 1} failed — see its result tab.`);
  } else t.unseen = true;
  qtRender();
}

/* ---------- wiring ---------- */
(function initTabs() {
  if (!ED) return;
  let saved = null; try { saved = JSON.parse(localStorage.getItem("runnerTabs")); } catch (e) {}
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
    const made = saved.tabs.map(s => { const t = qtNew(s.sql, s.title, false); if (s.savedId) t.savedId = s.savedId; return t; });
    qtActivate((made[saved.active] || made[0]).id);
  } else qtNew(ED.getValue(), "Query 1");       // first run: the current editor text becomes tab 1
  ED.on("change", qtStore);
  ED.setOption("extraKeys", Object.assign({}, ED.getOption("extraKeys"), {"Ctrl-Alt-Enter": () => runAll(), "Cmd-Alt-Enter": () => runAll()}));
  const bar = $("#qTabs");
  bar.addEventListener("click", e => {
    if (e.target.closest("#qtAdd")) return qtNew("");
    const x = e.target.closest("[data-x]"); if (x) { e.stopPropagation(); return qtClose(+x.dataset.x); }
    const tab = e.target.closest("[data-q]"); if (tab && +tab.dataset.q !== QT.active) qtActivate(+tab.dataset.q);
  });
  bar.addEventListener("auxclick", e => { const tab = e.target.closest("[data-q]"); if (e.button === 1 && tab) { e.preventDefault(); qtClose(+tab.dataset.q); } });
  bar.addEventListener("dblclick", e => {
    const tab = e.target.closest("[data-q]"); if (!tab) return;
    const t = QT.tabs.find(x => x.id === +tab.dataset.q); const span = tab.querySelector(".qt-t");
    const inp = document.createElement("input"); inp.value = t.title; inp.className = "qt-in"; span.replaceWith(inp); inp.select();
    const done = ok => { if (ok && inp.value.trim()) t.title = inp.value.trim().slice(0, 40); qtRender(); qtStore(); };
    inp.onkeydown = ev => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") done(false); };
    inp.onblur = () => done(true);
  });
  $("#resTabs").addEventListener("click", e => { const r = e.target.closest("[data-ri]"); if (!r) return; const t = qtCur(); t.ri = +r.dataset.ri; showResult(t); });
  $("#btnRunAll").onclick = runAll;
  $("#btnRun").onclick = () => { const t = qtCur(); if (t && t.running) stopQuery(); else runQuery(); };
})();
