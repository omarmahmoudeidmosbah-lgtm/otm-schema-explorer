"""Tests for the helper (the Python part): read-only guard, OTM replies, saved queries, built-in schema,
and the access control of the local web server."""
import json
import os
import shutil
import urllib.error
import urllib.request

import pytest

from conftest import ENV, LAUNCH_KEY, last_sql, load_module, start_app, wait_log_key


# ---------------------------------------------------------------- read-only guard
@pytest.mark.parametrize("sql", [
    "SELECT * FROM shipment",
    "  select 1 from dual ;",
    "WITH x AS (SELECT 1 a FROM dual) SELECT * FROM x",
    "(SELECT 1 FROM dual)",
    "SELECT 'DELETE FROM x' AS txt FROM dual",                  # keywords inside strings are fine
    "SELECT 1 AS a FROM dual -- drop table x",                  # ... and inside comments
])
def test_guard_allows_queries(ox, sql):
    assert ox.check_read_only(sql)


@pytest.mark.parametrize("sql,why", [
    ("DELETE FROM shipment", "Only SELECT"),
    ("UPDATE shipment SET x = 1", "Only SELECT"),
    ("SELECT * FROM shipment FOR UPDATE", "UPDATE"),
    ("SELECT 1 FROM dual; DROP TABLE x", "one statement"),
    ("BEGIN NULL; END;", "Only SELECT"),
    ("SELECT * FROM shipment WHERE 1 = 1 UNION SELECT * FROM x; COMMIT", "one statement"),
])
def test_guard_blocks_changes(ox, sql, why):
    with pytest.raises(ValueError, match=why):
        ox.check_read_only(sql)


# ---------------------------------------------------------------- reading OTM replies
NS = 'xmlns:dbxml="http://xmlns.oracle.com/apps/otm/DBXML"'


def test_parse_namespaced_rows(ox):
    raw = f'<dbxml:xml2sql {NS} Version="26c"><dbxml:TRANSACTION_SET><dbxml:R A="1" B="x &amp; y"/><dbxml:R A="2"/></dbxml:TRANSACTION_SET></dbxml:xml2sql>'.encode()
    cols, rows = ox.parse_rows(raw)
    assert cols == ["A", "B"] and rows == [["1", "x & y"], ["2", None]]


def test_parse_no_data_is_empty(ox):
    raw = f'<dbxml:xml2sql {NS}><dbxml:TRANSACTION_SET>NO DATA</dbxml:TRANSACTION_SET></dbxml:xml2sql>'.encode()
    assert ox.parse_rows(raw) == ([], [])


def test_parse_error_comment_is_an_error(ox):
    raw = b'<?xml version="1.0"?>\n<sql2xml>\n<!-- DatabaseError error: ORA-00942: table or view does not exist -->\n</sql2xml>'
    with pytest.raises(ValueError, match="ORA-00942"):
        ox.parse_rows(raw)


def test_parse_invalid_xml_falls_back(ox):
    raw = b'<xml2sql><TRANSACTION_SET><R COUNT(*)="5"/></TRANSACTION_SET></xml2sql>'
    cols, rows = ox.parse_rows(raw)
    assert rows == [["5"]]


def test_parse_html_login_page(ox):
    with pytest.raises(ValueError, match="HTML page"):
        ox.parse_rows(b"<html><body>Login <b>here</html")


# ---------------------------------------------------------------- talking to (mock) OTM
@pytest.fixture()
def connected(ox, mock_url):
    ox.CONN.update(url=mock_url, user="DEMO.ADMIN", password="secret")
    return ox


def test_run_query_wraps_and_times(connected, mock_url):
    r = connected.run_query("SELECT s.shipment_gid FROM shipment s", 3)
    assert len(r["rows"]) == 3 and r["truncated"] is True
    assert set(r["timing"]) >= {"otmMs", "recvMs", "bytes", "parseMs"}
    assert "WHERE ROWNUM <= 4" in last_sql(mock_url)


def test_check_sql(connected):
    assert connected.check_sql("SELECT s.shipment_gid FROM shipment s")["ok"] is True
    bad = connected.check_sql("SELECT s.nope FROM shipment s")
    assert bad["ok"] is False and bad["error"].startswith("ORA-00904")
    assert connected.check_sql("DELETE FROM shipment")["ok"] is False


def test_wrong_password(ox, mock_url):
    ox.CONN.update(url=mock_url, user="DEMO.ADMIN", password="wrong")
    with pytest.raises(ValueError, match="HTTP 401"):
        ox.run_query("SELECT 1 AS A FROM dual", 1)


def test_timeout_message(connected):
    with pytest.raises(ValueError, match="did not answer within 1 seconds"):
        connected.call_dbxml("SELECT * FROM slow_view", timeout=1)


# ---------------------------------------------------------------- saved queries
def item(i, **kw):
    d = {"id": "q%d" % i, "name": "Query %d" % i, "folder": "F", "sql": "SELECT %d AS N FROM dual" % i, "updated": "2026-01-0%dT00:00:00Z" % i}
    d.update(kw)
    return d


def test_saved_upsert_delete_import(ox):
    assert ox.saved_info()["items"] == []
    ox.saved_op({"op": "upsert", "item": item(1)})
    ox.saved_op({"op": "upsert", "item": item(2)})
    ox.saved_op({"op": "upsert", "item": item(1, name="Renamed")})
    names = [x["name"] for x in ox.saved_info()["items"]]
    assert names == ["Renamed", "Query 2"]
    ox.saved_op({"op": "delete", "id": "q2"})
    r = ox.saved_op({"op": "import", "items": [item(2), item(1, name="Older", updated="2000-01-01"), {"bad": 1}]})
    assert (r["added"], r["updated"], r["skipped"]) == (1, 0, 2)
    with open(ox.SAVED_FILE, encoding="utf-8") as f:
        assert len(json.load(f)["items"]) == 2


def test_saved_never_overwrites_a_damaged_file(ox):
    with open(ox.SAVED_FILE, "w", encoding="utf-8") as f:
        f.write("{ not json")
    with pytest.raises(ValueError, match="damaged"):
        ox.saved_op({"op": "upsert", "item": item(1)})
    with open(ox.SAVED_FILE, encoding="utf-8") as f:
        assert f.read() == "{ not json"


def test_saved_requires_name_and_sql(ox):
    with pytest.raises(ValueError):
        ox.saved_op({"op": "upsert", "item": {"id": "x", "name": " ", "sql": "SELECT 1 FROM dual"}})


# ---------------------------------------------------------------- built-in schema
def test_build_schema_into_the_file(ox, tmp_path):
    schema = {"edges": [{"c": "SHIPMENT_STOP", "cc": ["SHIPMENT_GID"], "p": "SHIPMENT", "pc": ["SHIPMENT_GID"], "src": "fk"}],
              "columns": {"SHIPMENT": [["SHIPMENT_GID", "VARCHAR2(101)", "N"]]}, "tables": ["SHIPMENT", "SHIPMENT_STOP"],
              "meta": {"source": "test"}}
    with open(ox.CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(schema, f)
    assert ox.schema_info()["using"] == "local"
    r = ox.embed_schema()
    assert r["ok"] and r["summary"]["tables"] == 2
    os.remove(ox.CACHE_FILE)
    fresh = load_module(ox.__file__, "ox_reloaded")             # the file on disk now carries the schema
    info = fresh.schema_info()
    assert info["using"] == "embedded" and info["embedded"]["links"] == 1
    assert json.loads(fresh.embedded_schema_bytes())["meta"]["builtInAt"]


def test_release_build_has_no_schema(built):
    m = load_module(built, "ox_release")
    assert m.EMBEDDED_SCHEMA == "" and m.EMBEDDED_HTML


# ---------------------------------------------------------------- access control of the local server
def http(url, headers=None, data=None):
    """GET/POST without following redirects; returns (status, headers, body)."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers=headers or {}, data=data)
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def sign_in(app, key=None):
    st, h, _ = http("%s/?k=%s" % (app.base, key or app.key))
    assert st == 303, st
    return h["Set-Cookie"].split(";")[0]


def page_token(app, cookie):
    st, _, body = http(app.base + "/", {"Cookie": cookie})
    assert st == 200
    return body.split('const TOKEN = "')[1].split('"')[0]


def test_page_needs_the_launch_link(built, tmp_path):
    app = start_app(built, str(tmp_path / "a"), launch_key=None)           # real one-time key
    try:
        assert http(app.base + "/")[0] == 403                               # no cookie → locked page
        assert http(app.base + "/?k=wrong")[0] == 403
        st, h, _ = http("%s/?k=%s" % (app.base, app.key))
        assert st == 303 and h["Location"] == "/"
        set_cookie = h["Set-Cookie"]
        assert "HttpOnly" in set_cookie and "SameSite=Strict" in set_cookie
        cookie = set_cookie.split(";")[0]
        assert http("%s/?k=%s" % (app.base, app.key))[0] == 403            # spent: works only once
        token = page_token(app, cookie)
        assert token and http(app.base + "/api/status", {"Cookie": cookie, "X-Token": token})[0] == 200
        assert http(app.base + "/api/status", {"X-Token": token})[0] == 403          # token alone isn't enough
        assert http(app.base + "/api/status", {"Cookie": cookie})[0] == 403          # cookie alone isn't enough
        assert http(app.base + "/api/status", {"Cookie": cookie, "X-Token": token, "Host": "evil.example"})[0] == 403
        assert http(app.base + "/api/query", {"Cookie": "otmx_%d=guess" % app.port, "X-Token": token, "Content-Type": "application/json"}, b"{}")[0] == 403
        # Enter in the helper window → a new link
        app.proc.stdin.write("\n"); app.proc.stdin.flush()
        new_key = wait_log_key(app, after=1)
        assert new_key != app.key and sign_in(app, new_key)
    finally:
        app.proc.terminate(); app.proc.wait(timeout=10)


def test_source_file_refuses_to_start_without_a_build(tmp_path):
    import subprocess, sys
    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "server", "otm_explorer.py")
    shutil.copy(src, tmp_path / "otm_explorer.py")
    r = subprocess.run([sys.executable, str(tmp_path / "otm_explorer.py"), "--no-browser"], capture_output=True, text=True, timeout=30, env=ENV)
    assert r.returncode == 2 and "tools/build.py" in r.stdout


def test_launch_key_option_is_reusable(app):
    assert app.key == LAUNCH_KEY
    sign_in(app); sign_in(app)
