#!/usr/bin/env python3
"""Build the single-file release: dist/otm_explorer.py

Takes the helper (src/server/otm_explorer.py), the web page (src/web/page.html + the JS parts) and the
third-party libraries (third_party/), puts them together into one HTML page, compresses it (zlib) and
embeds it in the helper. The output needs nothing but Python 3.

    python tools/build.py                       # -> dist/otm_explorer.py, dist/otm_explorer.py.sha256
    python tools/build.py --version 1.10.0      # stamp a version (the release workflow uses the git tag)
    python tools/build.py --html                # also write dist/otm_explorer.html (for --dev-html)
"""
import argparse
import base64
import hashlib
import os
import re
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "src", "web")
CM = os.path.join(ROOT, "third_party", "codemirror-5.65.21")
SF = os.path.join(ROOT, "third_party", "sql-formatter-15.10.0")

CSS = [os.path.join(CM, "lib", "codemirror.css"), os.path.join(CM, "addon", "hint", "show-hint.css")]
JS = [os.path.join(CM, p) for p in ("lib/codemirror.js", "mode/sql/sql.js", "addon/hint/show-hint.js",
                                    "addon/comment/comment.js", "addon/edit/matchbrackets.js",
                                    "addon/edit/closebrackets.js")] + [os.path.join(SF, "sql-formatter.min.js")]
PARTS = {"/*__EDITOR_JS__*/": "editor.js", "/*__PROFILES_JS__*/": "profiles.js", "/*__R360_JS__*/": "record360.js",
         "/*__TABS_JS__*/": "runner_tabs.js", "/*__DSQL_JS__*/": "designer_sql.js", "/*__PERF_JS__*/": "perf.js",
         "/*__SAVED_JS__*/": "saved.js"}


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def licence_banner():
    """Full licence texts of the bundled libraries (MIT requires them in every copy)."""
    cm = read(os.path.join(CM, "LICENSE")).strip().replace("*/", "* /")
    sf = read(os.path.join(SF, "LICENSE")).strip().replace("*/", "* /")
    return ("/*! Bundled third-party code\n\n--- CodeMirror 5.65.21 ---\n" + cm +
            "\n\n--- sql-formatter 15.10.0 ---\n" + sf + "\n*/\n")


def build_page():
    page = read(os.path.join(WEB, "page.html"))
    banner = licence_banner()
    css = "\n".join(read(p) for p in CSS)
    js = "\n".join("/* --- %s --- */\n%s" % (os.path.relpath(p, ROOT).replace(os.sep, "/"), read(p)) for p in JS)
    js = js.replace("</script", "<\\/script")
    for ph in ["<!--VENDOR_CSS-->", "<!--VENDOR_JS-->"] + list(PARTS):
        if page.count(ph) != 1:
            sys.exit("build: placeholder %s must appear exactly once in page.html" % ph)
    page = (page.replace("<!--VENDOR_CSS-->", "<style>\n" + css + "\n</style>")
                .replace("<!--VENDOR_JS-->", "<script>\n" + banner + js + "\n</script>"))
    for ph, fn in PARTS.items():
        page = page.replace(ph, read(os.path.join(WEB, fn)))
    return page


def block(name, payload):
    lines = [payload[i:i + 120] for i in range(0, len(payload), 120)] or [""]
    return name + " = (\n" + "\n".join('    "%s"' % ln for ln in lines) + "\n)"


def replace_block(src, name, payload):
    start = src.index("\n" + name + " = (\n") + 1
    end = src.index("\n)", start) + 2
    return src[:start] + block(name, payload) + src[end:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", help="version to stamp, e.g. 1.10.0 (a leading 'v' is removed)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="output folder (default: dist)")
    ap.add_argument("--html", action="store_true", help="also write otm_explorer.html")
    a = ap.parse_args()

    page = build_page()
    src = read(os.path.join(ROOT, "src", "server", "otm_explorer.py"))
    if a.version:
        v = a.version.lstrip("vV")
        if not re.match(r"^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$", v):
            sys.exit("build: --version must look like 1.2.3 or 1.2.3-beta.1")
        src, n = re.subn(r'^VERSION = ".*"$', 'VERSION = "%s"' % v, src, count=1, flags=re.M)
        if n != 1:
            sys.exit("build: VERSION line not found in the helper")
    payload = base64.b64encode(zlib.compress(page.encode("utf-8"), 9)).decode()
    src = replace_block(src, "EMBEDDED_HTML", payload)
    src = replace_block(src, "EMBEDDED_SCHEMA", "")          # releases never carry anyone's schema
    compile(src, "otm_explorer.py", "exec")

    os.makedirs(a.out, exist_ok=True)
    out = os.path.join(a.out, "otm_explorer.py")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(src)
    digest = hashlib.sha256(src.encode("utf-8")).hexdigest()
    with open(out + ".sha256", "w", encoding="utf-8", newline="\n") as f:
        f.write("%s  otm_explorer.py\n" % digest)
    if a.html:
        with open(os.path.join(a.out, "otm_explorer.html"), "w", encoding="utf-8", newline="\n") as f:
            f.write(page)
    ver = re.search(r'^VERSION = "(.*)"$', src, re.M).group(1)
    print("built %s  v%s  (%d KB, page %d KB)  sha256 %s" % (os.path.relpath(out, ROOT), ver, len(src) // 1024, len(page) // 1024, digest[:16]))


if __name__ == "__main__":
    main()
