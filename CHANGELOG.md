# Changelog

## 1.10.0-beta.1 — first public release

- **Security:** the page and API now only work in the browser that opened the one-time launch link (session cookie). Press Enter in the helper window for a new link.
- **Readable source** in `src/`, with a reproducible build (`tools/build.py`) and bundled libraries in `third_party/` with their licences.
- **Automated tests:** helper tests on Windows, macOS and Linux (Python 3.9–3.13), browser tests with Playwright, and 38 SQL round-trip checks for the Designer.
- **Fixed:** on Python 3.9, a slow OTM showed a raw `socket.timeout` error instead of the friendly time-out message.
- Unofficial-tool disclaimer in the page, the helper and the docs.

## Earlier versions (private)

- **1.9:** saved queries (folders, favourites, export/import), `:parameters`.
- **1.8:** timing breakdown per run, Diagnose, Stop, a fast results grid that draws only visible rows.
- **1.7:** Query Runner tabs and Run all; editable Designer SQL that syncs back to the diagram (derived tables, ON conditions, `(+)` joins).
- **1.6:** Record 360, value autocomplete, DEV/TEST/PROD environments.
- **1.5:** SQL editor (autocomplete, join suggestions, format, Check SQL), schema built into the file.
- **1.4:** Steps with window functions, recipes.
- **1.0–1.3:** Path Finder, Query Designer, Table Explorer, full schema sync.
