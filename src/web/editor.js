/* ================================================================ SQL EDITOR (v1.5)
   CodeMirror 5 + schema-aware autocomplete + formatter + Check SQL (WHERE 1=0). */
(function defineOtmSqlMode() {
  const base = CodeMirror.mimeModes["text/x-plsql"];
  const set = str => { const o = {}; str.split(" ").forEach(w => o[w] = true); return o; };
  CodeMirror.defineMIME("text/x-otmsql", Object.assign({}, base, {
    keywords: Object.assign({}, base.keywords, set("join inner left right full outer cross natural over partition preceding following unbounded first last nulls within keep fetch offset only ties pivot unpivot lateral interval respect ignore current")),
    builtin: Object.assign({}, base.builtin, set("coalesce nvl2 nullif listagg row_number rank dense_rank percent_rank cume_dist lag lead first_value last_value nth_value ntile ratio_to_report regexp_like regexp_substr regexp_replace regexp_instr regexp_count extract to_timestamp to_timestamp_tz systimestamp current_date current_timestamp from_tz sys_extract_utc numtodsinterval numtoyminterval median timestamp"))
  }));
})();

/* ---------- lightweight SQL reading (comments/strings masked, positions kept) ---------- */
function maskSql(s) {
  return s.replace(/\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|'(?:[^']|'')*(?:'|$)/g, m => {
    const blank = m.replace(/[^\n]/g, " ");
    if (m[0] !== "'") return blank;
    if (m.length < 2) return m;
    const closed = m.endsWith("'");
    return "'" + blank.slice(1, closed ? -1 : undefined) + (closed ? "'" : "");
  });
}
const SQLKW = new Set(("SELECT FROM WHERE AND OR NOT IN IS NULL JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING GROUP BY ORDER " +
  "HAVING UNION ALL MINUS INTERSECT EXCEPT WITH AS CASE WHEN THEN ELSE END OVER PARTITION ROWS RANGE BETWEEN UNBOUNDED PRECEDING " +
  "FOLLOWING CURRENT ROW FETCH FIRST NEXT ONLY OFFSET ASC DESC NULLS LAST DISTINCT UNIQUE CONNECT START PRIOR LIKE EXISTS ANY SOME " +
  "LATERAL PIVOT UNPIVOT FOR WINDOW MODEL SAMPLE KEEP WITHIN LEVEL ROWNUM SYSDATE INTERVAL ESCAPE TIES PERCENT").split(" "));
const CLAUSE_END = new Set(["WHERE", "GROUP", "ORDER", "HAVING", "CONNECT", "START", "UNION", "MINUS", "INTERSECT", "EXCEPT", "FETCH", "ON", "USING", "SELECT", "WINDOW", "MODEL", "OFFSET", "PIVOT", "UNPIVOT"]);
const OPS = new Set(["+", "-", "*", "/", "||", "=", "<", ">", "<=", ">=", "<>", "!=", "(", ",", "."]);
function sqlTokens(m, base = 0) {
  const re = /"[^"]*"|[A-Za-z_][\w$#]*|\d+(?:\.\d+)?|'[^']*'?|\|\||<>|!=|>=|<=|[(),.;*=<>+\-\/]/g;
  const out = []; let x;
  while ((x = re.exec(m))) out.push({t: x[0], u: x[0].replace(/"/g, "").toUpperCase(), i: base + x.index, e: base + x.index + x[0].length, id: /^[A-Za-z_"]/.test(x[0])});
  return out;
}
/* Statement around a position (statements are separated by ';' outside strings/comments). */
function statementAt(text, idx) {
  const m = maskSql(text), parts = []; let a = 0;
  for (let i = 0; i <= m.length; i++) if (i === m.length || m[i] === ";") { parts.push([a, i]); a = i + 1; }
  let p = parts.find(([x, y]) => idx >= x && idx <= y) || parts[parts.length - 1];
  if (!m.slice(p[0], p[1]).trim()) {               // cursor after the last ';' → previous statement
    const k = parts.indexOf(p);
    for (let j = k - 1; j >= 0; j--) if (m.slice(parts[j][0], parts[j][1]).trim()) { p = parts[j]; break; }
  }
  let [s, e] = p;
  while (s < e && /\s/.test(m[s])) s++;
  while (e > s && /\s/.test(m[e - 1])) e--;
  return {start: s, end: e, text: text.slice(s, e), masked: m.slice(s, e), count: parts.filter(([x, y]) => m.slice(x, y).trim()).length};
}
/* Which names are in scope: tables + aliases, CTEs, inline views.  ctesIn: CTEs visible from outside. */
function parseScope(m, base = 0, ctesIn = null) {
  const T = sqlTokens(m, base);
  const aliases = new Map(), ctes = new Map(ctesIn || []), joins = [];
  const fromAt = [false], opens = [];
  let depth = 0, expectTable = false, pendingCte = null, clause = "", lastKw = "";
  const isId = k => T[k] && T[k].id && !SQLKW.has(T[k].u);
  const readAlias = k => {
    if (T[k] && T[k].u === "AS" && isId(k + 1)) return [T[k + 1], k + 2];
    if (isId(k)) return [T[k], k + 1];
    return [null, k];
  };
  for (let k = 0; k < T.length; k++) {
    const tk = T[k], u = tk.u;
    if (u === "(") {
      opens.push({k, table: expectTable, cte: pendingCte}); pendingCte = null;
      depth++; fromAt[depth] = false; expectTable = false; continue;
    }
    if (u === ")") {
      const o = opens.pop(); depth = Math.max(0, depth - 1);
      if (o && o.cte) { const c = ctes.get(o.cte); c.inner = m.slice(T[o.k].e - base, tk.i - base); c.innerBase = T[o.k].e; }
      if (o && o.table) {
        const [al, nk] = readAlias(k + 1);
        if (al) {
          const ent = {alias: al.t.replace(/"/g, ""), table: null, kind: "view", inner: m.slice(T[o.k].e - base, tk.i - base), innerBase: T[o.k].e, i: al.i, ie: al.e, explicit: true};
          aliases.set(al.u, ent); joins.push(ent); k = nk - 1;
        }
      }
      continue;
    }
    if (tk.id && (T[k - 1] && (T[k - 1].u === "WITH" || T[k - 1].u === ",")) && T[k + 1] && T[k + 1].u === "AS" && T[k + 2] && T[k + 2].u === "(" && T[k + 3] && (T[k + 3].u === "SELECT" || T[k + 3].u === "WITH")) {
      ctes.set(u, {name: tk.t.replace(/"/g, ""), i: tk.i}); pendingCte = u; k++; continue;
    }
    if (u === "FROM" || u === "JOIN") { fromAt[depth] = true; expectTable = true; lastKw = u; clause = u; continue; }
    if (u === "," && fromAt[depth]) { expectTable = true; lastKw = ","; continue; }
    if (CLAUSE_END.has(u)) { fromAt[depth] = false; expectTable = false; clause = u; lastKw = u; continue; }
    if (expectTable && tk.id && (!SQLKW.has(u) || TABLESET.has(u))) {
      let name = tk, nk = k + 1;
      if (T[k + 1] && T[k + 1].u === "." && T[k + 2] && T[k + 2].id) { name = T[k + 2]; nk = k + 3; }
      const [al, nk2] = readAlias(nk);
      const ent = {alias: (al || name).t.replace(/"/g, ""), table: name.u, kind: ctes.has(name.u) ? "cte" : "table", i: name.i, ie: name.e, explicit: !!al};
      aliases.set((al || name).u, ent); joins.push(ent);
      expectTable = false; k = nk2 - 1; continue;
    }
    if (tk.id || u !== ",") { if (expectTable && !tk.id) expectTable = false; }
    if (SQLKW.has(u)) lastKw = u;
  }
  return {aliases, ctes, joins, expectTable, clause, lastKw, depth, tokens: T};
}
/* Output column names of a SELECT (used for CTEs and inline views). */
function derivedCols(inner, innerBase, ctesIn, guard = 0) {
  const T = sqlTokens(inner, innerBase);
  let d = 0, s = -1, f = -1;
  for (let k = 0; k < T.length; k++) {
    const u = T[k].u;
    if (u === "(") d++; else if (u === ")") d--;
    else if (d === 0 && u === "SELECT" && s < 0) s = k;
    else if (d === 0 && s >= 0 && u === "FROM") { f = k; break; }
  }
  if (s < 0) return {cols: [], partial: true};
  const items = []; let cur = []; d = 0;
  for (let k = s + 1; k < (f < 0 ? T.length : f); k++) {
    const u = T[k].u;
    if (u === "(") d++; else if (u === ")") d--;
    if (d === 0 && u === ",") { items.push(cur); cur = []; } else cur.push(T[k]);
  }
  items.push(cur);
  const out = []; let partial = false, sc = null;
  const scope = () => sc || (sc = parseScope(inner, innerBase, ctesIn));
  for (let it of items) {
    while (it.length && ["DISTINCT", "ALL", "UNIQUE"].includes(it[0].u)) it = it.slice(1);
    if (!it.length) continue;
    const last = it[it.length - 1], prev = it[it.length - 2];
    if (last.u === "*") {
      if (guard > 3) { partial = true; continue; }
      const ents = prev && prev.u === "." && it[it.length - 3] ? [scope().aliases.get(it[it.length - 3].u)].filter(Boolean) : scope().joins;
      if (!ents.length) partial = true;
      for (const en of ents) { const r = colsForEntry(en, scope(), guard + 1); r.cols.forEach(c => out.push(c)); if (r.partial) partial = true; }
    } else if (it.length === 1 && last.id) out.push({n: last.u, t: ""});
    else if (it.length === 3 && it[1].u === "." && last.id) out.push({n: last.u, t: ""});
    else if (last.id && !SQLKW.has(last.u) && prev && !OPS.has(prev.u)) out.push({n: last.u, t: ""});
    else partial = true;   // expression without an alias
  }
  return {cols: out, partial};
}
function colsForEntry(ent, scope, guard = 0) {
  if (!ent) return {cols: [], partial: true};
  if (ent.kind === "view") return derivedCols(ent.inner, ent.innerBase, scope.ctes, guard);
  const c = scope.ctes.get(ent.table);
  if (c && c.inner != null) return derivedCols(c.inner, c.innerBase, scope.ctes, guard);
  return knownCols(ent.table);
}

/* ---------- editor ---------- */
var ED = null;
const COL_TRIED = new Set();
const SRC_RANK = {fk: 0, builtin: 1, import: 2, inferred: 3};
const KIND_LBL = {col: "col", tbl: "table", join: "join", on: "on", kw: "sql", fn: "fn", als: "alias", cte: "cte", val: "value"};
const KW_LIST = ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "JOIN", "LEFT JOIN", "INNER JOIN", "LEFT OUTER JOIN", "RIGHT JOIN",
  "FULL OUTER JOIN", "CROSS JOIN", "ON", "AND", "OR", "NOT", "IN", "NOT IN", "EXISTS", "NOT EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL",
  "DISTINCT", "UNION ALL", "UNION", "MINUS", "INTERSECT", "WITH", "AS", "CASE", "WHEN", "THEN", "ELSE", "END", "OVER", "PARTITION BY",
  "ROWS BETWEEN", "RANGE BETWEEN", "UNBOUNDED PRECEDING", "UNBOUNDED FOLLOWING", "CURRENT ROW", "FETCH FIRST", "ROWS ONLY", "ASC", "DESC",
  "NULLS FIRST", "NULLS LAST", "ROWNUM", "SYSDATE", "SYSTIMESTAMP", "NULL", "DUAL", "KEEP (DENSE_RANK FIRST ORDER BY", "WITHIN GROUP (ORDER BY"];
const FN_LIST = [["NVL", "expr, value_if_null"], ["NVL2", "expr, if_not_null, if_null"], ["COALESCE", "a, b, …"], ["DECODE", "expr, search, result, …, default"],
  ["NULLIF", "a, b"], ["TO_CHAR", "value, 'YYYY-MM-DD HH24:MI'"], ["TO_DATE", "'text', 'YYYY-MM-DD'"], ["TO_NUMBER", "text"], ["TO_TIMESTAMP", "'text', 'fmt'"],
  ["TRUNC", "date | number [, 'fmt']"], ["ROUND", "n [, digits]"], ["SUBSTR", "text, start [, len]"], ["INSTR", "text, find [, start]"], ["REPLACE", "text, find, with"],
  ["UPPER", "text"], ["LOWER", "text"], ["TRIM", "text"], ["LPAD", "text, n, pad"], ["RPAD", "text, n, pad"], ["LENGTH", "text"],
  ["REGEXP_LIKE", "text, 'pattern'"], ["REGEXP_SUBSTR", "text, 'pattern'"], ["REGEXP_REPLACE", "text, 'pattern', 'with'"],
  ["COUNT", "* | expr"], ["SUM", "expr"], ["AVG", "expr"], ["MIN", "expr"], ["MAX", "expr"], ["LISTAGG", "expr, ', ') WITHIN GROUP (ORDER BY …"],
  ["ROW_NUMBER", ") OVER (PARTITION BY … ORDER BY …"], ["RANK", ") OVER (…"], ["DENSE_RANK", ") OVER (…"], ["LAG", "expr [, n, default]) OVER (…"],
  ["LEAD", "expr [, n, default]) OVER (…"], ["FIRST_VALUE", "expr) OVER (…"], ["LAST_VALUE", "expr) OVER (…"], ["NTILE", "n) OVER (…"],
  ["RATIO_TO_REPORT", "expr) OVER (…"], ["ADD_MONTHS", "date, n"], ["MONTHS_BETWEEN", "d1, d2"], ["LAST_DAY", "date"], ["EXTRACT", "YEAR FROM date"],
  ["CAST", "expr AS type"], ["GREATEST", "a, b, …"], ["LEAST", "a, b, …"], ["ABS", "n"], ["MOD", "n, m"], ["CEIL", "n"], ["FLOOR", "n"],
  ["FROM_TZ", "ts, 'tz'"], ["SYS_EXTRACT_UTC", "ts"], ["NUMTODSINTERVAL", "n, 'DAY'"]];

function caseFn(word, sample) {
  const m = $("#edCase").value;
  if (m === "upper") return s => s.toUpperCase();
  if (m === "lower") return s => s.toLowerCase();
  if (word && /[A-Za-z]/.test(word)) return /[a-z]/.test(word) && !/[A-Z]/.test(word) ? s => s.toLowerCase() : s => s.toUpperCase();
  // nothing typed yet: follow the style of the names already in the statement
  let up = 0, low = 0;
  for (const t of sample || []) if (t.id && t.t.length > 3 && !SQLKW.has(t.u)) { if (/^[a-z][a-z0-9_$#]*$/.test(t.t)) low++; else if (/^[A-Z][A-Z0-9_$#]*$/.test(t.t)) up++; }
  return low > up ? s => s.toLowerCase() : s => s.toUpperCase();
}
function matchScore(name, w) {        // lower = better, -1 = no match
  if (!w) return 1;
  const N = name.toUpperCase(), W = w.toUpperCase();
  if (N === W) return 0;
  if (N.startsWith(W)) return 1;
  if (N.includes("_" + W)) return 2;
  if (N.includes(W)) return 3;
  return -1;
}
function mkAlias(name, used) {
  let a = name.toLowerCase().split(/[_$#]+/).filter(Boolean).map(w => w[0]).join("").slice(0, 4) || "t";
  if (SQLKW.has(a.toUpperCase())) a += "x";
  let b = a, n = 2;
  while (used.has(b.toUpperCase())) b = a + n++;
  used.add(b.toUpperCase());
  return b;
}
function renderHint(el, self, d) {
  el.innerHTML = `<span class="hk hk-${d.kind}">${KIND_LBL[d.kind]}</span><span class="hl-t">${esc(d.displayText)}</span>${d.detail ? `<span class="hd">${esc(d.detail)}</span>` : ""}`;
}
const H = (text, label, kind, detail, sc, rank = 0, extra = {}) => Object.assign({text, displayText: label, kind, detail, sc, rank, render: renderHint}, extra);
function sortHints(list, kindOrder) {
  const ko = k => { const i = kindOrder.indexOf(k); return i < 0 ? 99 : i; };
  const seen = new Set();
  return list.filter(h => !seen.has(h.text) && seen.add(h.text))
    .sort((a, b) => a.sc - b.sc || ko(a.kind) - ko(b.kind) || a.rank - b.rank || a.displayText.length - b.displayText.length || a.displayText.localeCompare(b.displayText))
    .slice(0, 150);
}
function tableHints(word, scope, cs) {
  const out = [];
  if (scope) for (const [k, c] of scope.ctes) { const sc = matchScore(k, word); if (sc >= 0) out.push(H(c.name, c.name, "cte", "WITH step", sc, -1)); }
  if (!word) return out;
  for (const t of TABLESET) {
    const sc = matchScore(t, word); if (sc < 0) continue;
    out.push(H(cs(t), t, "tbl", SCHEMA.columns[t] ? SCHEMA.columns[t].length + " cols" : "", sc, -(DEGREE.get(t) || 0) / 1000));
  }
  return out;
}
function colHints(res, word, ent, qualify, cs) {
  const out = [];
  res.cols.forEach((c, i) => {
    const sc = matchScore(c.n, word); if (sc < 0) return;
    const pre = qualify ? ent.alias + "." : "";
    out.push(H(pre + cs(c.n), (qualify ? ent.alias + "." : "") + c.n, "col", [c.t, ent.table && ent.table !== ent.alias.toUpperCase() ? ent.table : ""].filter(Boolean).join(" · "), sc, i / 1000));
  });
  return out;
}
function joinHints(word, before, all, cs) {
  const used = new Set(all.aliases.keys()), out = [];
  for (const ent of before.joins) {
    if (ent.kind !== "table") continue;
    for (const ei of ADJ.get(ent.table) || []) {
      const e = SCHEMA.edges[ei];
      const other = e.c === ent.table ? e.p : e.c;
      const sc = matchScore(other, word); if (sc < 0) continue;
      const a = mkAlias(other, new Set(used));
      const [oc, ec] = e.c === ent.table ? [e.pc, e.cc] : [e.cc, e.pc];
      const cond = oc.map((c, i) => `${a}.${cs(c)} = ${ent.alias}.${cs(ec[i])}`).join(" AND ");
      out.push(H(`${cs(other)} ${a} ON ${cond}`, `${other} ${a} ON ${cond}`, "join", e.src === "fk" ? "foreign key" : e.src, sc, SRC_RANK[e.src] + (isHub(other) ? 5 : 0)));
    }
  }
  return out;
}
function onHints(word, before, cs) {
  const j = before.joins[before.joins.length - 1]; if (!j || before.joins.length < 2) return [];
  const out = [];
  for (const p of before.joins.slice(0, -1)) {
    if (j.kind === "table" && p.kind === "table") {
      for (const ei of ADJ.get(j.table) || []) {
        const e = SCHEMA.edges[ei];
        let jc, pc;
        if (e.c === j.table && e.p === p.table) [jc, pc] = [e.cc, e.pc];
        else if (e.p === j.table && e.c === p.table) [jc, pc] = [e.pc, e.cc];
        else continue;
        const cond = jc.map((c, i) => `${j.alias}.${cs(c)} = ${p.alias}.${cs(pc[i])}`).join(" AND ");
        const sc = matchScore(cond, word); if (sc < 0) continue;
        out.push(H(cond, cond, "on", e.src === "fk" ? "foreign key" : e.src, sc, SRC_RANK[e.src]));
      }
    }
    // same-named _GID columns (works for CTEs / views too)
    const a = colsForEntry(j, before), b = colsForEntry(p, before);
    const bn = new Set(b.cols.map(c => c.n));
    for (const c of a.cols) if (/_GID$/.test(c.n) && bn.has(c.n)) {
      const cond = `${j.alias}.${cs(c.n)} = ${p.alias}.${cs(c.n)}`;
      const sc = matchScore(cond, word); if (sc >= 0) out.push(H(cond, cond, "on", "same column", sc, 4));
    }
  }
  return out;
}
function generalHints(word, all, cs) {
  const out = [];
  const ents = [...new Set(all.aliases.values())];
  for (const ent of ents) {
    const res = colsForEntry(ent, all);
    const qualify = ents.length > 1 || ent.explicit;
    colHints(res, word, ent, qualify, cs).forEach(h => out.push(h));
    const sc = matchScore(ent.alias, word);
    if (sc >= 0 && word) out.push(H(ent.alias, ent.alias, "als", ent.table ? "→ " + ent.table : ent.kind, sc));
  }
  if (word) {
    for (const k of KW_LIST) { const sc = matchScore(k, word); if (sc >= 0 && sc < 3) out.push(H(cs(k), k, "kw", "", sc + 0.5)); }
    for (const [f, sig] of FN_LIST) {
      const sc = matchScore(f, word); if (sc < 0 || sc > 2) continue;
      out.push(H(cs(f) + "(", f + "(" + sig + ")", "fn", "", sc + 0.5, 0, {hint: (cm, data, c) => { cm.replaceRange(c.text + ")", data.from, data.to); const p = cm.getCursor(); cm.setCursor(CodeMirror.Pos(p.line, p.ch - 1)); }}));
    }
    if (word.length >= 3) tableHints(word, all, cs).forEach(h => { h.sc += 1; out.push(h); });
  }
  return out;
}
function wordAt(cm) {
  const cur = cm.getCursor(), line = cm.getLine(cur.line);
  let s = cur.ch; while (s > 0 && /[\w$#]/.test(line[s - 1])) s--;
  let e = cur.ch; while (e < line.length && /[\w$#]/.test(line[e])) e++;
  let qual = null;
  if (line[s - 1] === ".") { let q = s - 1; while (q > 0 && /[\w$#"]/.test(line[q - 1])) q--; qual = line.slice(q, s - 1).replace(/"/g, ""); }
  return {cur, s, e, word: line.slice(s, cur.ch), qual};
}
/* ---------- value autocomplete (v1.6): inside  col = '…'  /  col IN ('…', '…') ---------- */
const VAL_CACHE = new Map();      // key -> Promise<[{v, d}]>
function valueContext(cm) {
  const cur = cm.getCursor(), line = cm.getLine(cur.line), before = line.slice(0, cur.ch);
  if ((before.match(/'/g) || []).length % 2 === 0) return null;          // not inside a string
  const m = before.match(/([A-Za-z_][\w$#]*)(?:\s*\.\s*([A-Za-z_][\w$#]*))?\s*(?:=|<>|!=|\bLIKE|\bIN\s*\((?:\s*'[^']*'\s*,)*)\s*'([^']*)$/i);
  if (!m) return null;
  let e = cur.ch; while (e < line.length && line[e] !== "'") e++;
  return {alias: m[2] ? m[1] : null, col: (m[2] || m[1]).toUpperCase(), prefix: m[3], from: CodeMirror.Pos(cur.line, cur.ch - m[3].length), to: CodeMirror.Pos(cur.line, e)};
}
function literalConds(tokens, ent, text, single) {   // [COL, 'literal'] conditions on the same alias, e.g. ss.status_type_gid = 'X'
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    let col = null, j = k;
    if (tokens[k].id && tokens[k + 1] && tokens[k + 1].u === "." && tokens[k + 2] && tokens[k + 2].id && tokens[k].u === ent.alias.toUpperCase()) { col = tokens[k + 2].u; j = k + 2; }
    else if (single && tokens[k].id && !(tokens[k - 1] && tokens[k - 1].u === ".") && !(tokens[k + 1] && tokens[k + 1].u === ".")) { col = tokens[k].u; }
    if (!col || !tokens[j + 1] || tokens[j + 1].u !== "=" || !tokens[j + 2] || tokens[j + 2].t[0] !== "'") continue;
    const lit = text.slice(tokens[j + 2].i, tokens[j + 2].e);
    if (lit.length >= 2 && lit.endsWith("'")) out.push([col, lit.slice(1, -1).replace(/''/g, "'")]);
  }
  return out;
}
function valueSpec(ent, col, all, text) {
  const tcols = SCHEMA.columns[ent.table] || null;
  if (tcols && !tcols.some(c => c[0] === col)) return null;
  const ctype = tcols ? (tcols.find(c => c[0] === col) || [])[1] || "" : "";
  if (/_GID$/.test(col) && typeof gidTarget === "function") {
    const P = gidTarget(ent.table, col);
    if (P && TABLESET.has(P)) {
      const pk = keyCol(P), pcols = (SCHEMA.columns[P] || []).map(c => c[0]), filters = [];
      // narrow by other conditions you already wrote, when that column also exists in the lookup table
      // (e.g. STATUS_VALUE filtered by the STATUS_TYPE_GID in your WHERE)
      for (const [c2, lit] of literalConds(all.tokens, ent, text, all.aliases.size === 1))
        if (c2 !== col && c2 !== pk && c2 !== "DOMAIN_NAME" && pcols.includes(c2)) filters.push(`${c2} = ${q(lit)}`);
      return {kind: "gid", table: P, pk, desc: nameCol(P), filters, key: [CUR_PID, P, ...filters].join("|")};
    }
  }
  if (/DATE|TIME|NUMBER|FLOAT|LONG|LOB|RAW|BINARY/.test(ctype)) return null;
  return {kind: "sample", table: ent.table, col, key: [CUR_PID, ent.table, col, "sample"].join("|")};
}
function vcached(key, fn) {
  if (!VAL_CACHE.has(key)) VAL_CACHE.set(key, fn().catch(e => { VAL_CACHE.delete(key); throw e; }));
  return VAL_CACHE.get(key);
}
const likeEsc = s => s.replace(/[\\%_]/g, "\\$&");
function valSql(spec, pfx) {
  const w = [pfx ? `${spec.pk} LIKE ${q(likeEsc(pfx) + "%")} ESCAPE '\\'` : "", ...spec.filters].filter(Boolean);
  return `SELECT ${spec.pk} AS V${spec.desc ? `, ${spec.desc} AS D` : ""} FROM ${spec.table}${w.length ? " WHERE " + w.join(" AND ") : ""}`;
}
async function fetchValues(spec, prefix) {
  const run = async (sql, n) => { const r = await api("/api/query", {sql, maxRows: n}); if (r.error) throw new Error(r.error); return r.rows.map(row => { const o = {}; r.columns.forEach((c, i) => o[c] = row[i]); return o; }); };
  if (spec.kind === "sample")       // most used values in a sample of 20,000 rows — never a full scan
    return vcached(spec.key, async () => (await run(`SELECT V, COUNT(*) AS N FROM (SELECT ${spec.col} AS V FROM ${spec.table} WHERE ${spec.col} IS NOT NULL AND ROWNUM <= 20000) GROUP BY V ORDER BY 2 DESC`, 300))
      .map(o => ({v: o.V, d: `${(+o.N).toLocaleString()}× in sample`})));
  const base = await vcached(spec.key, async () => {
    const rows = (await run(valSql(spec, ""), 500)).map(o => ({v: o.V, d: o.D || ""}));
    return {rows: rows.slice(0, 500).sort((a, b) => a.v.localeCompare(b.v)), big: rows.length > 500};
  });
  if (!base.big || !prefix) return base.rows;
  // big lookup table: ask Oracle for values that start with what you typed (primary-key index)
  const P = prefix.toUpperCase();
  for (let n = P.length - 1; n >= 1; n--) {
    const k = spec.key + "|" + P.slice(0, n);
    if (VAL_CACHE.has(k)) { const got = await VAL_CACHE.get(k).catch(() => null); if (got && got.length < 200) return got; }
  }
  return vcached(spec.key + "|" + P, async () => (await run(valSql(spec, P), 199)).map(o => ({v: o.V, d: o.D || ""})));
}
function pickValue(cm, data, c) {
  cm.replaceRange(c.text, data.from, data.to);
  const p = cm.getCursor();
  if (cm.getLine(p.line)[p.ch] === "'") cm.setCursor(CodeMirror.Pos(p.line, p.ch + 1));
}
async function valueHints(cm, vc, callback) {
  if (!CONNECTED) return callback(null);
  const text = cm.getValue(), st = statementAt(text, cm.indexFromPos(vc.from)), all = parseScope(st.masked, st.start);
  const ents = [...all.aliases.values()];
  const ent = vc.alias ? all.aliases.get(vc.alias.toUpperCase())
    : ents.find(en => en.kind === "table" && !all.ctes.has(en.table) && knownCols(en.table).cols.some(c => c.n === vc.col)) || (ents.length === 1 ? ents[0] : null);
  if (!ent || ent.kind !== "table" || all.ctes.has(ent.table)) return callback(null);
  const spec = valueSpec(ent, vc.col, all, text);
  if (!spec) return callback(null);
  let list;
  edStatus(`Loading values for ${vc.col}${spec.kind === "gid" ? " from " + spec.table : ""}…`);
  try { list = await fetchValues(spec, vc.prefix); } catch (e) { edStatus(); return callback(null); }
  edStatus();
  const items = [];
  list.forEach((x, i) => {
    const a = matchScore(x.v, vc.prefix), b = x.d && spec.kind === "gid" ? matchScore(x.d, vc.prefix) : -1;
    const sc = a >= 0 ? a : b >= 0 ? b + 1 : -1; if (sc < 0) return;
    items.push(H(x.v, x.v, "val", x.d, sc, i / 10000, {hint: pickValue}));
  });
  items.sort((p, r) => p.sc - r.sc || p.rank - r.rank);
  callback(items.length ? {list: items.slice(0, 300), from: vc.from, to: vc.to} : null);
}

function sqlHint(cm, callback, options) {
  const vc = valueContext(cm);
  if (vc) return valueHints(cm, vc, callback);
  const {cur, s, e, word, qual} = wordAt(cm);
  const tt = cm.getTokenAt(cur).type || "";
  if (/string|comment/.test(tt)) return callback(null);
  const text = cm.getValue(), idx = cm.indexFromPos(CodeMirror.Pos(cur.line, s));
  const st = statementAt(text, idx);
  const all = parseScope(st.masked, st.start);
  const from = CodeMirror.Pos(cur.line, s), to = CodeMirror.Pos(cur.line, e);
  const cs = caseFn(word, all.tokens);
  const finish = (list, order) => { const l = sortHints(list, order); callback(l.length ? {list: l, from, to} : null); };
  if (qual) {
    const ent = all.aliases.get(qual.toUpperCase());
    if (!ent) return finish(word || options.explicit ? tableHints(word, null, cs) : [], ["tbl"]);
    const go = () => finish(colHints(colsForEntry(ent, all), word, ent, false, cs), ["col"]);
    if (ent.kind === "table" && !all.ctes.has(ent.table) && !SCHEMA.columns[ent.table] && CONNECTED && !COL_TRIED.has(ent.table)) {
      COL_TRIED.add(ent.table); edStatus(`Loading columns of ${ent.table}…`);
      return loadCols(ent.table).then(() => { go(); edStatus(); }).catch(() => go());
    }
    return go();
  }
  const before = parseScope(st.masked.slice(0, Math.max(0, idx - st.start)), st.start);
  const T = before.tokens, prev = T[T.length - 1] ? T[T.length - 1].u : "";
  if (before.expectTable) {
    if (before.lastKw === "JOIN") return finish(joinHints(word, before, all, cs).concat(tableHints(word, all, cs)), ["cte", "join", "tbl"]);
    return finish(tableHints(word, all, cs), ["cte", "tbl"]);
  }
  if (before.clause === "ON" && (prev === "ON" || prev === "AND" || word)) {
    const l = onHints(word, before, cs);
    if (l.length || !word) return finish(l.concat(word ? generalHints(word, all, cs) : []), ["on", "col"]);
  }
  if (!word && !options.explicit) return callback(null);
  // columns that are not loaded yet: fetch them (once) when connected
  const missing = [...all.aliases.values()].filter(en => en.kind === "table" && !all.ctes.has(en.table) && !SCHEMA.columns[en.table] && CONNECTED && !COL_TRIED.has(en.table)).slice(0, 6);
  if (missing.length) {
    missing.forEach(en => COL_TRIED.add(en.table)); edStatus("Loading columns…");
    return Promise.all(missing.map(en => loadCols(en.table).catch(() => false))).then(() => { edStatus(); finish(generalHints(word, all, cs), ["col", "als", "kw", "fn", "cte", "tbl"]); });
  }
  finish(generalHints(word, all, cs), ["col", "als", "kw", "fn", "cte", "tbl"]);
}
sqlHint.async = true;

const tableOverlay = {
  token(stream) {
    if (stream.match(/^[A-Za-z_][\w$#]*/)) {
      if (stream.start > 0 && stream.string[stream.start - 1] === ".") return null;
      return TABLESET.has(stream.current().toUpperCase()) ? "otm-table" : null;
    }
    stream.next(); return null;
  }
};
function edSchemaChanged() {
  if (!ED) return;
  ED.removeOverlay(tableOverlay); ED.addOverlay(tableOverlay);
  COL_TRIED.clear(); edStatus();
}
function getSQL() { return ED ? ED.getValue() : $("#sqlEditor").value; }
function setSQL(s) {
  if (!ED) { $("#sqlEditor").value = s; return; }
  ED.setValue(s || ""); ED.clearHistory(); clearMarks();
  setTimeout(() => { ED.refresh(); ED.focus(); ED.setCursor(ED.lastLine(), ED.getLine(ED.lastLine()).length); }, 0);
}
/* What Run / Check act on: the selection, or the statement under the cursor. */
function actionRange() {
  if (ED.somethingSelected()) {
    const a = ED.indexFromPos(ED.getCursor("from")), b = ED.indexFromPos(ED.getCursor("to"));
    const t = ED.getRange(ED.getCursor("from"), ED.getCursor("to"));
    const lead = t.length - t.trimStart().length;
    const sel = t.trim().replace(/;\s*$/, "");
    return {start: a + lead, end: a + lead + sel.length, text: sel, masked: maskSql(sel), selection: true};
  }
  const st = statementAt(ED.getValue(), ED.indexFromPos(ED.getCursor()));
  return st;
}
function flashRange(r) {
  const mk = ED.markText(ED.posFromIndex(r.start), ED.posFromIndex(r.end), {className: "ed-run"});
  setTimeout(() => mk.clear(), 700);
}
function sqlForAction(flash) {
  if (!ED) return $("#sqlEditor").value.trim();
  const r = actionRange();
  if (!r.text.trim()) return "";
  if (flash && (r.selection || r.count > 1)) flashRange(r);
  return r.text.trim();
}
let ED_MARKS = [];
function clearMarks() { ED_MARKS.forEach(m => m.clear()); ED_MARKS = []; $("#edIssues").innerHTML = ""; }
function edStatus(note) {
  if (!ED) return;
  const c = ED.getCursor();
  $("#edPos").textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
  if (note) { $("#edScope").innerHTML = `<b>${esc(note)}</b>`; return; }
  try {
    const st = statementAt(ED.getValue(), ED.indexFromPos(c));
    const sc = parseScope(st.masked, st.start);
    const parts = [...sc.aliases.values()].map(en => {
      const r = colsForEntry(en, sc);
      const what = en.kind === "view" ? "inline view" : en.kind === "cte" ? "WITH step " + en.table : en.table;
      const n = r.cols.length ? `${r.cols.length} cols${r.partial ? "?" : ""}` : (en.kind === "table" && !TABLESET.has(en.table) ? "unknown table" : "no columns yet");
      return `<b>${esc(en.alias)}</b> = ${esc(what)} <span style="opacity:.7">(${n})</span>`;
    });
    $("#edScope").innerHTML = parts.length ? "in scope: " + parts.join(" · ") : "";
  } catch (e) { $("#edScope").textContent = ""; }
}

/* ---------- local check against the synced schema ---------- */
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({length: n + 1}, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function closest(name, names) {
  let best = null, bd = 1e9;
  for (const x of names) { const d = lev(name, x) - (x.includes(name) || name.includes(x) ? 2 : 0); if (d < bd) { bd = d; best = x; } }
  return best && bd <= Math.max(3, Math.floor(name.length / 3)) ? best : null;
}
function localLint(r) {
  const sc = parseScope(r.masked, r.start), T = sc.tokens, issues = [];
  const owner = ($("#owner").value || "").trim().toUpperCase();
  const realSchema = TABLESET.size > 300;
  for (const en of sc.joins) {
    if (en.kind === "table" && !sc.ctes.has(en.table) && realSchema && !TABLESET.has(en.table)) {
      const sug = closest(en.table, [...TABLESET].filter(t => Math.abs(t.length - en.table.length) < 6));
      issues.push({i: en.i, j: en.ie, sev: "w", msg: `${en.table} is not in the synced schema` + (sug ? ` — did you mean ${sug}?` : "")});
    }
  }
  for (let k = 0; k < T.length - 2; k++) {
    if (!T[k].id || T[k + 1].u !== "." || !T[k + 2].id || (T[k - 1] && T[k - 1].u === ".")) continue;
    if (T[k + 3] && (T[k + 3].u === "(" || T[k + 3].u === ".")) continue;      // package.function( or owner.table.col
    const A = T[k].u, C = T[k + 2].u;
    if (A === owner || A === "GLOGOWNER" || A === "SYS") continue;
    const en = sc.aliases.get(A);
    if (!en) { issues.push({i: T[k].i, j: T[k].e, sev: "e", msg: `"${T[k].t}" is not a table or alias in this query`}); continue; }
    const res = colsForEntry(en, sc);
    if (res.partial || !res.cols.length) continue;
    if (!res.cols.some(c => c.n === C)) {
      const sug = closest(C, res.cols.map(c => c.n));
      issues.push({i: T[k + 2].i, j: T[k + 2].e, sev: "e", msg: `${en.table || en.alias} has no column ${C}` + (sug ? ` — did you mean ${sug}?` : "")});
    }
  }
  return {issues, scope: sc};
}
function showIssues(list) {
  list.forEach(x => ED_MARKS.push(ED.markText(ED.posFromIndex(x.i), ED.posFromIndex(x.j), {className: x.sev === "e" ? "ed-err" : "ed-warn", attributes: {title: x.msg}})));
  $("#edIssues").innerHTML = list.map((x, n) => { const p = ED.posFromIndex(x.i); return `<div data-n="${n}" class="${x.sev}"><span class="mono">Ln ${p.line + 1}</span><span>${x.sev === "e" ? "✗" : "⚠"} ${esc(x.msg)}</span></div>`; }).join("");
  $("#edIssues").querySelectorAll("[data-n]").forEach(d => d.onclick = () => { const x = list[+d.dataset.n]; ED.focus(); ED.setSelection(ED.posFromIndex(x.i), ED.posFromIndex(x.j)); ED.scrollIntoView(ED.posFromIndex(x.i), 80); });
}
const ORA_TIPS = {
  "00904": "A column or alias name is wrong (or not visible at that point of the query).",
  "00942": "A table/view doesn't exist, or this OTM user can't read it.",
  "00918": "Two columns end up with the same name. Give one of them an alias — OTM returns columns as XML attributes, so names must be unique.",
  "00933": "Syntax error: something extra or out of order near the end of a clause (check commas and keywords).",
  "00936": "Syntax error: an expression is missing (e.g. a trailing comma, or an empty SELECT / WHERE part).",
  "00907": "A parenthesis is missing or in the wrong place.",
  "00923": "FROM is not where Oracle expected it — usually a missing comma or alias problem in the SELECT list.",
  "00979": "Every non-aggregated column in SELECT must also be in GROUP BY.",
  "00937": "Mixing aggregated and plain columns without GROUP BY.",
  "00934": "Aggregates (SUM, COUNT…) can't be used in WHERE — use HAVING or a step.",
  "30483": "Window functions can't be used in WHERE / GROUP BY. Calculate them in a step (CTE) and filter outside.",
  "00932": "Data types don't match (e.g. comparing a date with text). Use TO_DATE / TO_CHAR.",
  "00920": "Invalid comparison operator.",
  "00905": "A keyword is missing (e.g. THEN / END in CASE, or ON in a JOIN).",
  "01789": "UNION / MINUS parts must return the same number of columns.",
  "00957": "Duplicate column name in a step/CTE."
};
function markFromOracle(err, r) {
  const T = sqlTokens(r.masked, r.start), out = [];
  if (/ORA-00942/.test(err)) {
    const sc = parseScope(r.masked, r.start);
    for (const en of sc.joins) if (en.kind === "table" && !sc.ctes.has(en.table) && !TABLESET.has(en.table)) out.push({i: en.i, j: en.ie, sev: "e", msg: err});
  }
  const q = [...err.matchAll(/"([^"]+)"(?:\."([^"]+)")?/g)];
  for (const m of q) {
    const a = m[1].toUpperCase(), b = m[2] ? m[2].toUpperCase() : null;
    for (let k = 0; k < T.length; k++) {
      if (b) { if (T[k].u === a && T[k + 1] && T[k + 1].u === "." && T[k + 2] && T[k + 2].u === b) out.push({i: T[k].i, j: T[k + 2].e, sev: "e", msg: err}); }
      else if (T[k].u === a && !(T[k - 1] && T[k - 1].u === ".") && !(T[k + 1] && T[k + 1].u === ".")) out.push({i: T[k].i, j: T[k].e, sev: "e", msg: err});
      else if (T[k].u === a && T[k - 1] && T[k - 1].u === ".") out.push({i: T[k].i, j: T[k].e, sev: "e", msg: err});
    }
  }
  return out;
}
/* Clean ORA message + tip + underline the names Oracle complains about. */
function showOracleError(text, r) {
  const oras = [...new Set((text.match(/(?:ORA|PLS)-\d{5}[^\n<]*/g) || []).map(x => x.trim()))];
  if (!oras.length) return msg("#qMsg", text, "err");
  const code = (oras[0].match(/ORA-(\d{5})/) || [])[1];
  const tip = code && ORA_TIPS[code] ? "\nTip: " + ORA_TIPS[code] : "";
  msg("#qMsg", "✗ " + oras.join("\n") + tip, "err");
  if (!r) return;
  const marks = markFromOracle(oras[0], r);
  marks.forEach(x => ED_MARKS.push(ED.markText(ED.posFromIndex(x.i), ED.posFromIndex(x.j), {className: "ed-err", attributes: {title: x.msg}})));
  if (marks.length) ED.scrollIntoView(ED.posFromIndex(marks[0].i), 80);
}
async function checkSql() {
  if (!ED) return;
  clearMarks(); msg("#qMsg", "");
  const r = actionRange();
  if (!r.text.trim()) return;
  if (r.selection || r.count > 1) flashRange(r);
  const {issues} = localLint(r);
  showIssues(issues);
  const errs = issues.filter(x => x.sev === "e").length, warns = issues.length - errs;
  const localTxt = issues.length ? `Local check: ${errs ? errs + " error(s)" : ""}${errs && warns ? ", " : ""}${warns ? warns + " warning(s)" : ""} (see below).` : "Local check against the synced schema: no problems found.";
  if (!CONNECTED) return msg("#qMsg", localTxt + "\nConnect to OTM to let Oracle check it too.", errs ? "err" : issues.length ? "info" : "ok");
  $("#btnCheck").disabled = true; $("#runInfo").textContent = "Checking…";
  try {
    const res = await api("/api/check", {sql: typeof subParams === "function" ? subParams(r.text, null) : r.text});   // :params → NULL, enough for a syntax check
    if (res.ok) {
      msg("#qMsg", `✓ Oracle accepted the query (parsed and validated against your instance, no rows read · ${res.elapsedMs} ms).` + (issues.length ? "\n" + localTxt : ""), "ok");
    } else showOracleError(res.raw || res.error || "", r);
  } catch (e) { msg("#qMsg", e.message, "err"); }
  finally { $("#btnCheck").disabled = false; $("#runInfo").textContent = ""; }
}

/* ---------- formatting ---------- */
function formatSql() {
  if (!ED || typeof sqlFormatter === "undefined") return;
  const sel = ED.somethingSelected(), src = sel ? ED.getSelection() : ED.getValue();
  if (!src.trim()) return;
  try {
    const out = sqlFormatter.format(src, {language: "plsql", keywordCase: "upper", functionCase: "upper", dataTypeCase: "upper",
      tabWidth: 2, linesBetweenQueries: 1, logicalOperatorNewline: "before", expressionWidth: 60});
    if (sel) ED.replaceSelection(out, "around");
    else { const c = ED.getCursor(); ED.replaceRange(out, CodeMirror.Pos(0, 0), CodeMirror.Pos(ED.lastLine())); ED.setCursor(Math.min(c.line, ED.lastLine()), 0); }
    clearMarks();
  } catch (e) {
    msg("#qMsg", "Could not format this SQL: " + String(e.message || e).split("\n")[0] + "\n(The formatter only re-indents valid SQL — try Check SQL to find the problem.)", "err");
  }
}

/* ---------- create ---------- */
const ED_SAMPLE = "-- Type SQL here. Try:  s.  after  FROM shipment s   ·   JOIN + space for join suggestions   ·   Ctrl+Space anywhere\nSELECT s.shipment_gid, s.shipment_name\nFROM shipment s\nWHERE ROWNUM <= 10";
(function initEditor() {
  if (typeof CodeMirror === "undefined") return;     // falls back to the plain text box
  ED = CodeMirror.fromTextArea($("#sqlEditor"), {
    mode: "text/x-otmsql", theme: "otm", lineNumbers: true, matchBrackets: true, autoCloseBrackets: "()''\"\"",
    indentUnit: 2, tabSize: 2, smartIndent: false, lineWrapping: false,
    extraKeys: {
      "Ctrl-Enter": () => runQuery(), "Cmd-Enter": () => runQuery(),
      "Shift-Ctrl-Enter": () => checkSql(), "Shift-Cmd-Enter": () => checkSql(),
      "Ctrl-Space": cm => cm.showHint({hint: sqlHint, completeSingle: false, explicit: true}),
      "Shift-Alt-F": formatSql, "Shift-Ctrl-F": formatSql, "Shift-Cmd-F": formatSql,
      "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment",
      "Tab": cm => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("  ", "end"),
      "Shift-Tab": cm => cm.indentSelection("subtract")
    },
    hintOptions: {hint: sqlHint, completeSingle: false, extraKeys: {
      // Enter on a suggestion that is exactly what you typed = new line (so Enter never "eats" a line break)
      Enter: (cm, h) => {
        const w = cm.state.completionActive && cm.state.completionActive.widget;
        const sel = w && h.data && h.data.list[w.selectedHint];
        const {word} = wordAt(cm);
        if (sel && word && sel.text.toUpperCase() === word.toUpperCase()) { h.close(); cm.execCommand("newlineAndIndent"); return; }
        h.pick();
      }
    }}
  });
  ED.addOverlay(tableOverlay);
  let saved = ""; try { saved = localStorage.getItem("editorSql") || ""; } catch (e) {}
  ED.setValue(saved || ED_SAMPLE);
  ED.clearHistory();
  let saveT = null, statT = null;
  ED.on("change", () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem("editorSql", ED.getValue()); } catch (e) {} }, 400); });
  ED.on("changes", () => { if (ED_MARKS.length) clearMarks(); });
  ED.on("cursorActivity", () => { clearTimeout(statT); statT = setTimeout(() => edStatus(), 120); });
  ED.on("keyup", (cm, ev) => {        // typing ' after = / IN ( opens the value list
    if (ev.key === "'" && !cm.state.completionActive && valueContext(cm)) cm.showHint({hint: sqlHint, completeSingle: false});
  });
  ED.on("inputRead", (cm, ch) => {
    if (ch.origin !== "+input") return;
    const t = ch.text.join("");
    if (valueContext(cm)) { if (!cm.state.completionActive && t !== "'") cm.showHint({hint: sqlHint, completeSingle: false}); return; }
    const lb = cm.getLine(cm.getCursor().line).slice(0, cm.getCursor().ch);
    if (t === " " && /\b(JOIN|ON|FROM)\s$/i.test(lb)) {      // JOIN␣ / ON␣ → join suggestions straight away
      if (cm.state.completionActive) cm.state.completionActive.close();
      setTimeout(() => cm.showHint({hint: sqlHint, completeSingle: false}), 0);
      return;
    }
    if (cm.state.completionActive) return;
    const {word} = wordAt(cm);
    const tt = cm.getTokenAt(cm.getCursor()).type || "";
    if (/string|comment/.test(tt)) return;
    if (t === "." || (/^[\w$#]$/.test(t) && word.length >= 2 && !/^\d+$/.test(word)))
      cm.showHint({hint: sqlHint, completeSingle: false});
  });
  new ResizeObserver(() => ED.refresh()).observe($("#edWrap"));
  $("#btnCheck").onclick = checkSql;
  $("#btnFormat").onclick = () => { formatSql(); ED.focus(); };
  $("#btnEdHelp").onclick = () => { const h = $("#edHelp"); h.style.display = h.style.display === "none" ? "block" : "none"; };
  try { const c = localStorage.getItem("edCase"); if (c) $("#edCase").value = c; } catch (e) {}
  $("#edCase").onchange = () => { try { localStorage.setItem("edCase", $("#edCase").value); } catch (e) {} ED.focus(); };
  edStatus();
})();
