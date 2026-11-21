# Security policy

## Reporting a problem

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead: go to the **Security** tab of this repository and click **Report a vulnerability**.

Never include passwords, real OTM URLs or business data in a report. Describe the problem with made-up values.

Fixes go into the latest release. Older versions aren't patched.

## How the tool protects you

| Threat | Protection |
|---|---|
| Other websites sending requests to the helper | The helper only answers `Host: 127.0.0.1 / localhost`. Every API call needs the `X-Token` header (which a cross-site page can't set without a CORS preflight, and the helper sends no CORS headers) plus a `SameSite=Strict` cookie. |
| Other programs or other users on the same computer (for example a shared remote-desktop or Citrix server) | The page and the API need a session cookie. Only the browser that opens the **one-time launch link** gets it. The link's key is spent on first use, and a new one appears when you press Enter in the helper window. |
| Password exposure | Passwords stay in the helper's memory only, never on disk or in the browser. They are sent to OTM over HTTPS with certificate checks, unless you tick *Skip TLS certificate check*. |
| Accidental changes in OTM | Only `SELECT` / `WITH` statements are sent, after comments and string literals are stripped for the check. |

## What it doesn't protect against

- **Malware running as your own Windows/macOS/Linux user.** It can read your browser's cookies or the helper's memory.
- **Anyone who knows your OTM password.**
- **The read-only check is not a security boundary.** A `SELECT` can still call PL/SQL functions. What your OTM user may do is decided by OTM.
- **`--launch-key KEY` makes a reusable key.** It's meant for automation and tests; keep it secret.

## Data the tool stores

| Where | What |
|---|---|
| `otm_schema_cache.json` (next to the script) | Table, column and join names of your instance. No rows. |
| `otm_saved_queries.json` (next to the script) | Your saved SQL, including any values typed into it. |
| Inside `otm_explorer.py`, only if you click *Build current schema into this file* | The same schema data. |
| Browser storage for `127.0.0.1:<port>` | Environments (name, URL, user), query tabs, history, Designer state, parameter values. |

Releases never contain anyone's schema: the build always empties that slot.
