/* ================================================================ DESIGNER ⇄ SQL (v1.7)
   The SQL box under the designer is editable. When you leave it (or click Update diagram) the SQL is read
   back into the diagram: tables, subqueries (as derived tables), joins, columns, filters, grouping, sorting.
   Anything the diagram can't show is never dropped: the SQL is kept as written, still runs, and the
   diagram pauses with an explanation — the same way SQL Server Management Studio behaves. */
const DS = {ed: null, lastGen: "", dirty: false, setting: false, undo: null, note: "", marks: []};
function dCurrentSql() { return DESIGN.customSql != null ? DESIGN.customSql : dBuildSql(); }

/* ---------- small helpers ---------- */
const DESIGNER_COMMENT = /^--\s*(inferred link, verify|⚠ no join defined|⚠ \(All Columns\))/;
const NON_ALIAS = new Set(["DAY", "MONTH", "YEAR", "HOUR", "MINUTE", "SECOND", "ROWS", "ROW", "ONLY", "TIES"]);
const JOINWORDS = new Set(["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER", "ON", "USING", "APPLY"]);
const stripQ = t => t.replace(/^"|"$/g, "");
function normSql(s) {
  s = String(s || "").replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, m => m[0] === "'" ? m : " ");
  return s.split(/('(?:[^']|'')*')/).map((p, i) => i % 2 ? p : p.replace(/\s+/g, " ").toUpperCase()).join("").replace(/\s*([(),=<>+\-*\/|])\s*/g, "$1").trim();
}
function dedent(s) {
  const lines = String(s).replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const rest = lines.slice(1).filter(l => l.trim());
  const firstIndent = lines[0].match(/^\s*/)[0].length;
  const min = rest.length ? Math.min(...rest.map(l => l.match(/^\s*/)[0].length)) : 0;
  if (firstIndent === 0 && min > 0) return [lines[0], ...lines.slice(1).map(l => l.slice(Math.min(min, l.match(/^\s*/)[0].length)))].join("\n");
  const m2 = Math.min(firstIndent, rest.length ? min : firstIndent);
  return lines.map(l => l.slice(Math.min(m2, l.match(/^\s*/)[0].length))).join("\n");
}
function matchIdx(T, k) { let d = 0; for (let i = k; i < T.length; i++) { if (T[i].u === "(") d++; else if (T[i].u === ")") { d--; if (!d) return i; } } return -1; }
function splitTop(toks, sep = ",") {
  const out = []; let cur = [], d = 0;
  for (const t of toks) { if (t.u === "(") d++; else if (t.u === ")") d--; if (d === 0 && t.u === sep) { out.push(cur); cur = []; } else cur.push(t); }
  out.push(cur); return out;
}
function conjuncts(toks) {           // top-level AND (BETWEEN-aware); a top-level OR keeps it as one condition
  let d = 0;
  for (const t of toks) { if (t.u === "(") d++; else if (t.u === ")") d--; else if (d === 0 && t.u === "OR") return [toks]; }
  const out = []; let cur = [], between = 0; d = 0;
  for (const t of toks) {
    if (t.u === "(") d++; else if (t.u === ")") d--;
    if (d === 0 && t.u === "BETWEEN") between++;
    if (d === 0 && t.u === "AND") { if (between) { between--; cur.push(t); continue; } out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  out.push(cur); return out.filter(c => c.length);
}
function cteBody(text, name) {
  const T = sqlTokens(maskSql(text), 0);
  if (!T.length || T[0].u !== "WITH") return null;
  let d = 0;
  for (let k = 1; k < T.length; k++) {
    if (T[k].u === "(") d++; else if (T[k].u === ")") d--;
    else if (d === 0 && T[k].u === name && T[k + 1] && T[k + 1].u === "AS" && T[k + 2] && T[k + 2].u === "(") {
      const c = matchIdx(T, k + 2); if (c < 0) return null;
      return {text, s: T[k + 2].e, e: T[c].i, inner: text.slice(T[k + 2].e, T[c].i)};
    }
  }
  return null;
}

/* ---------- SQL → model ---------- */
function parseDesignerSql(text0) {
  const notes = [];
  let text = text0, offset = 0;
  if (DESIGN.steps && DESIGN.steps.length) {         // with Steps only the BASE query syncs with the diagram
    const ex = cteBody(text, BASE_NAME), gx = cteBody(buildFull(), BASE_NAME);
    if (!ex || !gx) return {error: "This query has Steps, so the SQL must keep its WITH BASE AS ( … ) form. Edit the query inside BASE AS ( … ) — the steps themselves are edited in the Steps panel.", fix: "dropSteps"};
    const rest = c => normSql(c.text.slice(0, c.s) + " §§ " + c.text.slice(c.e));
    if (rest(ex) !== rest(gx)) return {error: "The steps (everything after BASE AS ( … )) were changed in the SQL. Steps are edited in the Steps panel — only the BASE query syncs with the diagram.", fix: "dropSteps", at: ex.e, end: ex.e + 1};
    text = ex.inner; offset = ex.s;
  }
  const r = parseSelect(text, notes);
  if (r.error) { if (r.at != null) { r.at += offset; r.end = (r.end != null ? r.end : r.at + 1 - offset) + offset; } return r; }
  if (DESIGN.steps && DESIGN.steps.length && r.model.fields.some(f => f.sort)) notes.push("ORDER BY inside BASE is not used while there are steps — sort in the last step.");
  return {model: r.model, notes};
}
function parseSelect(text, notes) {
  text = text.replace(/;\s*$/, "");
  const masked = maskSql(text);
  const err = (m, at, end) => ({error: m, at, end});
  if (masked.includes(";")) return err("Only one statement can be shown in the diagram — remove the ';' and the second query.", masked.indexOf(";"));
  if ((text.match(/--[^\n]*|\/\*[\s\S]*?\*\//g) || []).some(c => !DESIGNER_COMMENT.test(c.trim()) && !/^\/\*\+/.test(c)) ) notes.push("Comments aren't kept by the designer — they were left out.");
  if (/\/\*\+/.test(text)) notes.push("Optimizer hints (/*+ … */) aren't kept by the designer.");
  let T = sqlTokens(masked, 0);
  if (!T.length) return err("The SQL is empty.");
  if (T[0].u === "(" && matchIdx(T, 0) === T.length - 1) T = T.slice(1, -1);
  if (T[0].u === "WITH") return err("WITH (a named subquery / CTE) can't be shown in the diagram. Put the subquery straight into FROM — it becomes a derived table — or use the Steps panel.", T[0].i, T[0].e);
  if (T[0].u !== "SELECT") return err("The designer reads SELECT queries (SELECT … FROM …).", T[0].i, T[0].e);
  const src = (a, b) => text.slice(a.i, b.e).trim();
  const keyOf = toks => toks.map(t => t.t[0] === "'" ? text.slice(t.i, t.e) : t.u).join(" ");

  /* clauses */
  const C = {}; let d = 0;
  for (let k = 0; k < T.length; k++) {
    const t = T[k], u = t.u, nx = T[k + 1] ? T[k + 1].u : "";
    if (u === "(") { d++; continue; }
    if (u === ")") { d--; if (d < 0) return err("This ')' has no matching '('.", t.i, t.e); continue; }
    if (d || (T[k - 1] && T[k - 1].u === ".")) continue;
    let kw = null;
    if (["SELECT", "FROM", "WHERE", "HAVING"].includes(u)) kw = u;
    else if ((u === "GROUP" || u === "ORDER") && nx === "BY") kw = u + " BY";
    else if (["UNION", "MINUS", "INTERSECT", "EXCEPT"].includes(u)) return err(`${u} (joining the results of two queries) can't be shown in the diagram. Your SQL is kept and still runs — or build each part separately.`, t.i, t.e);
    else if ((u === "CONNECT" && nx === "BY") || (u === "START" && nx === "WITH")) return err("CONNECT BY / START WITH (hierarchical queries) can't be shown in the diagram. Your SQL is kept and still runs.", t.i, t.e);
    else if ((u === "FETCH" && (nx === "FIRST" || nx === "NEXT")) || (u === "OFFSET" && T[k + 1] && /^\d/.test(T[k + 1].t))) return err("FETCH FIRST / OFFSET can't be shown in the diagram — use Max rows, or WHERE ROWNUM <= n. Your SQL is kept and still runs.", t.i, t.e);
    else if (u === "FOR" && nx === "UPDATE") return err("FOR UPDATE isn't allowed — this tool is read-only.", t.i, t.e);
    else if (["PIVOT", "UNPIVOT", "MODEL"].includes(u) && ["(", "INCLUDE", "EXCLUDE"].includes(nx)) return err(`${u} can't be shown in the diagram. Your SQL is kept and still runs.`, t.i, t.e);
    if (kw) { if (C[kw] && kw !== "SELECT") return err(`${kw} appears twice.`, t.i, t.e); if (!C[kw]) C[kw] = {k, s: k + (kw.includes(" ") ? 2 : 1)}; }
  }
  if (d > 0) return err("A '(' is never closed.", T[T.length - 1].e);
  if (!C.FROM) return err("FROM is missing — the diagram needs at least one table.", T[T.length - 1].e);
  const starts = Object.values(C).map(c => c.k).sort((a, b) => a - b);
  const range = kw => { const c = C[kw]; if (!c) return null; const nxt = starts.find(x => x > c.k); return T.slice(c.s, nxt == null ? T.length : nxt); };

  /* FROM */
  const F = range("FROM"), items = [], aliasMap = new Map();
  let k = 0;
  const readItem = (joinKind, type) => {
    const t0 = F[k];
    if (!t0) return err(joinKind === "first" ? "FROM needs a table." : "A table is missing after the JOIN / comma.", (F[k - 1] || T[C.FROM.k]).e);
    const it = {kind: "table", joinKind, type, at: t0.i};
    if (t0.u === "(") {
      const c = matchIdx(F, k); if (c < 0) return err("A '(' is never closed.", t0.i, t0.e);
      if (!F[k + 1] || !["SELECT", "WITH"].includes(F[k + 1].u)) return err("Brackets around joins in FROM can't be shown in the diagram — remove them (joins are read from left to right).", t0.i, t0.e);
      it.kind = "derived"; it.sql = dedent(text.slice(t0.e, F[c].i));
      k = c + 1;
    } else if (t0.id) {
      if ((["TABLE", "XMLTABLE", "JSON_TABLE"].includes(t0.u) && F[k + 1] && F[k + 1].u === "(") || t0.u === "LATERAL")
        return err(`${t0.u} in FROM can't be shown in the diagram. Your SQL is kept and still runs.`, t0.i, t0.e);
      let name = t0, owner = null; k++;
      if (F[k] && F[k].u === "." && F[k + 1] && F[k + 1].id) { owner = name; name = F[k + 1]; k += 2; }
      if (/@/.test(masked.slice(name.e, F[k] ? F[k].i : masked.length).split(/\s/)[0] || "")) return err("Database links (@) can't be shown in the diagram.", name.i, name.e);
      it.name = stripQ(name.t).toUpperCase(); it.owner = owner ? stripQ(owner.t).toUpperCase() : null;
    } else return err(`Expected a table or a (subquery) here, found "${t0.t}".`, t0.i, t0.e);
    if (F[k] && F[k].u === "AS" && F[k + 1] && F[k + 1].u === "OF") return err("Flashback queries (AS OF) can't be shown in the diagram.", F[k].i, F[k + 1].e);
    if (F[k] && ["SAMPLE", "PARTITION"].includes(F[k].u)) return err(`${F[k].u} in FROM can't be shown in the diagram.`, F[k].i, F[k].e);
    let al = null;
    if (F[k] && F[k].u === "AS" && F[k + 1] && F[k + 1].id) { al = F[k + 1]; k += 2; }
    else if (F[k] && F[k].id && !SQLKW.has(F[k].u) && !JOINWORDS.has(F[k].u)) { al = F[k]; k++; }
    if (al) it.alias = stripQ(al.t);
    else if (it.kind === "table") it.alias = it.name.toLowerCase();      // unaliased table: its name is its alias
    else { let n = 1; while (aliasMap.has("V" + n)) n++; it.alias = "v" + n; notes.push(`The subquery without a name was called ${it.alias}.`); }
    const AU = it.alias.toUpperCase();
    if (aliasMap.has(AU)) return err(`The name "${it.alias}" is used for two tables in FROM — give one of them another alias.`, al ? al.i : t0.i, al ? al.e : t0.e);
    aliasMap.set(AU, items.length); it.idx = items.length; items.push(it);
    return null;
  };
  let e0 = readItem("first", null); if (e0) return e0;
  while (k < F.length) {
    const u = F[k].u;
    if (u === ",") { k++; const e = readItem("comma", null); if (e) return e; continue; }
    let type = null; const jt = F[k];
    if (u === "JOIN") { type = "INNER"; k++; }
    else if (u === "INNER" && F[k + 1] && F[k + 1].u === "JOIN") { type = "INNER"; k += 2; }
    else if (["LEFT", "RIGHT", "FULL"].includes(u)) { type = u; k++; if (F[k] && F[k].u === "OUTER") k++; if (!F[k] || F[k].u !== "JOIN") return err(`JOIN is missing after ${u}.`, jt.i, jt.e); k++; }
    else if (u === "CROSS" && F[k + 1] && F[k + 1].u === "JOIN") { type = "CROSS"; k += 2; }
    else if (u === "NATURAL") return err("NATURAL JOIN can't be shown in the diagram — write it as JOIN … ON a.col = b.col.", jt.i, jt.e);
    else if ((u === "CROSS" || u === "OUTER") && F[k + 1] && F[k + 1].u === "APPLY") return err(`${u} APPLY can't be shown in the diagram.`, jt.i, F[k + 1].e);
    else return err(`Didn't expect "${F[k].t}" here in FROM.`, F[k].i, F[k].e);
    const e = readItem("join", type); if (e) return e;
    if (type === "CROSS") continue;
    const it = items[items.length - 1];
    if (F[k] && F[k].u === "USING") return err("JOIN … USING ( … ) can't be shown in the diagram — write it as ON a.col = b.col.", F[k].i, F[k].e);
    if (!F[k] || F[k].u !== "ON") return err(`The join to ${it.alias} needs an ON condition.`, jt.i, F[k - 1].e);
    k++;
    const s = k; let dd = 0;
    while (k < F.length) { const v = F[k].u; if (v === "(") dd++; else if (v === ")") dd--; else if (dd === 0 && (v === "," || JOINWORDS.has(v) && v !== "ON" && v !== "OUTER")) break; k++; }
    it.on = F.slice(s, k);
    if (!it.on.length) return err(`The ON condition of ${it.alias} is empty.`, F[s - 1].e);
  }

  /* column references */
  const colsOf = it => (it.kind === "derived" ? tCols({kind: "derived", sql: it.sql}) : knownCols(it.name)).cols.map(c => c.n);
  const refOf = toks => {
    if (toks.length === 3 && toks[0].id && toks[1].u === "." && toks[2].id && toks[2].t[0] !== '"') {
      const i = aliasMap.get(stripQ(toks[0].t).toUpperCase());
      return i == null ? null : {item: i, col: toks[2].u};
    }
    if (toks.length === 1 && toks[0].id && toks[0].t[0] !== '"' && !SQLKW.has(toks[0].u)) {
      const hits = items.filter(it => colsOf(it).includes(toks[0].u));
      if (hits.length === 1) return {item: hits[0].idx, col: toks[0].u, bare: true};
      if (hits.length > 1) notes.push(`${toks[0].u} exists in more than one table — qualify it (alias.${toks[0].u}) so the diagram can show it as a column.`);
    }
    return null;
  };
  const aggOfToks = toks => {
    if (toks.length < 4 || !["COUNT", "SUM", "MIN", "MAX", "AVG"].includes(toks[0].u) || toks[1].u !== "(" || matchIdx(toks, 1) !== toks.length - 1) return null;
    let inner = toks.slice(2, -1), dist = false;
    if (inner[0] && inner[0].u === "DISTINCT") { dist = true; inner = inner.slice(1); }
    if (toks[0].u === "COUNT" && !dist && inner.length === 1 && inner[0].u === "*") return {agg: "COUNT", item: 0, col: "*"};
    if (dist && toks[0].u !== "COUNT") return null;
    const r = refOf(inner); if (!r) return null;
    return {agg: dist ? "COUNT DISTINCT" : toks[0].u, item: r.item, col: r.col};
  };
  const itemsIn = toks => { const s = new Set(); for (let i = 0; i + 2 < toks.length; i++) if (toks[i].id && toks[i + 1].u === "." && toks[i + 2].id && !(toks[i - 1] && toks[i - 1].u === ".")) { const x = aliasMap.get(stripQ(toks[i].t).toUpperCase()); if (x != null) s.add(x); } return s; };

  /* SELECT list */
  const fields = [];
  let sel = range("SELECT"), distinct = false;
  if (sel[0] && (sel[0].u === "DISTINCT" || sel[0].u === "UNIQUE")) { distinct = true; sel = sel.slice(1); } else if (sel[0] && sel[0].u === "ALL") sel = sel.slice(1);
  if (!sel.length) return err("SELECT has no columns.", T[C.SELECT.k].e);
  for (const part of splitTop(sel)) {
    if (!part.length) return err("There is an empty item in the SELECT list (an extra comma?).", T[C.SELECT.k].e);
    let alias = "", toks = part;
    const last = part[part.length - 1], prev = part[part.length - 2];
    if (part.length >= 2 && last.id && !SQLKW.has(last.u) && !NON_ALIAS.has(last.u) && (prev.u === "AS" || !OPS.has(prev.u))) {
      alias = stripQ(last.t); toks = part.slice(0, prev.u === "AS" ? -2 : -1);
      if (!toks.length) return err("A SELECT item has an alias but no value.", last.i, last.e);
    }
    const f = {alias, output: true, agg: "", sort: "", sortOrder: "", filter: ""};
    if (toks.length === 1 && toks[0].u === "*") { items.forEach(it => fields.push({...f, item: it.idx, col: "*"})); continue; }
    if (toks.length === 3 && toks[2].u === "*" && toks[1].u === ".") {
      const i = aliasMap.get(stripQ(toks[0].t).toUpperCase());
      if (i == null) return err(`"${toks[0].t}" is not a table or alias in FROM.`, toks[0].i, toks[0].e);
      fields.push({...f, item: i, col: "*"}); continue;
    }
    const ag = aggOfToks(toks), rf = !ag && refOf(toks);
    if (ag) { fields.push({...f, item: ag.item, col: ag.col, agg: ag.agg}); if (!alias) notes.push(`${src(toks[0], toks[toks.length - 1])} got the alias ${ag.agg.replace(" ", "_")}_${ag.col === "*" ? "EXPR" : ag.col} (OTM needs a name for every column).`); }
    else if (rf) fields.push({...f, item: rf.item, col: rf.col});
    else { fields.push({...f, expr: src(toks[0], toks[toks.length - 1]), key: keyOf(toks)}); if (!alias) notes.push(`An expression without a name got the alias EXPR — rename it in the grid.`); }
  }
  const findField = (pred) => fields.find(pred);

  /* joins from ON */
  const joins = [];
  const jMap = new Map();
  const jFor = (a, b, type) => { const key = a + ">" + b; if (!jMap.has(key)) { const j = {a, b, type, pairs: [], extra: []}; jMap.set(key, j); joins.push(j); } return jMap.get(key); };
  const eqPair = c => {
    if (c.length < 3) return null;
    let op = -1, dd = 0;
    for (let i = 0; i < c.length; i++) { if (c[i].u === "(") dd++; else if (c[i].u === ")") dd--; else if (dd === 0 && c[i].u === "=") { op = i; break; } }
    if (op < 0) return null;
    const x = refOf(c.slice(0, op)), y = refOf(c.slice(op + 1));
    return x && y && x.item !== y.item ? {x, y} : null;
  };
  for (const it of items) {
    if (!it.on) continue;
    const N = it.idx;
    for (const c of conjuncts(it.on)) {
      const p = eqPair(c);
      if (p && (p.x.item === N || p.y.item === N)) {
        const other = p.x.item === N ? p.y : p.x, mine = p.x.item === N ? p.x : p.y;
        if (other.item < N) { jFor(other.item, N, it.type).pairs.push([other.col, mine.col]); continue; }
      }
      const refs = [...itemsIn(c)].filter(x => x !== N && x < N).sort((a, b) => a - b);
      const target = refs.length ? refs[0] : (joins.find(j => j.b === N) || {}).a ?? N - 1;
      jFor(target, N, it.type).extra.push(src(c[0], c[c.length - 1]));
    }
    if (!joins.some(j => j.b === N)) jFor(N - 1, N, it.type);
  }

  /* WHERE: old-style joins, (+) outer joins, filters, other conditions */
  const conds = [];
  const commaItems = new Set(items.filter(it => it.joinKind === "comma").map(it => it.idx));
  let convertedComma = false, convertedPlus = false;
  const attachFilter = (c, having) => {
    let op = -1, dd = 0;
    for (let i = 0; i < c.length; i++) {
      const u = c[i].u; if (u === "(") dd++; else if (u === ")") dd--; if (dd) continue;
      if (["=", "<>", "!=", "<", ">", "<=", ">="].includes(u) || ["LIKE", "IN", "BETWEEN", "IS"].includes(u) || (u === "NOT" && i > 0 && c[i + 1] && ["LIKE", "IN", "BETWEEN"].includes(c[i + 1].u))) { op = i; break; }
    }
    if (op <= 0 || c[0].u === "NOT" || c[0].u === "EXISTS") return false;
    const lhs = c.slice(0, op), rhs = c.slice(op);
    if (itemsIn(rhs).size) return false;                    // compares with another table → keep as a condition
    const filter = src(rhs[0], rhs[rhs.length - 1]);
    const ag = aggOfToks(lhs), rf = !ag && refOf(lhs);
    const lhsAgg = !!ag || (!rf && isAggExpr(src(lhs[0], lhs[lhs.length - 1])));
    if (lhsAgg !== having) return false;
    let f;
    if (ag) f = findField(x => !x.filter && x.agg === ag.agg && x.item === ag.item && x.col === ag.col) || (fields.push({item: ag.item, col: ag.col, agg: ag.agg, alias: "", output: false, sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]);
    else if (rf) f = findField(x => !x.filter && x.expr == null && (!x.agg || x.agg === "GROUP") && x.item === rf.item && x.col === rf.col) || (fields.push({item: rf.item, col: rf.col, alias: "", output: false, agg: "", sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]);
    else { const key = keyOf(lhs); f = findField(x => !x.filter && x.expr != null && x.key === key) || (fields.push({expr: src(lhs[0], lhs[lhs.length - 1]), key, alias: "", output: false, agg: "", sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]); }
    f.filter = filter;
    return true;
  };
  const W = range("WHERE");
  if (W) {
    if (!W.length) return err("WHERE has no condition.", T[C.WHERE.k].e);
    const plus = c => { const out = []; for (let i = 0; i + 2 < c.length; i++) if (c[i].u === "(" && c[i + 1].u === "+" && c[i + 2].u === ")") out.push(i); return out; };
    const noPlus = c => { const p = new Set(plus(c).flatMap(i => [i, i + 1, i + 2])); let s = ""; let last = null; for (let i = 0; i < c.length; i++) { if (p.has(i)) continue; s += last ? text.slice(last.e, c[i].i) : ""; s += text.slice(c[i].i, c[i].e); last = c[i]; } return s.replace(/\s+/g, " ").trim(); };
    const pending = [];
    for (const c of conjuncts(W)) {
      const pl = plus(c), text_ = src(c[0], c[c.length - 1]);
      if (pl.length) {                                     // Oracle (+) outer join → LEFT/RIGHT JOIN
        const opt = new Set(pl.map(i => c[i - 3] && c[i - 2] && c[i - 2].u === "." ? aliasMap.get(stripQ(c[i - 3].t).toUpperCase()) : null));
        if (opt.size !== 1 || [...opt][0] == null) return err("This (+) outer join is too complex for the diagram — rewrite it as LEFT JOIN … ON.", c[pl[0]].i, c[pl[0] + 2].e);
        const N = [...opt][0];
        if (items[N].joinKind === "join" || items.some(it => it.joinKind === "join")) return err("(+) can't be mixed with JOIN … ON in the same query (Oracle doesn't allow it either) — use LEFT JOIN … ON.", c[pl[0]].i, c[pl[0] + 2].e);
        const others = [...itemsIn(c)].filter(x => x !== N);
        if (others.length > 1) return err("A (+) condition links more than two tables — rewrite it as LEFT JOIN … ON.", c[0].i, c[c.length - 1].e);
        const cleanToks = c.filter((_, i) => !pl.some(q => i >= q && i <= q + 2));
        pending.push({N, M: others[0], pair: eqPair(cleanToks), extra: noPlus(c), text: noPlus(c), type: "LEFT"});
        convertedPlus = true; continue;
      }
      const refs = [...itemsIn(c)].sort((x, y) => x - y);
      if (refs.length === 2 && commaItems.has(refs[1])) {      // old-style join (tables listed with commas) → INNER JOIN
        const p = eqPair(c);
        pending.push({N: refs[1], M: refs[0], pair: p, extra: p ? null : text_, text: text_, type: "INNER"});
        continue;
      }
      if (!attachFilter(c, false)) conds.push({sql: text_, having: false});
    }
    const optional = new Set(pending.filter(p => p.type === "LEFT").map(p => p.N));
    const ordered = [...pending.filter(p => p.M != null), ...pending.filter(p => p.M == null)];
    for (const p of ordered) {
      if (p.type === "INNER" && optional.has(p.N)) { conds.push({sql: p.text, having: false}); continue; }   // a WHERE test on an outer-joined table stays in WHERE
      let j;
      if (p.M == null) {                                    // e.g.  b.qual(+) = 'BM'  → extra ON condition of b's join
        j = joins.find(x => x.a === p.N || x.b === p.N);
        if (!j) { conds.push({sql: p.text, having: false}); continue; }
        j.extra.push(p.extra); continue;
      }
      if (p.type === "LEFT") j = p.N > p.M ? jFor(p.M, p.N, "LEFT") : jFor(p.N, p.M, "RIGHT");
      else { j = jFor(p.M, p.N, "INNER"); convertedComma = true; }
      if (p.pair) { const a = p.pair.x.item === j.a ? p.pair.x : p.pair.y, b2 = a === p.pair.x ? p.pair.y : p.pair.x; j.pairs.push([a.col, b2.col]); }
      else j.extra.push(p.extra);
    }
  }
  if (convertedComma) notes.push("Tables listed with commas were turned into INNER JOIN … ON (same result).");
  if (convertedPlus) notes.push("(+) outer joins were turned into LEFT OUTER JOIN … ON (same result).");

  /* GROUP BY */
  const G = range("GROUP BY");
  if (G) {
    if (G.some(t => ["ROLLUP", "CUBE", "GROUPING"].includes(t.u))) return err("ROLLUP / CUBE / GROUPING SETS can't be shown in the diagram. Your SQL is kept and still runs.", G[0].i, G[G.length - 1].e);
    for (const g of splitTop(G)) {
      if (!g.length) return err("There is an empty item in GROUP BY (an extra comma?).", G[0].i);
      const rf = refOf(g);
      let f = rf ? findField(x => x.expr == null && x.item === rf.item && x.col === rf.col && (!x.agg || x.agg === "GROUP"))
                 : findField(x => x.expr != null && x.key === keyOf(g) && !isAggExpr(x.expr));
      if (!f) { f = rf ? {item: rf.item, col: rf.col} : {expr: src(g[0], g[g.length - 1]), key: keyOf(g)}; Object.assign(f, {alias: "", output: false, sort: "", sortOrder: "", filter: ""}); fields.push(f); }
      f.agg = "GROUP";
    }
  }
  /* HAVING */
  const Hv = range("HAVING");
  if (Hv) for (const c of conjuncts(Hv)) if (!attachFilter(c, true)) conds.push({sql: src(c[0], c[c.length - 1]), having: true});
  /* ORDER BY */
  const O = range("ORDER BY");
  if (O) {
    let n = 0;
    for (let o of splitTop(O)) {
      if (!o.length) return err("There is an empty item in ORDER BY (an extra comma?).", O[0].i);
      let nulls = "", dir = "";
      if (o.length > 2 && o[o.length - 2].u === "NULLS") { nulls = " NULLS " + o[o.length - 1].u; o = o.slice(0, -2); }
      if (["ASC", "DESC"].includes(o[o.length - 1].u)) { dir = o[o.length - 1].u; o = o.slice(0, -1); }
      if (!o.length) return err("ORDER BY item without a column.", O[0].i);
      const outs = fields.filter(f => f.output);
      let f = null;
      if (o.length === 1 && /^\d+$/.test(o[0].t)) { f = outs[+o[0].t - 1]; if (!f) return err(`ORDER BY ${o[0].t}: there is no column number ${o[0].t}.`, o[0].i, o[0].e); }
      else if (o.length === 1 && o[0].id) f = outs.find(x => x.alias && x.alias.toUpperCase() === stripQ(o[0].t).toUpperCase());
      if (!f) {
        const ag = aggOfToks(o), rf = !ag && refOf(o);
        if (ag) f = findField(x => x.agg === ag.agg && x.item === ag.item && x.col === ag.col) || (fields.push({item: ag.item, col: ag.col, agg: ag.agg, alias: "", output: false, sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]);
        else if (rf) f = findField(x => x.expr == null && x.item === rf.item && x.col === rf.col && (!x.agg || x.agg === "GROUP")) || (fields.push({item: rf.item, col: rf.col, alias: "", output: false, agg: "", sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]);
        else { const key = keyOf(o); f = findField(x => x.expr != null && x.key === key) || (fields.push({expr: src(o[0], o[o.length - 1]), key, alias: "", output: false, agg: "", sort: "", sortOrder: "", filter: ""}), fields[fields.length - 1]); }
      }
      if (f.sort) continue;
      f.sort = (dir || "ASC") + nulls; f.sortOrder = String(++n);
    }
  }
  return {model: {
    tables: items.map(it => ({kind: it.kind, name: it.name, owner: it.owner, alias: it.alias, sql: it.sql})),
    joins: joins.map(j => ({a: j.a, b: j.b, type: j.type || "INNER", pairs: j.pairs, extra: j.extra.filter(Boolean).join(" AND ")})),
    fields, conds, distinct}};
}

/* ---------- model → DESIGN (keeps box positions) ---------- */
function applyParsed(m) {
  const old = DESIGN.tables, used = new Set();
  const same = (pt, t) => pt.kind === "derived" ? isDerived(t) : (!isDerived(t) && t.name === pt.name);
  const tables = m.tables.map(pt => {
    let o = old.find(t => !used.has(t.id) && t.alias.toUpperCase() === pt.alias.toUpperCase() && same(pt, t))
         || old.find(t => !used.has(t.id) && same(pt, t) && (pt.kind !== "derived" || normSql(t.sql) === normSql(pt.sql)) && !m.tables.some(q => q !== pt && q.alias.toUpperCase() === t.alias.toUpperCase()));
    if (o) used.add(o.id);
    const t = {id: o ? o.id : nid(), name: pt.kind === "derived" ? "SUBQUERY" : pt.name, alias: pt.alias, x: o ? o.x : null, y: o ? o.y : null, filter: o ? o.filter || "" : ""};
    if (pt.owner) t.owner = pt.owner;
    if (pt.kind === "derived") { t.kind = "derived"; t.sql = pt.sql; }
    t._new = !o; return t;
  });
  const joins = m.joins.map(j => {
    const A = tables[j.a], B = tables[j.b];
    let edge = null, src = "manual";
    if (!isDerived(A) && !isDerived(B) && j.pairs.length) for (const ei of alternatives(A.name, B.name)) {
      const ep = edgePairs(ei, A.name);
      if (ep.length === j.pairs.length && ep.every(p => j.pairs.some(q => q[0] === p[0] && q[1] === p[1]))) { edge = ei; src = SCHEMA.edges[ei].src; break; }
    }
    return {id: nid(), a: A.id, b: B.id, pairs: j.pairs, edge, type: j.type, src, extra: j.extra || ""};
  });
  // place new boxes next to a table they join to, without overlapping
  const placed = tables.filter(t => t.x != null);
  const hOf = t => { const el = document.querySelector(`.dbox[data-tid="${t.id}"]`); return el ? el.offsetHeight : 300; };
  const overlaps = (x, y) => placed.some(p => x < p.x + 270 && p.x < x + 270 && y < p.y + hOf(p) + 20 && p.y < y + 300);
  tables.forEach((t, i) => {
    if (t.x != null) return;
    const j = joins.find(x => (x.b === t.id && tables.find(q => q.id === x.a).x != null) || (x.a === t.id && tables.find(q => q.id === x.b).x != null));
    const partner = j ? tables.find(q => q.id === (j.a === t.id ? j.b : j.a)) : null;
    let x = partner ? partner.x + 310 : (placed.length ? Math.max(...placed.map(p => p.x)) + 310 : 30), y = partner ? partner.y : 20;
    if (!placed.length && i === 0) { x = 30; y = 20; }
    while (overlaps(x, y)) y += 40;
    t.x = x; t.y = y; placed.push(t);
  });
  const fields = m.fields.map(f => {
    const o = {id: nid(), tid: f.item != null ? tables[f.item].id : null, col: f.item != null ? f.col : null, alias: f.alias || "", output: f.output !== false, agg: f.agg || "", sort: f.sort || "", sortOrder: f.sortOrder || "", filter: f.filter || ""};
    if (f.expr != null) o.expr = f.expr;
    return o;
  });
  const added = tables.filter(t => t._new);
  tables.forEach(t => delete t._new);
  DESIGN.tables = tables; DESIGN.joins = joins; DESIGN.fields = fields;
  DESIGN.conds = m.conds.map(c => ({id: nid(), sql: c.sql, having: !!c.having}));
  DESIGN.distinct = !!m.distinct;
  return added;
}

/* ---------- the SQL pane ---------- */
function dsqlSet(v) {
  DS.setting = true;
  const sc = DS.ed.getScrollInfo();
  DS.ed.setValue(v); DS.ed.scrollTo(sc.left, sc.top);
  DS.setting = false;
}
function dsqlRefresh() {
  if (!DS.ed) return;
  if (DESIGN.customSql != null) { if (!DS.dirty && DS.ed.getValue() !== DESIGN.customSql) dsqlSet(DESIGN.customSql); dsqlState(); return; }
  if (DS.dirty) return;                       // never overwrite what you are typing
  const gen = dBuildSql() || "";
  DS.lastGen = gen;
  if (DS.ed.getValue() !== gen) dsqlSet(gen);
  dsqlState();
  if ($("#tab-design").classList.contains("active")) setTimeout(() => DS.ed.refresh(), 0);
}
function dsqlClearMarks() { DS.marks.forEach(m => m.clear()); DS.marks = []; }
function dsqlState() {
  const el = $("#dSqlState"); if (!el) return;
  $("#dSqlApply").style.display = DS.dirty ? "" : "none";
  if (DESIGN.customSql != null) {
    el.innerHTML = `<div class="msg err">⚠ ${esc(DESIGN.customErr || "The diagram can't show this SQL.")}<br><span class="small">Your SQL is kept exactly as written — Run, Copy and Open in Query Runner use it.</span>
      <div style="margin-top:6px">${DESIGN.customFix === "dropSteps" ? '<button class="btn small" data-ds="dropSteps">Remove the steps and use my SQL</button>' : ""}<button class="btn small" data-ds="revert">Discard my SQL and go back to the diagram</button></div></div>`;
    $("#dLockMsg").innerHTML = `The diagram is paused because the SQL below uses something it can't show. <a href="#" data-ds="revert">Go back to the diagram's SQL</a>`;
  } else if (DS.dirty) {
    el.innerHTML = `<div class="msg info">Edited — the diagram updates when you click outside the SQL box. <button class="btn small" data-ds="apply">Update diagram</button><button class="btn small" data-ds="discard">Discard edits</button></div>`;
  } else if (!DS.ed.getValue().trim()) {
    el.innerHTML = `<div class="small muted">Tip: type or paste a SELECT here and click outside the box — the diagram is built from it.</div>`;
  } else el.innerHTML = DS.note;
}
function dsqlApply() {
  if (!DS.ed) return true;
  const text = DS.ed.getValue();
  DS.dirty = false; dsqlClearMarks();
  if (DESIGN.customSql == null && normSql(text) === normSql(DS.lastGen)) { DS.note = ""; dsqlRefresh(); return true; }
  if (!text.trim()) {
    if (DESIGN.tables.length && !confirm("The SQL box is empty. Clear the diagram?")) { DS.note = ""; DESIGN.customSql = null; dsqlRefresh(); return true; }
    const steps = DESIGN.steps; DESIGN = dNewDesign(); if (steps && steps.length && confirm("Keep the steps?")) DESIGN.steps = steps;
    DS.note = ""; render(); renderSteps(); dSave(); return true;
  }
  let r;
  try { r = parseDesignerSql(text); } catch (e) { r = {error: "The designer couldn't read this SQL (" + e.message + ")."}; }
  if (r.error) {
    DESIGN.customSql = text; DESIGN.customErr = r.error + (r.at != null ? ` (line ${DS.ed.posFromIndex(r.at).line + 1})` : ""); DESIGN.customFix = r.fix || null;
    if (r.at != null) {
      let ai = r.at, bi = Math.max(r.at + 1, r.end || 0);
      if (!text.slice(ai, bi).trim()) {                   // error at a line end → underline the word before it
        let q = Math.min(ai, text.length) - 1; while (q > 0 && /\s/.test(text[q])) q--;
        bi = q + 1; ai = q; while (ai > 0 && /[\w$#.()']/.test(text[ai - 1])) ai--;
      }
      const a = DS.ed.posFromIndex(ai), b = DS.ed.posFromIndex(bi);
      DS.marks.push(DS.ed.markText(a, b, {className: "ed-err", attributes: {title: r.error}}));
      DS.ed.scrollIntoView(a, 60);
    }
    dSave(); render(); dsqlState();
    return false;
  }
  DS.undo = JSON.stringify(DESIGN);
  const added = applyParsed(r.model);
  DESIGN.customSql = null; DESIGN.customErr = null; DESIGN.customFix = null;
  const notes = [...new Set(r.notes)];
  added.filter(isDerived).forEach(t => notes.unshift(`Added the subquery ${t.alias} to the diagram as a derived table.`));
  DS.note = `<div class="msg ok">✓ Diagram updated from your SQL.${notes.length ? "<br>" + notes.map(n => "• " + esc(n)).join("<br>") : ""} <button class="btn small" data-ds="undo">Undo</button></div>`;
  render(); renderSteps(); dSave();
  Promise.all(added.filter(t => !isDerived(t)).map(t => loadCols(t.name).catch(() => false))).then(x => { if (x.some(Boolean)) render(); });
  return true;
}
function dsqlApplyIfDirty() { if (DS.dirty) dsqlApply(); }
function editDerived(t, ev) {
  document.querySelectorAll(".dpop").forEach(p => p.remove());
  const pop = document.createElement("div"); pop.className = "dpop"; pop.style.width = "560px";
  pop.style.left = Math.max(10, t.x) + "px"; pop.style.top = (t.y + 34) + "px";
  pop.innerHTML = `<h4>Subquery <span class="mono" style="color:var(--violet)">${esc(t.alias)}</span></h4>
    <textarea rows="11" style="width:100%;font-size:12px">${esc(t.sql)}</textarea>
    <div class="small muted" style="margin:6px 0">Its output columns become the box's columns — give every expression an alias.</div>
    <div class="row" style="justify-content:flex-end"><button class="btn small" data-a="cancel">Cancel</button><button class="btn small primary" data-a="ok">Save</button></div><div class="pmsg"></div>`;
  $("#dCanvas").appendChild(pop);
  const ta = pop.querySelector("textarea"); ta.focus();
  pop.querySelector('[data-a="cancel"]').onclick = () => pop.remove();
  pop.querySelector('[data-a="ok"]').onclick = () => {
    const v = ta.value.trim().replace(/;\s*$/, "");
    if (!/^\(?\s*(SELECT|WITH)\b/i.test(maskSql(v).trim())) { pop.querySelector(".pmsg").innerHTML = '<div class="msg err">A subquery must start with SELECT (or WITH).</div>'; return; }
    t.sql = v; pop.remove(); render(); dSave();
  };
}
function renderConds() {
  const el = $("#dConds"); if (!el) return;
  const C = DESIGN.conds || [];
  el.innerHTML = `<div class="dconds">${C.length ? "<h3>Other conditions</h3>" : ""}${C.map(c => `<div class="dcond" data-c="${c.id}">
      <select data-k="having"><option value="0"${c.having ? "" : " selected"}>WHERE</option><option value="1"${c.having ? " selected" : ""}>HAVING</option></select>
      <input type="text" data-k="sql" value="${esc(c.sql)}" spellcheck="false"><span class="rb" data-a="rm" title="Remove">✕</span></div>`).join("")}
    <button class="btn small" id="dAddCond">+ Add condition</button> <span class="small muted">for OR groups, EXISTS, comparing two tables and anything the Filter column can't hold</span></div>`;
  el.querySelectorAll("[data-c]").forEach(row => {
    const c = C.find(x => x.id === +row.dataset.c);
    row.querySelector('[data-k="sql"]').oninput = e => { c.sql = e.target.value; renderDSql(); dSave(); };
    row.querySelector('[data-k="having"]').onchange = e => { c.having = e.target.value === "1"; renderDSql(); dSave(); };
    row.querySelector('[data-a="rm"]').onclick = () => { DESIGN.conds = C.filter(x => x !== c); renderConds(); renderDSql(); dSave(); };
  });
  $("#dAddCond").onclick = () => { DESIGN.conds.push({id: nid(), sql: "", having: false}); renderConds(); const ins = el.querySelectorAll('[data-k="sql"]'); ins[ins.length - 1].focus(); };
}
(function initDsql() {
  if (typeof CodeMirror === "undefined") return;
  DS.ed = CodeMirror.fromTextArea($("#dSqlEd"), {
    mode: "text/x-otmsql", theme: "otm", lineNumbers: true, matchBrackets: true, autoCloseBrackets: "()''\"\"",
    indentUnit: 2, tabSize: 2, smartIndent: false,
    extraKeys: {
      "Ctrl-Enter": () => { dsqlApplyIfDirty(); $("#dRun").click(); }, "Cmd-Enter": () => { dsqlApplyIfDirty(); $("#dRun").click(); },
      "Ctrl-S": () => dsqlApply(), "Cmd-S": () => dsqlApply(),
      "Ctrl-Space": cm => cm.showHint({hint: sqlHint, completeSingle: false, explicit: true}),
      "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment",
      "Tab": cm => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("  ", "end")
    },
    hintOptions: {hint: sqlHint, completeSingle: false}
  });
  DS.ed.addOverlay(tableOverlay);
  DS.ed.on("change", () => { if (DS.setting) return; DS.dirty = true; DS.note = ""; dsqlClearMarks(); dsqlState(); });
  DS.ed.on("blur", () => setTimeout(() => { if (DS.ed.hasFocus() || DS.ed.state.completionActive) return; if (DS.dirty) dsqlApply(); }, 200));
  DS.ed.on("inputRead", (cm, ch) => {
    if (ch.origin !== "+input" || cm.state.completionActive) return;
    const t = ch.text.join(""), {word} = wordAt(cm);
    if (/string|comment/.test(cm.getTokenAt(cm.getCursor()).type || "")) return;
    if (t === "." || (/^[\w$#]$/.test(t) && word.length >= 2 && !/^\d+$/.test(word))) cm.showHint({hint: sqlHint, completeSingle: false});
  });
  new ResizeObserver(() => DS.ed.refresh()).observe($("#dSqlWrap"));
  $("#dSqlApply").onclick = () => dsqlApply();
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-ds]"); if (!b) return;
    e.preventDefault();
    const a = b.dataset.ds;
    if (a === "apply") dsqlApply();
    if (a === "discard" || a === "revert") { DS.dirty = false; DESIGN.customSql = null; DESIGN.customErr = null; DS.note = ""; dsqlClearMarks(); render(); dSave(); }
    if (a === "dropSteps") { const t = DESIGN.customSql; DESIGN.steps = []; DESIGN.customSql = null; renderSteps(); DS.lastGen = ""; dsqlSet(t); DS.dirty = true; dsqlApply(); }
    if (a === "undo" && DS.undo) { DESIGN = JSON.parse(DS.undo); dNorm(); DS.undo = null; DS.note = ""; render(); renderSteps(); dSave(); }
  });
  dsqlRefresh();
})();
