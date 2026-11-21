#!/usr/bin/env python3
"""
OTM Schema Explorer - local helper.

Unofficial tool, not affiliated with or endorsed by Oracle. Oracle, Oracle Transportation Management
and OTM are trademarks of Oracle and/or its affiliates.

Runs on your own computer, serves the explorer page on http://127.0.0.1:8765 and sends read-only SQL
to your OTM instance through OTM's DB.XML servlet
(/GC3/glog.integration.servlet.DBXMLServlet?command=xmlExport) with Basic Auth.

- Needs only Python 3.9+ (no pip installs).
- Passwords are kept in memory only, never written to disk.
- Only SELECT / WITH statements are sent.
- Only the browser opened with the launch link can use the page (see SECURITY.md).

Usage:
    python otm_explorer.py              # opens your browser with a one-time launch link
    python otm_explorer.py --port 9000
    python otm_explorer.py --no-browser # just print the link
Optional environment variables to pre-fill the connection:
    OTM_URL=https://xxxx.otmgtm.region.ocs.oraclecloud.com  OTM_USER=DOMAIN.USER  OTM_PASS=...

MIT licence - https://github.com/Omar-Mosbah/otm-schema-explorer
The page bundles CodeMirror 5 and sql-formatter (both MIT); their licence texts are inside the page.
"""
import argparse
import base64
import json
import os
import re
import secrets
import socket
import ssl
import threading
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(HERE, "otm_explorer.html")
CACHE_FILE = os.path.join(HERE, "otm_schema_cache.json")
SAVED_FILE = os.path.join(HERE, "otm_saved_queries.json")
DEFAULT_SERVLET = "/GC3/glog.integration.servlet.DBXMLServlet?command=xmlExport"
ROOT_NAME = "R"
VERSION = "1.10.0-beta.1"

# Access control (see SECURITY.md)
#  - LAUNCH key: in the link the helper opens/prints. Single use: the first browser that opens it gets
#    the SESSION cookie (HttpOnly, SameSite=Strict); the key is then spent. Press Enter in the helper
#    window for a new link.
#  - SESSION cookie: required for the page and every API call, so other programs or other users on the
#    same computer can't read the page or use your OTM session.
#  - TOKEN: embedded in the page and sent as the X-Token header, which blocks cross-site requests.
TOKEN = secrets.token_urlsafe(24)
SESSION = secrets.token_urlsafe(32)
LAUNCH = {"key": secrets.token_urlsafe(18), "reusable": False}
PORT = {"n": 8765}
CONN = {"url": None, "user": None, "password": None, "servlet": DEFAULT_SERVLET, "insecure": False}
SESSIONS = {}   # profile id -> connection dict (passwords live in memory only, one per environment)

FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|RENAME|"
    r"EXECUTE|EXEC|BEGIN|DECLARE|CALL|COMMIT|ROLLBACK|LOCK|COMMENT|PURGE|FLASHBACK)\b",
    re.I,
)


# ----------------------------------------------------------------- SQL guard
def strip_sql(sql: str) -> str:
    """Remove comments and string literals (for keyword checks only)."""
    s = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    s = re.sub(r"--[^\n]*", " ", s)
    s = re.sub(r"'(?:[^']|'')*'", "''", s)
    s = re.sub(r'"(?:[^"])*"', '""', s)
    return s


def check_read_only(sql: str) -> str:
    sql = sql.strip().rstrip(";").strip()
    bare = strip_sql(sql).strip()
    if not re.match(r"^\(?\s*(SELECT|WITH)\b", bare, re.I):
        raise ValueError("Only SELECT or WITH queries are allowed (read-only tool).")
    if ";" in bare:
        raise ValueError("Only one statement at a time (remove the ';').")
    m = FORBIDDEN.search(bare)
    if m:
        raise ValueError(f"Blocked keyword '{m.group(1).upper()}' - this tool is read-only.")
    return sql


# ----------------------------------------------------------------- OTM call
def ssl_ctx(conn=None):
    if (conn or CONN)["insecure"]:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context()


QUERY_TIMEOUT = 300   # seconds the helper waits for OTM


def call_dbxml(statement: str, timeout: int = QUERY_TIMEOUT, conn=None, timing=None) -> bytes:
    c = conn or CONN
    if not c["url"]:
        raise ValueError("Not connected. Enter your OTM URL and credentials first.")
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<sql2xml><Query>'
        f"<RootName>{ROOT_NAME}</RootName>"
        f"<Statement>{escape(statement)}</Statement>"
        "</Query><FootPrint>Y</FootPrint></sql2xml>"
    ).encode("utf-8")
    url = c["url"].rstrip("/") + c["servlet"]
    auth = base64.b64encode(f'{c["user"]}:{c["password"]}'.encode()).decode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "text/xml", "Authorization": "Basic " + auth},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_ctx(c)) as r:
            t1 = time.perf_counter()               # OTM has answered (database + building the XML)
            data = r.read()
            if timing is not None:
                timing.update(otmMs=int((t1 - t0) * 1000), recvMs=int((time.perf_counter() - t1) * 1000), bytes=len(data))
            return data
    except urllib.error.HTTPError as e:
        txt = e.read()[:1500].decode("utf-8", "replace")
        if e.code in (413, 502, 503, 504) or re.search(r"too large|exceed|10 ?MB|size limit", txt, re.I):
            raise ValueError(f"OTM returned HTTP {e.code}. If the result is big, it may have hit OTM's 10 MB limit for "
                             "DB.XML replies (or a gateway time-out) - select fewer columns or rows.\n" + txt[:600])
        if e.code in (401, 403):
            raise ValueError(f"OTM rejected the login (HTTP {e.code}). Check user (DOMAIN.USER) and password, "
                             "and that the user can use the DB.XML servlet.")
        raise ValueError(f"OTM returned HTTP {e.code}: {txt}")
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)) or "timed out" in str(e.reason):
            raise ValueError(_timeout_msg(timeout))
        raise ValueError(f"Could not reach OTM: {e.reason}")
    except (TimeoutError, socket.timeout):          # socket.timeout is not a TimeoutError before Python 3.10
        raise ValueError(_timeout_msg(timeout))


def _timeout_msg(timeout):
    wait = f"{timeout // 60} minutes" if timeout >= 120 else f"{timeout} seconds"
    return (f"OTM did not answer within {wait}, so the helper stopped waiting "
            "(the query may still be running inside OTM). Use Diagnose to see why it is slow, "
            "or narrow it down with more filters.")


ATTR_RE = re.compile(r'([^\s=/<>"]+)\s*=\s*"([^"]*)"')
COMMENT_RE = re.compile(r"<!--(.*?)-->", re.S)
ORA_RE = re.compile(r"((?:ORA|PLS)-\d{5}[^\n<]*)")


def _unescape(v: str) -> str:
    return (v.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&#10;", "\n").replace("&#13;", "\r").replace("&amp;", "&"))


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].split(":")[-1]


def parse_rows(raw: bytes):
    """Read OTM's xml2sql reply. Handles namespaced replies (<dbxml:xml2sql>, OTM 26c+)
    and the 'NO DATA' answer for empty results."""
    text = raw.decode("utf-8", "replace")
    rows = []
    # OTM reports SQL errors as an XML comment, e.g.
    #   <sql2xml><!-- DatabaseError error: ORA-00942: table or view does not exist ... --></sql2xml>
    # ElementTree drops comments, so without this an error would look like an empty result.
    for m in COMMENT_RE.finditer(text):
        c = m.group(1).strip()
        if ORA_RE.search(c) or re.search(r"DatabaseError|SQLException|Exception", c):
            raise ValueError("Oracle error: " + c[:1500])
    try:
        root = ET.fromstring(raw)
        for el in root.iter():
            if _local(el.tag) == ROOT_NAME:
                rows.append({_local(k): v for k, v in el.attrib.items()})
        if not rows:
            names = {_local(el.tag) for el in root.iter()}
            for el in root.iter():
                if _local(el.tag).upper() == "ERROR":
                    raise ValueError("OTM error: " + "".join(el.itertext())[:1500])
            if "TRANSACTION_SET" not in names and _local(root.tag) not in ("xml2sql", "sql2xml"):
                raise ValueError("Unexpected response from OTM:\n" + text[:1500])
            # otherwise: a valid, empty result ("NO DATA")
    except ET.ParseError:
        # OTM can return invalid XML when a column name is not a valid XML name
        # (e.g. COUNT(*) without an alias). Try a tolerant regex parse.
        for m in re.finditer(r"<(?:[\w.-]+:)?%s\s([^>]*?)/?>" % ROOT_NAME, text):
            rows.append({_local(k): _unescape(v) for k, v in ATTR_RE.findall(m.group(1))})
        if not rows and "<html" in text.lower():
            raise ValueError("OTM returned an HTML page instead of XML (wrong URL or login page?).\n" + text[:600])
        if not rows and "TRANSACTION_SET" not in text:
            raise ValueError("Could not read OTM response. Tip: give every expression a simple alias "
                             "(e.g. COUNT(*) AS CNT).\n" + text[:1500])
    cols = []
    seen = set()
    for r in rows:
        for k in r:
            if k not in seen:
                seen.add(k)
                cols.append(k)
    return cols, [[r.get(c) for c in cols] for r in rows]


def run_query(sql: str, max_rows: int, conn=None):
    sql = check_read_only(sql)
    max_rows = max(1, min(int(max_rows or 500), 250000))
    wrapped = f"SELECT * FROM (\n{sql}\n) WHERE ROWNUM <= {max_rows + 1}"
    t0 = time.time()
    timing = {}
    raw = call_dbxml(wrapped, conn=conn, timing=timing)
    p0 = time.perf_counter()
    cols, rows = parse_rows(raw)
    timing["parseMs"] = int((time.perf_counter() - p0) * 1000)
    truncated = len(rows) > max_rows
    return {
        "columns": cols,
        "rows": rows[:max_rows],
        "truncated": truncated,
        "elapsedMs": int((time.time() - t0) * 1000),
        "timing": timing,
    }


def check_sql(sql: str, conn=None):
    """Let Oracle parse + validate the query without fetching rows."""
    try:
        sql = check_read_only(sql)
    except ValueError as e:
        return {"ok": False, "error": str(e), "local": True}
    t0 = time.time()
    try:
        parse_rows(call_dbxml(f"SELECT * FROM (\n{sql}\n) WHERE 1 = 0", timeout=90, conn=conn))
    except ValueError as e:
        text = str(e)
        oras = []
        for o in ORA_RE.findall(text):
            o = o.strip().rstrip("-").strip()
            if o not in oras:
                oras.append(o)
        return {"ok": False, "error": oras[0] if oras else text[:1500], "ora": oras, "raw": text[:1500],
                "elapsedMs": int((time.time() - t0) * 1000)}
    return {"ok": True, "elapsedMs": int((time.time() - t0) * 1000)}


def conn_for(body):
    """Each request names the environment (profile) the page is showing, so a query can never
    silently go to another instance after a switch."""
    pid = body.get("profile")
    if pid:
        if pid in SESSIONS:
            return SESSIONS[pid]
        raise ValueError("Not connected to this environment yet - open the Connection tab and enter its password.")
    return CONN


# ----------------------------------------------------------------- built-in schema
# The schema can be stored inside this file (EMBEDDED_SCHEMA at the bottom), so the tool starts
# with your instance's tables on any computer. Load order: local cache file > built-in > starter pack.
_EMB = {"obj": None}


def _b64z(data: bytes) -> str:
    return base64.b64encode(zlib.compress(data, 9)).decode()


def _unb64z(text: str) -> bytes:
    return zlib.decompress(base64.b64decode(text))


def embedded_schema_bytes():
    return _unb64z(EMBEDDED_SCHEMA) if EMBEDDED_SCHEMA else None


def _summary(obj):
    if not isinstance(obj, dict):
        return None
    m = obj.get("meta") or {}
    edges = obj.get("edges") or []
    cols = obj.get("columns") or {}
    tables = set(obj.get("tables") or []) | set(cols) | {e.get("c") for e in edges} | {e.get("p") for e in edges}
    tables.discard(None)
    return {"source": m.get("source", ""), "builtInAt": m.get("builtInAt", ""), "tables": len(tables),
            "links": len(edges), "colTables": len(cols)}


def schema_info():
    local = None
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                local = _summary(json.load(f))
            local["mtime"] = int(os.path.getmtime(CACHE_FILE) * 1000)
            local["bytes"] = os.path.getsize(CACHE_FILE)
        except Exception as e:  # noqa
            local = {"error": str(e)}
    emb = None
    if EMBEDDED_SCHEMA:
        if _EMB["obj"] is None:
            _EMB["obj"] = _summary(json.loads(embedded_schema_bytes()))
        emb = dict(_EMB["obj"])
        emb["bytes"] = len(EMBEDDED_SCHEMA)
    me = os.path.abspath(__file__)
    return {"local": local, "embedded": emb, "using": "local" if local else ("embedded" if emb else "starter"),
            "file": os.path.basename(me), "folder": os.path.dirname(me),
            "writable": os.access(me, os.W_OK) and os.access(os.path.dirname(me), os.W_OK)}


def _py_block(name: str, b64: str) -> str:
    lines = [b64[i:i + 120] for i in range(0, len(b64), 120)] or [""]
    return name + " = (\n" + "\n".join('    "%s"' % ln for ln in lines) + "\n)"


def _replace_block(src: str, name: str, b64: str) -> str:
    start = src.index("\n" + name + " = (\n") + 1
    end = src.index("\n)", start) + 2
    return src[:start] + _py_block(name, b64) + src[end:]


def _schema_for_embedding() -> bytes:
    if not os.path.exists(CACHE_FILE):
        raise ValueError("There is no synced schema to build in yet. Run Schema Data → Sync now first.")
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        obj = json.load(f)
    if not (obj.get("edges") or obj.get("tables")):
        raise ValueError("The current schema is empty - nothing to build in.")
    obj.setdefault("meta", {})["builtInAt"] = time.strftime("%Y-%m-%d %H:%M")
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


def source_with_schema(data: bytes) -> str:
    with open(os.path.abspath(__file__), "r", encoding="utf-8") as f:
        src = f.read()
    return _replace_block(src, "EMBEDDED_SCHEMA", _b64z(data))


def embed_schema():
    global EMBEDDED_SCHEMA
    me = os.path.abspath(__file__)
    data = _schema_for_embedding()
    new = source_with_schema(data)
    compile(new, me, "exec")            # never write a broken file
    tmp = me + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    os.replace(tmp, me)
    EMBEDDED_SCHEMA = _b64z(data)
    _EMB["obj"] = None
    return {"ok": True, "file": me, "kb": round(os.path.getsize(me) / 1024), "summary": _summary(json.loads(data))}


# ----------------------------------------------------------------- saved queries
# Kept in otm_saved_queries.json next to this script. Every change is one small operation done under a
# lock (read - change - write to a temp file - rename), so two browser tabs can't overwrite each other.
SAVED_LOCK = threading.Lock()


def saved_load():
    if not os.path.exists(SAVED_FILE):
        return {"format": "otm-explorer-saved-queries", "version": 1, "items": []}
    with open(SAVED_FILE, "r", encoding="utf-8") as f:
        try:
            d = json.load(f)
        except ValueError:
            raise ValueError("otm_saved_queries.json is damaged, so it was not changed. Fix it, or rename it to start a new list.")
    if not isinstance(d, dict) or not isinstance(d.get("items"), list):
        raise ValueError("otm_saved_queries.json has an unexpected layout, so it was not changed.")
    return d


def _clean_item(it):
    if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not str(it.get("name", "")).strip() or not isinstance(it.get("sql"), str):
        raise ValueError("A saved query needs an id, a name and SQL.")
    keep = ("id", "name", "folder", "desc", "sql", "design", "fav", "created", "updated")
    out = {k: it[k] for k in keep if k in it}
    out["name"] = str(out["name"]).strip()[:120]
    out["folder"] = str(out.get("folder") or "").strip()[:80]
    if len(json.dumps(out)) > 2_000_000:
        raise ValueError("This query is too large to save.")
    return out


def saved_info():
    d = saved_load()
    return {"items": d["items"], "file": SAVED_FILE,
            "writable": os.access(HERE, os.W_OK) and (not os.path.exists(SAVED_FILE) or os.access(SAVED_FILE, os.W_OK))}


def saved_op(body):
    with SAVED_LOCK:
        d = saved_load()
        items = d["items"]
        op = body.get("op")
        result = {}
        if op == "upsert":
            it = _clean_item(body.get("item"))
            for i, x in enumerate(items):
                if x.get("id") == it["id"]:
                    items[i] = it
                    break
            else:
                items.append(it)
        elif op == "delete":
            items = [x for x in items if x.get("id") != body.get("id")]
        elif op == "import":
            added = updated = skipped = 0
            byid = {x.get("id"): i for i, x in enumerate(items)}
            for raw in body.get("items") or []:
                try:
                    it = _clean_item(raw)
                except ValueError:
                    skipped += 1
                    continue
                if it["id"] in byid:
                    cur = items[byid[it["id"]]]
                    if str(it.get("updated", "")) > str(cur.get("updated", "")):
                        items[byid[it["id"]]] = it
                        updated += 1
                    else:
                        skipped += 1
                else:
                    byid[it["id"]] = len(items)
                    items.append(it)
                    added += 1
            result = {"added": added, "updated": updated, "skipped": skipped}
        else:
            raise ValueError("Unknown operation.")
        d["items"] = items
        d.setdefault("format", "otm-explorer-saved-queries")
        d.setdefault("version", 1)
        tmp = SAVED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        os.replace(tmp, SAVED_FILE)
        result.update(ok=True, items=items)
        return result


# ----------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "OTMExplorer/1.0"

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("  %s\n" % (fmt % args))
        except Exception:
            pass

    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1")

    def _cookie_ok(self):
        name = cookie_name()
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name and secrets.compare_digest(v.encode(), SESSION.encode()):
                return True
        return False

    def _send(self, code, payload, ctype="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            self._get()
        except Exception:
            import traceback
            tb = traceback.format_exc()
            sys.stderr.write(tb)
            try:
                self._send(500, ("<h3>OTM Explorer error</h3><pre>%s</pre>" % escape(tb)).encode(), "text/html; charset=utf-8")
            except Exception:
                pass

    def _get(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html"):
            key = urllib.parse.parse_qs(query).get("k", [""])[0]
            if key:
                if LAUNCH["key"] and secrets.compare_digest(key.encode(), LAUNCH["key"].encode()):
                    if not LAUNCH["reusable"]:
                        LAUNCH["key"] = None                       # spent
                    self.send_response(303)
                    self.send_header("Set-Cookie", f"{cookie_name()}={SESSION}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000")
                    self.send_header("Location", "/")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self._cookie_ok():                              # old link, but this browser is already in
                    self.send_response(303)
                    self.send_header("Location", "/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self._send(403, LOCKED_PAGE.encode("utf-8"), "text/html; charset=utf-8")
            if not self._cookie_ok():
                return self._send(403, LOCKED_PAGE.encode("utf-8"), "text/html; charset=utf-8")
            html = load_html().replace("__API_TOKEN__", TOKEN)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        if not self._auth():
            return
        if self.path == "/api/status":
            return self._send(200, {"connected": bool(CONN["url"]) or bool(SESSIONS), "url": CONN["url"], "user": CONN["user"],
                                    "servlet": CONN["servlet"], "sessions": sorted(SESSIONS),
                                    "envUrl": os.environ.get("OTM_URL", ""), "envUser": os.environ.get("OTM_USER", "")})
        if self.path == "/api/schema-cache":
            if os.path.exists(CACHE_FILE):
                with open(CACHE_FILE, "rb") as f:
                    return self._send(200, f.read())
            emb = embedded_schema_bytes()
            if emb:
                return self._send(200, emb)
            return self._send(200, {"empty": True})
        if self.path == "/api/schema-info":
            return self._send(200, schema_info())
        if self.path == "/api/saved":
            try:
                return self._send(200, saved_info())
            except ValueError as e:
                return self._send(200, {"error": str(e), "items": []})
        if self.path == "/api/download-py":
            try:
                data = source_with_schema(_schema_for_embedding()).encode("utf-8")
            except ValueError as e:
                return self._send(200, {"error": str(e)})
            self.send_response(200)
            self.send_header("Content-Type", "text/x-python; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="otm_explorer.py"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._send(404, {"error": "not found"})

    def _auth(self):
        if not self._cookie_ok():
            self._send(403, {"error": "This browser isn't signed in to the helper - open the link shown in the helper window (press Enter there for a new one)."})
            return False
        if not secrets.compare_digest((self.headers.get("X-Token") or "").encode(), TOKEN.encode()):
            self._send(403, {"error": "bad token - reload the page"})
            return False
        return True

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, {"error": "forbidden host"})
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        try:
            if self.path == "/api/connect":
                url = (body.get("url") or "").strip().rstrip("/")
                if url.endswith("/GC3"):
                    url = url[:-4]
                if not re.match(r"^https?://", url):
                    raise ValueError("URL must start with https://")
                pw = body.get("password") or (os.environ.get("OTM_PASS") if body.get("useEnvPass") else "")
                pid = body.get("profile") or "default"
                if not pw and pid in SESSIONS and SESSIONS[pid]["url"] == url and SESSIONS[pid]["user"] == (body.get("user") or "").strip():
                    pw = SESSIONS[pid]["password"]          # re-test an open session without retyping
                c = dict(url=url, user=(body.get("user") or "").strip(), password=pw,
                         servlet=(body.get("servlet") or DEFAULT_SERVLET).strip(), insecure=bool(body.get("insecure")))
                res = run_query("SELECT 'OK' AS STATUS, USER AS DB_USER FROM DUAL", 1, conn=c)
                SESSIONS[pid] = c
                CONN.update(c)
                return self._send(200, {"ok": True, "test": res, "sessions": sorted(SESSIONS)})
            if self.path == "/api/disconnect":
                pid = body.get("profile")
                c = SESSIONS.pop(pid, None) if pid else None
                if not pid or (c and c["url"] == CONN["url"] and c["user"] == CONN["user"]):
                    CONN.update(url=None, user=None, password=None)
                if not pid:
                    SESSIONS.clear()
                return self._send(200, {"ok": True, "sessions": sorted(SESSIONS)})
            if self.path == "/api/query":
                return self._send(200, run_query(body.get("sql", ""), body.get("maxRows", 500), conn=conn_for(body)))
            if self.path == "/api/check":
                return self._send(200, check_sql(body.get("sql", ""), conn=conn_for(body)))
            if self.path == "/api/schema-cache":
                tmp = CACHE_FILE + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(body, f, separators=(",", ":"))
                os.replace(tmp, CACHE_FILE)
                return self._send(200, {"ok": True})
            if self.path == "/api/saved":
                try:
                    return self._send(200, saved_op(body))
                except PermissionError:
                    raise ValueError("Can't write otm_saved_queries.json — the folder of otm_explorer.py is read-only. Move the script to a normal folder.")
            if self.path == "/api/schema-embed":
                return self._send(200, embed_schema())
            if self.path == "/api/schema-reset":
                if os.path.exists(CACHE_FILE):
                    os.remove(CACHE_FILE)
                return self._send(200, {"ok": True, "embedded": bool(EMBEDDED_SCHEMA)})
            self._send(404, {"error": "not found"})
        except ValueError as e:
            self._send(200, {"error": str(e)})
        except Exception as e:  # noqa
            self._send(200, {"error": f"{type(e).__name__}: {e}"})


USE_EXTERNAL_HTML = False   # set by --dev-html

LOCKED_PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>OTM Schema Explorer</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:620px;margin:60px auto;padding:0 20px;color:#1d2433}
code{background:#f2f4f7;padding:1px 5px;border-radius:4px}</style></head><body>
<h2>OTM Schema Explorer</h2>
<p>This page only opens through the link that the helper gives you. That way, other people or programs on
this computer can't use your OTM session.</p>
<p>Go to the window where <code>otm_explorer.py</code> is running and press <b>Enter</b>: a new link opens in
your browser. You can also stop the helper (Ctrl+C) and start it again.</p>
<p style="color:#667085;font-size:13px">Each link works once. The browser that opens it stays signed in until the helper stops.</p>
</body></html>"""


def cookie_name():
    return f"otmx_{PORT['n']}"         # cookies are per host, not per port: one name per running copy


def launch_url():
    return f"http://127.0.0.1:{PORT['n']}/?k={LAUNCH['key']}"


def _new_link_on_enter(open_browser):
    """Press Enter in the helper window to get (and open) a fresh launch link."""
    try:
        while True:
            line = sys.stdin.readline()
            if not line:                    # no console (started by another program): nothing to do
                return
            if not LAUNCH["reusable"]:
                LAUNCH["key"] = secrets.token_urlsafe(18)
            link = launch_url()
            print(f"\n  New link (works once): {link}\n")
            if open_browser:
                try:
                    webbrowser.open(link)
                except Exception:
                    pass
    except Exception:
        return


def load_html():
    # Always the page built into this file, so an old otm_explorer.html lying around can't win.
    if USE_EXTERNAL_HTML and os.path.exists(HTML_FILE):
        with open(HTML_FILE, "r", encoding="utf-8") as f:
            return f.read().replace("__VERSION__", VERSION)
    return _unb64z(EMBEDDED_HTML).decode("utf-8").replace("__VERSION__", VERSION)


def main():
    ap = argparse.ArgumentParser(description="OTM Schema Explorer")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--dev-html", action="store_true", help="serve otm_explorer.html from this folder instead of the built-in page")
    ap.add_argument("--launch-key", help="use this launch key instead of a random one-time key (for automation and tests; "
                                         "it can be used many times, so keep it secret)")
    a = ap.parse_args()
    global USE_EXTERNAL_HTML
    USE_EXTERNAL_HTML = a.dev_html
    if not EMBEDDED_HTML and not (a.dev_html and os.path.exists(HTML_FILE)):
        print("\n  This is the source file of the helper - the web page isn't built into it yet.\n"
              "  Run:  python tools/build.py   and start  dist/otm_explorer.py\n"
              "  (or download otm_explorer.py from the GitHub Releases page)\n")
        sys.exit(2)
    PORT["n"] = a.port
    if a.launch_key:
        LAUNCH.update(key=a.launch_key, reusable=True)
    ThreadingHTTPServer.allow_reuse_address = (os.name != "nt")  # on Windows reuse lets 2 copies share a port
    ThreadingHTTPServer.daemon_threads = True
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError as e:
        print(f"\n  Port {a.port} is already in use (is another copy still running?).\n"
              f"  Close it, or run:  python otm_explorer.py --port 8777\n  ({e})")
        sys.exit(1)
    url = launch_url()
    print(f"\n  OTM Schema Explorer v{VERSION}  (unofficial - not affiliated with or endorsed by Oracle)\n"
          f"  Open:  {url}\n"
          f"  The link works once, for one browser. Press Enter here for a new link.  Ctrl+C stops the helper.\n")
    if not a.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=_new_link_on_enter, args=(not a.no_browser,), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


EMBEDDED_HTML = (
    ""
)

# Your schema, built in with "Build current schema into this file" (zlib + base64 JSON). Empty = none.
EMBEDDED_SCHEMA = (
    ""
)

if __name__ == "__main__":
    main()
