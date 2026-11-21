# OTM Schema Explorer — user guide

> Unofficial tool, not affiliated with or endorsed by Oracle.

A local tool for Oracle Transportation Management. It finds the join path between any OTM tables, draws the joins as a diagram, writes the SQL for you and runs read-only queries against your instance.

## Run it

You need Python 3.10 or newer. Nothing else has to be installed.

```
python otm_explorer.py
```

Your browser opens with a **one-time launch link** (`http://127.0.0.1:8765/?k=…`). Only that browser can use the tool while the helper runs.

- If you open the tool in another browser, or lose the page, press **Enter** in the helper window to get a new link.
- `--port 9000` uses another port. `--no-browser` only prints the link.
- Everything is inside `otm_explorer.py`, so that one file is all you need.

## First steps

1. **Connection tab.** Enter your OTM URL (for example `https://xxxx.otmgtm.region.ocs.oraclecloud.com`), then your user as `DOMAIN.USER` and your password. Click **Connect & test**.
   - **Environments.** Click **+ New** to add DEV, TEST, UAT or PROD. Each one is saved with its name, URL and user, but never its password.
   - The helper keeps each password in memory until you stop it, so after the first login you switch environments with one click in the header menu.
   - The header and the SQL editor turn red on PROD, and every result line says which environment it came from.
   - Each request names its environment, so a query can never go to a different instance than the one shown.
   - All environments share one synced schema.
2. **Schema Data tab.** Click **Sync now**. This reads every table, your instance's real foreign keys and (with *All columns* ticked) every column, which the SQL editor uses for autocomplete. It then adds links inferred from OTM's naming rule (`SOURCE_LOCATION_GID` points to `LOCATION`, and so on). The result is saved next to the script in `otm_schema_cache.json`.
   - **Build current schema into this file** writes that schema into `otm_explorer.py` itself. The file then starts with your schema on any computer, even with no cache file and no connection.
   - A later **Sync now** overrides the built-in schema. **Revert to built-in schema** deletes the cache file and goes back to it.
   - **Download a copy with this schema** gives you a ready-to-share `otm_explorer.py` for colleagues and leaves your own file unchanged.
   - Load order: local cache file, then the schema built into the file, then the ~70-join starter pack.
3. **Query Designer tab.** Works like the SQL Server Management Studio designer: drag tables onto the diagram, tick columns, set sort, filter and aggregates in the grid, then click Run. Joins are added for you, including any bridge tables needed. Click a join line to change its type (INNER, LEFT, RIGHT, FULL) or to pick another relationship. Drag one column onto another to add a join yourself.
   - **The SQL box is editable and syncs back to the diagram**, like the SQL pane in SQL Server Management Studio. Edit the SQL, then click outside the box (or **Update diagram**, or Ctrl+S) and the diagram is rebuilt from it:
     - **A subquery in FROM becomes a derived-table box** (purple) with its columns and join line. Click ✎ on the box to edit the subquery.
     - Extra ON conditions are kept inside ON, which matters for LEFT joins. Example: `LEFT JOIN shipment_refnum r ON r.shipment_gid = s.shipment_gid AND r.shipment_refnum_qual_gid = 'BM'`.
     - Tables listed with commas, and Oracle `(+)` outer joins, become JOIN … ON with the same result.
     - Filters go to the grid's Filter column. OR groups, EXISTS and comparisons between two tables go to **Other conditions**.
     - GROUP BY, HAVING, ORDER BY (including by position, by alias and NULLS FIRST/LAST) and DISTINCT are all read back.
     - Box positions are kept, and the **Undo** button restores the diagram from before the update.
     - If the SQL uses something the diagram can't show (UNION, WITH, CONNECT BY, FETCH FIRST, NATURAL JOIN, USING, …), nothing is dropped. Your SQL is kept exactly as written and still runs, and the diagram pauses with an explanation and the place underlined. **Discard my SQL** brings the diagram back.
     - With steps, only the query inside `BASE AS ( … )` syncs with the diagram. The steps themselves are edited in the Steps panel.
     - Comments and optimizer hints aren't kept when the diagram rewrites the SQL.
   - **Steps** turn the query into a chain (`WITH … AS`). Each step reads the one before it:
     - *Calculate* steps add window functions (ROW_NUMBER, RANK, LAG/LEAD, FIRST/LAST_VALUE, running and moving totals, RATIO_TO_REPORT, LISTAGG…) or expressions, then filter on the results. You can't do that in a single Oracle SELECT.
     - *Summarize* steps group and total.
     - **Preview ▶** on any step runs the query up to that step.
   - **📚 Recipes** build common patterns from a short form: latest row per group, stop travel and dwell time, first and last value, top N per group, carrier ranking per lane, running total, moving average, duplicates, and share of total.
4. **Query Runner tab.** This is a full SQL editor:
   - **Autocomplete from your schema.** Type `s.` to get SHIPMENT's columns when `s` is SHIPMENT's alias. This also works for WITH steps and inline views. Typing part of a name matches the middle too, so `cost` finds TOTAL_ACTUAL_COST.
   - **Join suggestions.** After `JOIN ` you get the tables that link to the ones already in your query, with the ON condition filled in. After `ON ` you get the condition between the table you just joined and the others.
   - **Syntax colouring.** OTM table names are shown in teal, so a misspelled table stands out.
   - **Format** (Shift+Alt+F) re-indents the selection or the whole editor and puts keywords in upper case.
   - **Check SQL** (Ctrl+Shift+Enter) first checks your column and alias names against the synced schema on your computer. It then sends `SELECT * FROM (your query) WHERE 1 = 0`, so Oracle parses and validates the query without reading any rows. Problems are underlined in the editor and come with a plain-language tip.
   - **Value autocomplete.** Type `'` after `=` or inside `IN (` and you get real values from your instance.
     - GID columns list the values of the linked table with their descriptions: status values, refnum qualifiers, locations and so on.
     - Other conditions you already wrote narrow the list. With `ss.status_type_gid = 'X.ENROUTE'` in place, `ss.status_value_gid = '` shows only ENROUTE values.
     - Large lookup tables are searched by what you type, using the primary-key index.
     - Other text columns show their most used values from a sample of 20,000 rows, never a full table scan.
   - **Tabs.** Click **+** for another query tab. Each tab keeps its own SQL, undo history and results, and tabs survive closing the browser.
     - Double-click a tab to rename it. Middle-click or × closes it.
     - "Open in Query Runner" from the designer, Record 360 or Path Finder uses the current tab if it's empty, otherwise a new tab.
   - **Run all** (Ctrl+Alt+Enter) runs every statement in the tab (separated by `;`). Each result gets its own result tab, and failed statements show their error there.
   - **Run** (Ctrl+Enter) runs the selection, or the statement under the cursor when the editor holds several statements separated by `;`.
5. **Record 360 tab.** Paste any GID (for example a shipment) and click **Open**.
   - Leave the table empty and it is detected among the main OTM objects. An XID without a domain is also tried with your domain.
   - You see every field of the record. GIDs are clickable and show the linked record's name, and statuses, refnums and remarks appear as chips at the top.
   - **Related records** lists every table that points to this record, with row counts. Expand one to see its rows, and click any GID in them to move to that record. The trail at the top takes you back.
   - Only primary-key and indexed lookups run automatically, so it's safe on PROD. Links through a column without an index wait for you to click **Count**.
   - In Query Runner results, hover any GID cell and click ↗ to open it in Record 360.
6. **Path Finder tab.** Add two or more tables and click **Find join path**. You get a diagram, the join steps and SQL you can run. To force another route, click the × on any in-between table.

## Saved queries

- **Ctrl+S** (or ☆ Save) saves the SQL of the current Query Runner tab. Give it a name, a folder and an optional description, and tick ★ to make it a favourite.
  - The tab is then linked to the saved query. A **•** on the tab means it changed since it was saved, and Ctrl+S updates it. **Shift+Ctrl+S** saves it as a new query.
- **☆ Save** in the Query Designer keeps the diagram too: boxes, joins, grid and steps. Opening that query brings the diagram back.
- **The ★ Saved panel** (next to History):
  - It lists favourites, then folders, and you can search names, descriptions and SQL.
  - Clicking a query opens it in the Query Runner, or in the Designer if it was saved from there. The hover icons open, rename or move, duplicate or delete it.
  - In **History**, ☆ saves a past query.
- **Parameters:** write `:name` (or `&name`) in the SQL, e.g. `WHERE s.shipment_gid = :shipment_gid`. When you run it, the tool asks for the values once and remembers your last answers.
  - Text is quoted for you, numbers stay numbers, and `IN (:list)` takes comma-separated values.
  - Start a value with `=` to insert raw SQL (`=SYSDATE - 7`).
  - For dates, write `TO_DATE(:from_date, 'YYYY-MM-DD')` in the SQL.
  - Check SQL uses NULL for parameters, so it never asks.
- Everything is kept in **`otm_saved_queries.json`** next to the script. **Export** downloads it to share or back up. **Import** merges a file: new queries are added and newer versions replace older ones.

## When a query is slow

- **Every run shows where its time went**: `OTM` (Oracle running the query and OTM building the XML reply), `transfer` (receiving the reply, with its size) and `tool` (reading and showing the rows on your computer). Runs over 5 seconds get a **Why slow?** link.
- **🩺 Diagnose** (Query Runner) explains a slow query:
  - It shows how much each part took, using the last run.
  - It lists each table's size from Oracle's statistics, and whether its filter and join columns are indexed.
  - It points out SQL patterns that cost time: `TRUNC(date) =` or `UPPER(col) =` (no index use), `LIKE '%…'`, `NOT IN (SELECT …)`, a subquery in the SELECT list, a missing join (cartesian product), and ORDER BY / GROUP BY / DISTINCT over many rows.
  - **Run timing tests** runs your query two more times, once for the first row only and once to count all rows. The comparison tells you whether Oracle is slow to start or just has a lot of data to read. The execution plan is shown if your user can read V$SQL; OTM Cloud users normally can't.
- **■ Stop** stops waiting for a running query. OTM may still finish it in the background. The helper gives up by itself after 5 minutes.
- Facts from Oracle's documentation worth knowing:
  - OTM adds its domain security (VPD) filter to every table in a query for normal users, so the same SQL is often faster in SQL Developer or as DBA.ADMIN.
  - DB.XML replies are capped at 10 MB. Wide `SELECT *` on OTM tables reaches that quickly, and the timing line warns you when a reply gets close.
- Results now show every row, with fast scrolling and filtering. Only the rows on screen are drawn.

## How it talks to OTM

Queries go through OTM's DB.XML servlet with Basic Auth:
`POST /GC3/glog.integration.servlet.DBXMLServlet?command=xmlExport`

- Your user needs access to that servlet. An integration user or an ADMIN-type user usually has it.
- Your password is kept only in the memory of the local helper. It is never written to disk.
- The helper only listens on 127.0.0.1. Only the browser that opened the launch link gets the session cookie, and every request also needs a token generated for that run. See [SECURITY.md](../SECURITY.md).
- Only `SELECT` and `WITH` statements are allowed. Rows are capped by the "Max rows" setting.

## Tips

- Check SQL catches parse and name errors: wrong columns, missing tables, GROUP BY mistakes, window functions in WHERE, and so on. It can't catch errors that only show up while reading data, such as `TO_NUMBER` on text.
- Give every expression an alias, like `COUNT(*) AS CNT`, and avoid duplicate column names. OTM returns each column as an XML attribute, so both of these break the response.
- If sync finds 0 foreign keys, OTM Cloud may be hiding constraints from your user. The naming-rule inference still covers most joins. Joins that are only inferred show as dashed lines and carry a `-- verify` comment in the SQL.
- Hub tables such as LOCATION, CURRENCY and STATUS_VALUE are never used as in-between steps by default. You can edit that list under "Avoid these tables".
- You can import a CSV or TSV file with the columns `CHILD_TABLE, CHILD_COLUMN, PARENT_TABLE, PARENT_COLUMN`. The optional `CONSTRAINT_NAME` column groups composite keys.

Optional environment variables pre-fill the connection: `OTM_URL`, `OTM_USER` and `OTM_PASS`. If the password box is left empty, `OTM_PASS` is used.
