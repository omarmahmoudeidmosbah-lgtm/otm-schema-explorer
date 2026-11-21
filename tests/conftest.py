"""Shared fixtures: build the single file once, start the mock OTM and the helper on free ports."""
import importlib.util
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")      # the helper must reach the mock directly
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
ENV = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
LAUNCH_KEY = "test-launch-key"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_port(port, proc, timeout=60, log=None):
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError("process exited early: " + (open(log, encoding="utf-8").read() if log else ""))
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise RuntimeError("timed out waiting for port %d" % port)


@pytest.fixture(scope="session")
def built(tmp_path_factory):
    """Build dist/otm_explorer.py into a temp folder (the same way the release does)."""
    out = tmp_path_factory.mktemp("dist")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--out", str(out)], check=True, env=ENV)
    return str(out / "otm_explorer.py")


def load_module(path, name="otm_explorer_under_test"):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def ox(built, tmp_path):
    """A fresh copy of the built helper, imported as a module, living in its own temp folder."""
    p = tmp_path / "otm_explorer.py"
    shutil.copy(built, p)
    return load_module(str(p), "ox_%d" % id(p))


@pytest.fixture(scope="session")
def mock_url(tmp_path_factory):
    pytest.importorskip("duckdb")
    pytest.importorskip("sqlglot")
    port = free_port()
    log = str(tmp_path_factory.mktemp("mock") / "mock.log")
    with open(log, "w", encoding="utf-8") as out:      # logs go to a file: an unread pipe would block the process
        proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "mock_otm.py"), str(port)],
                                stdout=out, stderr=subprocess.STDOUT, env=ENV)
    try:
        wait_port(port, proc, log=log)
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def last_sql(mock_url):
    with urllib.request.urlopen(mock_url + "/last-sql") as r:
        return r.read().decode()


class App:
    def __init__(self, folder, port, proc, key):
        self.folder, self.port, self.proc, self.key = folder, port, proc, key
        self.base = "http://127.0.0.1:%d" % port

    @property
    def launch(self):
        return "%s/?k=%s" % (self.base, self.key)


def start_app(built, folder, launch_key=LAUNCH_KEY):
    os.makedirs(folder, exist_ok=True)
    target = os.path.join(folder, "otm_explorer.py")
    shutil.copy(built, target)
    port = free_port()
    cmd = [sys.executable, target, "--no-browser", "--port", str(port)] + (["--launch-key", launch_key] if launch_key else [])
    log = os.path.join(folder, "helper.log")
    with open(log, "w", encoding="utf-8") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=out, stderr=subprocess.STDOUT, text=True, encoding="utf-8", env=ENV, cwd=folder)
    wait_port(port, proc, log=log)
    app = App(folder, port, proc, launch_key)
    app.log = log
    if not launch_key:                                   # read the one-time key from the helper's output
        app.key = wait_log_key(app)
    return app


def wait_log_key(app, after=0, timeout=20):
    """The newest launch key printed by the helper (optionally: the (after+1)-th one)."""
    end = time.time() + timeout
    while time.time() < end:
        keys = re.findall(r"(?:Open:|New link[^:]*:)\s+\S+\?k=([\w-]+)", open(app.log, encoding="utf-8").read())
        if len(keys) > after:
            return keys[-1]
        time.sleep(0.1)
    raise RuntimeError("no launch link in the helper output")


@pytest.fixture()
def app(built, tmp_path):
    a = start_app(built, str(tmp_path / "app"))
    yield a
    a.proc.terminate()
    a.proc.wait(timeout=10)
