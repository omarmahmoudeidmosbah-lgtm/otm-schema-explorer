"""Browser tests (Playwright + Chromium) against the mock OTM.

    pip install -r tests/requirements-dev.txt
    python -m playwright install chromium
    pytest tests/test_ui.py
"""
import json
import os

import pytest

from conftest import start_app, last_sql
from sql_cases import BAD, OK

sync_api = pytest.importorskip("playwright.sync_api")


@pytest.fixture(scope="module")
def ui(built, mock_url, tmp_path_factory):
    app = start_app(built, str(tmp_path_factory.mktemp("ui") / "app"))
    pw = sync_api.sync_playwright().start()
    browser = pw.chromium.launch(args=["--no-proxy-server"])
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(app.launch)
    page.wait_for_function("typeof SCHEMA !== 'undefined' && TABLESET.size > 0")
    page.click("nav button[data-tab=connect]")
    page.fill("#cUrl", mock_url); page.fill("#cUser", "DEMO.ADMIN"); page.fill("#cPass", "secret")
    page.click("#btnConnect")
    page.wait_for_function("CONNECTED === true")
    page.click("nav button[data-tab=schema]"); page.click("#btnSync")
    page.wait_for_function("document.querySelector('#syncLog').textContent.includes('Done.')", timeout=60000)
    page.click("nav button[data-tab=query]")
    yield {"page": page, "app": app, "errors": errors, "mock": mock_url}
    browser.close(); pw.stop()
    app.proc.terminate(); app.proc.wait(timeout=10)


def run_in_runner(page, sql):
    page.evaluate("s => setSQL(s)", sql)
    page.click("#btnRun")
    page.wait_for_function("!qtCur().running", timeout=30000)
    return page.evaluate("(() => { const t = qtCur(), r = t.results[t.ri]; return r ? {error: r.error || null, rows: r.rows ? r.rows.length : 0} : null; })()")


def test_locked_without_launch_link(ui, built, tmp_path):
    import urllib.request, urllib.error
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(ui["app"].base + "/")
    assert e.value.code == 403


def test_sync_loaded_tables_and_columns(ui):
    n = ui["page"].evaluate("[TABLESET.size, Object.keys(SCHEMA.columns).length]")
    assert n[0] >= 20 and n[1] >= 20


def test_run_query_shows_timing(ui):
    page = ui["page"]
    r = run_in_runner(page, "SELECT s.shipment_gid, s.total_actual_cost FROM shipment s WHERE s.total_actual_cost > 20")
    assert r == {"error": None, "rows": 6}
    assert "OTM" in page.inner_text("#runInfo") and "transfer" in page.inner_text("#runInfo")
    assert "WHERE ROWNUM <= 501" in last_sql(ui["mock"])


def test_oracle_error_is_shown_and_underlined(ui):
    page = ui["page"]
    r = run_in_runner(page, "SELECT s.nope FROM shipment s")
    assert r["error"] and "ORA-00904" in page.inner_text("#qMsg")
    assert page.evaluate("document.querySelectorAll('#edWrap .ed-err').length") > 0


def test_autocomplete_alias_columns(ui):
    page = ui["page"]
    page.evaluate("setSQL('SELECT \\nFROM shipment s'); setTimeout(() => { ED.setCursor(0, 7); ED.focus(); }, 5)")
    page.wait_for_timeout(100)
    page.keyboard.type("s.")
    page.wait_for_selector(".CodeMirror-hints li")
    items = page.evaluate("[...document.querySelectorAll('.CodeMirror-hints li')].map(li => li.innerText)")
    assert any("SHIPMENT_GID" in i for i in items)
    page.keyboard.press("Escape")


def test_parameters_are_asked_and_quoted(ui):
    page = ui["page"]
    page.evaluate("setSQL('SELECT s.shipment_gid FROM shipment s WHERE s.servprov_gid = :carrier')")
    page.click("#btnRun")
    page.wait_for_selector("#prmModal [data-pn]")
    page.fill("#prmModal [data-pn]", "DEMO.SAPTCO")
    page.click("#prmModal [data-pm=ok]")
    page.wait_for_function("!qtCur().running")
    assert "s.servprov_gid = 'DEMO.SAPTCO'" in last_sql(ui["mock"])


def test_save_query_to_file(ui):
    page = ui["page"]
    page.evaluate("setSQL('SELECT l.location_gid FROM location l')")
    page.click("#svSaveCur")
    page.fill("#sdName", "Locations"); page.fill("#sdFolder", "Test")
    page.click("#svModal [data-sd=save]")
    page.wait_for_function("SV.items.length === 1")
    with open(os.path.join(ui["app"].folder, "otm_saved_queries.json"), encoding="utf-8") as f:
        assert json.load(f)["items"][0]["name"] == "Locations"
    assert "Locations" in page.inner_text("#qTabs")


def test_record_360(ui):
    page = ui["page"]
    page.click("nav button[data-tab=r360]")
    page.fill("#rTable", ""); page.fill("#rVal", "DEMO.SH0001"); page.click("#rOpen")
    page.wait_for_function("document.querySelector('#rRelInfo') && /with data/.test(document.querySelector('#rRelInfo').textContent) && !/counting/.test(document.querySelector('#rRelInfo').textContent)", timeout=30000)
    rel = page.inner_text("#rRel")
    assert "SHIPMENT_STOP" in rel and "SHIPMENT_STATUS" in rel
    page.click("nav button[data-tab=query]")


ROUND_TRIP = """(sql) => { DESIGN = dNewDesign(); const r = parseDesignerSql(sql); if (r.error) return {error: r.error};
  applyParsed(r.model); const g = dBuildSql(); const r2 = parseDesignerSql(g); let g2 = null;
  if (!r2.error) { applyParsed(r2.model); g2 = dBuildSql(); } return {gen: g, gen2: g2}; }"""
QUERY = "async s => { const r = await api('/api/query', {sql: s, maxRows: 5000}); return r.error ? {error: r.error} : {rows: r.rows, n: r.columns.length}; }"


@pytest.mark.parametrize("name,sql,expected", OK, ids=[c[0] for c in OK])
def test_designer_round_trip_keeps_results(ui, name, sql, expected):
    page = ui["page"]
    r = page.evaluate(ROUND_TRIP, sql)
    assert "error" not in r, r.get("error")
    assert r["gen"] == r["gen2"], "regenerating the SQL again must not change it"
    a, g = page.evaluate(QUERY, expected or sql), page.evaluate(QUERY, r["gen"])
    assert "error" not in a and "error" not in g, (a, g, r["gen"])
    assert a["n"] == g["n"] and sorted(map(tuple, a["rows"])) == sorted(map(tuple, g["rows"])), r["gen"]


@pytest.mark.parametrize("name,sql", BAD, ids=[c[0] for c in BAD])
def test_designer_refuses_what_it_cannot_show(ui, name, sql):
    r = ui["page"].evaluate("(sql) => { DESIGN = dNewDesign(); const r = parseDesignerSql(sql); return r.error || null; }", sql)
    assert r, "should be refused with a message"


def test_no_javascript_errors(ui):
    assert ui["errors"] == []
