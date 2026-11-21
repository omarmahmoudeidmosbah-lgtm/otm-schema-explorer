"""Fake OTM DB.XML servlet used by the tests:  python tests/mock_otm.py [port]  (default 9911).
Login: DEMO.ADMIN / secret (or PROD.ADMIN / prodpw).
Mimics OTM: namespaced replies, NO DATA when empty, SQL errors returned as an XML comment.
Queries run on a small DuckDB database with OTM-like tables and sample data (Oracle SQL is transpiled)."""
import base64, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import quoteattr
import duckdb, sqlglot
from sqlglot import exp

D = "DEMO."
DATA = {
    "SHIPMENT": (["SHIPMENT_GID", "SHIPMENT_XID", "SHIPMENT_NAME", "DOMAIN_NAME", "SOURCE_LOCATION_GID", "DEST_LOCATION_GID",
                  "SERVPROV_GID", "TOTAL_ACTUAL_COST", "TOTAL_WEIGHT", "START_TIME", "END_TIME", "INSERT_DATE"],
                 [[D + "SH%04d" % i, "SH%04d" % i, ("Riyadh > Jeddah & co <%d>" % i) if i % 3 else None, "DEMO",
                   D + ("RUH" if i % 2 else "DMM"), D + "JED", D + ("SAPTCO" if i < 5 else "NAQEL"), i * 10.5, 1000 + i,
                   "2026-11-%02d 08:00:00" % i, "2026-11-%02d 18:00:00" % i, "2026-11-01 00:00:00"] for i in range(1, 8)]),
    "SHIPMENT_STOP": (["SHIPMENT_GID", "STOP_NUM", "LOCATION_GID", "ACTUAL_ARRIVAL", "ACTUAL_DEPARTURE", "PLANNED_ARRIVAL", "PLANNED_DEPARTURE"],
                      [[D + "SH%04d" % i, n, D + ("RUH" if n == 1 else "JED"), None, None, "2026-11-%02d 0%d:00:00" % (i, n + 7), None]
                       for i in range(1, 8) for n in (1, 2)]),
    "SHIPMENT_STOP_D": (["SHIPMENT_GID", "STOP_NUM", "S_SHIP_UNIT_GID", "ACTIVITY"], [[D + "SH0001", 1, D + "SU1", "P"], [D + "SH0001", 2, D + "SU1", "D"]]),
    "SHIPMENT_STATUS": (["SHIPMENT_GID", "STATUS_TYPE_GID", "STATUS_VALUE_GID", "DOMAIN_NAME"],
                        [[D + "SH%04d" % i, D + t, D + v, "DEMO"] for i in range(1, 8) for t, v in
                         [("PLANNING", "PLANNING_EXECUTED"), ("ENROUTE", "ENROUTE_COMPLETED" if i < 3 else "ENROUTE_NOT_STARTED"), ("TENDERED", "TENDER_ACCEPTED")]]),
    "SHIPMENT_REFNUM": (["SHIPMENT_GID", "SHIPMENT_REFNUM_QUAL_GID", "SHIPMENT_REFNUM_VALUE", "DOMAIN_NAME"],
                        [[D + "SH0001", D + "BM", "BOL-778812", "DEMO"], [D + "SH0001", D + "PO", "PO-55120", "DEMO"], [D + "SH0002", D + "PO", "PO-55121", "DEMO"]]),
    "SHIPMENT_REFNUM_QUAL": (["SHIPMENT_REFNUM_QUAL_GID", "SHIPMENT_REFNUM_QUAL_XID", "SHIPMENT_REFNUM_QUAL_DESC", "DOMAIN_NAME"],
                             [[D + "BM", "BM", "Bill of lading", "DEMO"], [D + "PO", "PO", "Purchase order", "DEMO"], [D + "CUST_REF", "CUST_REF", "Customer reference", "DEMO"]]),
    "SHIPMENT_REMARK": (["SHIPMENT_GID", "REMARK_SEQUENCE", "REMARK_QUAL_GID", "REMARK_TEXT"], [[D + "SH0001", 1, D + "NOTE", "Call receiver 1 hour before arrival"]]),
    "SHIPMENT_AUDIT_LOG": (["LOG_ID", "SHIPMENT_GID", "MESSAGE"], [[1, D + "SH0001", "created"], [2, D + "SH0001", "tendered"]]),
    "STATUS_TYPE": (["STATUS_TYPE_GID", "STATUS_TYPE_XID", "DESCRIPTION", "DOMAIN_NAME"],
                    [[D + "PLANNING", "PLANNING", "Planning", "DEMO"], [D + "ENROUTE", "ENROUTE", "Enroute", "DEMO"], [D + "TENDERED", "TENDERED", "Tendered", "DEMO"]]),
    "STATUS_VALUE": (["STATUS_VALUE_GID", "STATUS_VALUE_XID", "STATUS_TYPE_GID", "DESCRIPTION", "DOMAIN_NAME"],
                     [[D + v, v, D + t, d, "DEMO"] for t, v, d in [
                         ("PLANNING", "PLANNING_NEW", "New"), ("PLANNING", "PLANNING_EXECUTED", "Executed"), ("PLANNING", "PLANNING_UNPLANNED", "Unplanned"),
                         ("ENROUTE", "ENROUTE_NOT_STARTED", "Not started"), ("ENROUTE", "ENROUTE_STARTED", "Started"), ("ENROUTE", "ENROUTE_COMPLETED", "Completed"),
                         ("TENDERED", "TENDER_ACCEPTED", "Accepted"), ("TENDERED", "TENDER_DECLINED", "Declined")]]),
    "LOCATION": (["LOCATION_GID", "LOCATION_XID", "LOCATION_NAME", "CITY", "COUNTRY_CODE3_GID", "DOMAIN_NAME"],
                 [[D + "RUH", "RUH", "Riyadh DC", "RIYADH", "SAU", "DEMO"], [D + "JED", "JED", "Jeddah Port", "JEDDAH", "SAU", "DEMO"], [D + "DMM", "DMM", "Dammam Hub", "DAMMAM", "SAU", "DEMO"],
                  [D + "SAPTCO", "SAPTCO", "SAPTCO Logistics", "RIYADH", "SAU", "DEMO"], [D + "NAQEL", "NAQEL", "Naqel Express", "RIYADH", "SAU", "DEMO"]]
                 + [[D + "L%05d" % i, "L%05d" % i, "Customer site %d" % i, "RIYADH", "SAU", "DEMO"] for i in range(1, 700)]),
    "SERVPROV": (["SERVPROV_GID", "SERVPROV_XID", "DOMAIN_NAME"], [[D + "SAPTCO", "SAPTCO", "DEMO"], [D + "NAQEL", "NAQEL", "DEMO"]]),
    "ORDER_RELEASE": (["ORDER_RELEASE_GID", "ORDER_RELEASE_XID", "SOURCE_LOCATION_GID", "DEST_LOCATION_GID", "EARLY_PICKUP_DATE", "TOTAL_WEIGHT"],
                      [[D + "OR%03d" % i, "OR%03d" % i, D + "RUH", D + "JED", "2026-11-01 00:00:00", 500] for i in range(1, 6)]),
    "VIEW_SHIPMENT_ORDER_RELEASE": (["SHIPMENT_GID", "ORDER_RELEASE_GID"], [[D + "SH0001", D + "OR001"], [D + "SH0001", D + "OR002"], [D + "SH0002", D + "OR003"]]),
    "INVOICE": (["INVOICE_GID", "INVOICE_XID", "INVOICE_DATE", "NET_AMOUNT_DUE", "SERVPROV_GID"], [[D + "INV01", "INV01", "2026-11-10 00:00:00", 950.5, D + "SAPTCO"]]),
    "INVOICE_SHIPMENT": (["INVOICE_GID", "SHIPMENT_GID"], [[D + "INV01", D + "SH0001"]]),
    "VOUCHER": (["VOUCHER_GID", "INVOICE_GID", "AMOUNT_TO_PAY"], [[D + "V01", D + "INV01", 950.5]]),
    "XX_CUSTOM_LOG": (["LOG_ID", "MESSAGE"], []),
    "DOMAIN": (["DOMAIN_NAME"], [["DEMO"]]),
    "GL_USER": (["GL_USER_GID", "DOMAIN_NAME"], [[D + "ADMIN", "DEMO"]]),
    "_TMP": (["X"], []),
}
CATALOG = {t: v[0] for t, v in DATA.items()}
NOT_INDEXED = {("SHIPMENT_AUDIT_LOG", "SHIPMENT_GID"), ("SHIPMENT", "SERVPROV_GID")}
INDEXES = [(t, c) for t, cs in CATALOG.items() for c in cs if c.endswith("_GID") and (t, c) not in NOT_INDEXED]
FKS = [  # CN, CT, CC, PT, PC, POS
    ("FK_SS_SH", "SHIPMENT_STOP", "SHIPMENT_GID", "SHIPMENT", "SHIPMENT_GID", 1),
    ("FK_IS_INV", "INVOICE_SHIPMENT", "INVOICE_GID", "INVOICE", "INVOICE_GID", 1),
    ("FK_IS_SH", "INVOICE_SHIPMENT", "SHIPMENT_GID", "SHIPMENT", "SHIPMENT_GID", 1),
    ("FK_SSD_SS", "SHIPMENT_STOP_D", "SHIPMENT_GID", "SHIPMENT_STOP", "SHIPMENT_GID", 1),
    ("FK_SSD_SS", "SHIPMENT_STOP_D", "STOP_NUM", "SHIPMENT_STOP", "STOP_NUM", 2),
]
GIDS = [(t, c) for t, cs in CATALOG.items() for c in cs if c.endswith("_GID")]
DB = duckdb.connect()
LAST_SQL = [""]
LOCK = threading.Lock()
DB.execute("CREATE TABLE DUAL (DUMMY VARCHAR)"); DB.execute("INSERT INTO DUAL VALUES ('X')")
for t, (cols, rows) in DATA.items():
    def typ(c, k):
        vals = [r[k] for r in rows if r[k] is not None]
        return "DOUBLE" if vals and all(isinstance(v, (int, float)) for v in vals) else "VARCHAR"
    DB.execute('CREATE TABLE "%s" (%s)' % (t, ", ".join('"%s" %s' % (c, typ(c, k)) for k, c in enumerate(cols))))
    if rows:
        DB.executemany('INSERT INTO "%s" VALUES (%s)' % (t, ",".join("?" * len(cols))), rows)


BIGCOLS = ["BIG_TABLE_GID"] + ["COL_%02d" % k for k in range(30)]
DB.execute("CREATE TABLE BIG_TABLE AS SELECT 'DEMO.BIG' || lpad(i::VARCHAR, 7, '0') AS BIG_TABLE_GID, "
           + ", ".join("'value %d ' || (i %% 97)::VARCHAR AS COL_%02d" % (k, k) for k in range(30)) + " FROM range(20000) t(i)")
CATALOG["BIG_TABLE"] = BIGCOLS
DB.execute("CREATE VIEW SLOW_VIEW AS SELECT * FROM BIG_TABLE LIMIT 2000")
CATALOG["SLOW_VIEW"] = BIGCOLS
FAKE_ROWS = {"SHIPMENT": 2500000, "SHIPMENT_STATUS": 48000000, "SHIPMENT_STOP": 9000000, "LOCATION": 400000, "BIG_TABLE": 20000}


def ctype(c):
    return "DATE" if re.search(r"DATE|TIME|ARRIVAL|DEPARTURE", c) else "NUMBER" if re.search(r"COST|WEIGHT|NUM$|AMOUNT|_ID$|SEQUENCE", c) else "VARCHAR2(101)"


def rows_xml(cols, rows):
    out = []
    for r in rows:
        out.append("<R " + " ".join(f"{c}={quoteattr(str(v))}" for c, v in zip(cols, r) if v is not None) + "/>")
    ns = 'xmlns:dbxml="http://xmlns.oracle.com/apps/otm/DBXML"'
    return (f'<dbxml:xml2sql {ns} Version="26c"><dbxml:TRANSACTION_SET>'
            + ("".join(out).replace("<R ", "<dbxml:R ") or "NO DATA") + "</dbxml:TRANSACTION_SET></dbxml:xml2sql>")


def db_error(msg, sql):
    return ('<?xml version="1.0" encoding="utf-8"?>\n<sql2xml>\n<!-- DatabaseError error: %s\nFailed sql statement: %s -->\n</sql2xml>'
            % (msg, sql.replace("--", "- -")))


def validate(sql):
    try:
        tree = sqlglot.parse_one(sql, read="oracle")
    except Exception:
        return "ORA-00936: missing expression"
    ctes = {c.alias_or_name.upper() for c in tree.find_all(exp.CTE)}
    alias = {}
    for t in tree.find_all(exp.Table):
        n = t.name.upper()
        if n in ("DUAL",) or n in ctes or n.startswith("ALL_"):
            continue
        if n not in CATALOG:
            return "ORA-00942: table or view does not exist"
        alias[(t.alias or t.name).upper()] = n
    for c in tree.find_all(exp.Column):
        if isinstance(c.this, exp.Star) or c.name == "*":
            continue
        q = (c.table or "").upper()
        if q and q in alias and c.name.upper() not in CATALOG[alias[q]]:
            return 'ORA-00904: "%s"."%s": invalid identifier' % (q, c.name.upper())
    return None


def execute(sql):
    m = re.match(r"^SELECT \* FROM \(\n(.*)\n\) WHERE (?:ROWNUM <= (\d+)|1 = 0)$", sql.strip(), re.S)
    inner, limit = (m.group(1), int(m.group(2) or 0)) if m else (sql, 100000)
    inner = re.sub(r"\bROWNUM\s*(<=|=|<)\s*\d+", "1 = 1", inner, flags=re.I)
    d = "SELECT * FROM (%s) AS _w LIMIT %d" % (sqlglot.transpile(inner, read="oracle", write="duckdb")[0], limit)
    with LOCK:
        cur = DB.execute(d)
        cols = [c[0].upper() for c in cur.description]
        rows = cur.fetchall()
    return cols, rows


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        auth = self.headers.get("Authorization", "")
        if auth != "Basic " + base64.b64encode(b"DEMO.ADMIN:secret").decode() and auth != "Basic " + base64.b64encode(b"PROD.ADMIN:prodpw").decode():
            self.send_response(401); self.end_headers(); return
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        sql = re.search(r"<Statement>(.*)</Statement>", body, re.S).group(1)
        sql = sql.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        LAST_SQL[0] = sql
        s = sql.lower()
        m = re.search(r"(?:table_name|object_name) like '([a-z])%'", s)
        letter = m.group(1).upper() if m else None
        other = "regexp_like" in s
        keep = lambda t: (letter is None and not other) or (letter and t.startswith(letter)) or (other and not t[0].isalpha())
        if "group by owner" in s and "all_objects" in s:
            x = rows_xml(["O", "N"], [["GLOGOWNER", 4]])
        elif "all_objects" in s:
            x = rows_xml(["T", "Y"], [[t, "VIEW" if t.startswith("VIEW_") else "TABLE"] for t in sorted(CATALOG) if keep(t)])
        elif "from dual" in s and "'ok'" in s:
            x = rows_xml(["STATUS", "DB_USER"], [["OK", "GLOGOWNER"]])
        elif "all_constraints" in s:
            x = rows_xml(["CONSTRAINT_NAME", "CHILD_TABLE", "CHILD_COLUMN", "PARENT_TABLE", "PARENT_COLUMN", "POS"], [f for f in FKS if keep(f[1])])
        elif "from all_tables" in s:
            want = set(re.findall(r"'([a-z0-9_$#]+)'", s.split("table_name in", 1)[1])) if "table_name in" in s else set()
            x = rows_xml(["T", "N", "D"], [[t, FAKE_ROWS.get(t, len(DATA.get(t, ([], []))[1])), "2026-11-15"] for t in CATALOG if t.lower() in want and not t.startswith("VIEW_") and t != "SLOW_VIEW"])
        elif "all_ind_columns" in s:
            want = set(re.findall(r"'([a-z0-9_$#]+)'", s.split("column_name in", 1)[1])) if "column_name in" in s else set()
            x = rows_xml(["T", "C"], [[t, c] for t, c in INDEXES if c.lower() in want])
        elif "all_tab_columns" in s and "column_id as i" in s:
            x = rows_xml(["T", "C", "Y", "N", "I"], [[t, c, ctype(c), "Y", i + 1] for t in sorted(CATALOG) if keep(t) for i, c in enumerate(CATALOG[t])])
        elif "all_tab_columns" in s and "_gid" in s:
            x = rows_xml(["T", "C"], [g for g in GIDS if keep(g[0])])
        elif "all_tab_columns" in s:
            tm = re.search(r"table_name = '([a-z_0-9]+)'", s); tn = tm.group(1).upper() if tm else ""
            x = rows_xml(["C", "T", "N"], [[c, ctype(c), "Y"] for c in CATALOG.get(tn, [])])
        else:
            if "slow_view" in s:
                import time as _t; _t.sleep(2)
            err = validate(sql)
            if err:
                x = db_error(err, sql)
            elif re.search(r"select\s+count\(\*\)\s+from", s) and " as " not in s:
                x = '<xml2sql><TRANSACTION_SET><R COUNT(*)="5"/></TRANSACTION_SET></xml2sql>'
            else:
                try:
                    cols, rows = execute(sql)
                    x = rows_xml(cols, [[(int(v) if isinstance(v, float) and v.is_integer() else v) for v in r] for r in rows])
                except Exception as e:
                    m = str(e)
                    code = "ORA-00942: table or view does not exist" if "Catalog Error" in m else "ORA-00904: invalid identifier" if "Binder Error" in m else "ORA-00933: SQL command not properly ended"
                    x = db_error(code + " (mock: " + m.split("\n")[0][:120] + ")", sql)
        data = x.encode()
        self.send_response(200); self.send_header("Content-Type", "text/xml"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def log_message(self, *a): pass


    def do_GET(self):                     # /last-sql: what the helper sent last (for tests)
        data = LAST_SQL[0].encode()
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print("mock OTM ready on", port, flush=True)
    srv.serve_forever()
