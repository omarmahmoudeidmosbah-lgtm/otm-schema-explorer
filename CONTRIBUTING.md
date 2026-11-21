# Contributing

Thanks for helping. Bug reports from real OTM instances, especially other versions and on-premise installs, are the most valuable contributions.

## Reporting a bug

Open an issue with:
- **Versions:** the tool's version (shown in the page footer), your OTM version, and your browser and OS.
- **What happened** and what you expected.
- **The error message.** Remove URLs, user names and business values first.

## Working on the code

```
src/server/otm_explorer.py   helper: Python standard library only, no pip packages
src/web/page.html            page layout, styles and the main script
src/web/*.js                 parts of the main script (editor, designer SQL sync, saved queries…)
third_party/                 bundled libraries (MIT) - update them together with THIRD_PARTY_NOTICES.md
tools/build.py               builds dist/otm_explorer.py
tests/                       pytest: helper tests, Playwright browser tests, mock OTM server
```

```
python tools/build.py --html          # dist/otm_explorer.py and dist/otm_explorer.html
python dist/otm_explorer.py           # try it
python dist/otm_explorer.py --dev-html   # serve dist/otm_explorer.html instead of the built-in page

pip install -r tests/requirements-ui.txt
python -m playwright install chromium
python -m pytest tests
```

The tests start `tests/mock_otm.py`, a fake DB.XML servlet backed by DuckDB with a few OTM-like tables. Its login is `DEMO.ADMIN` / `secret`.

## Ground rules

- **The release stays one file** that needs nothing but Python 3.9+. No runtime dependencies, and no calls to other servers (no CDNs or telemetry).
- **Never commit real data:** no `otm_schema_cache.json` or `otm_saved_queries.json`, no instance URLs, user names or business values in tests and screenshots.
- **Add or update a test** for every change. Anything touching the Designer's SQL sync must keep `tests/sql_cases.py` passing (the results must stay identical).
- **Plain, friendly messages for users.** Say what happened and what to do next.

## Releasing

1. Update `CHANGELOG.md`.
2. Tag and push: `git tag v1.10.0 && git push origin v1.10.0` (a tag with a `-`, like `v1.11.0-beta.1`, becomes a pre-release).
3. The *Release* workflow builds `otm_explorer.py` with that version, runs all tests and publishes it with its SHA-256.
