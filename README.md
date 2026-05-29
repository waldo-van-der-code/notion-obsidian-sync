# notion-obsidian-sync

A battle-tested daemon that keeps a Notion database in two-way sync with a folder of local Markdown files, and auto-generates an Obsidian kanban board from the live state.

Built for people who want Notion as a task cockpit (mobile, sharing, rich views) while keeping a local Markdown view that plays nicely with editors like Obsidian, VS Code, or just `grep`.

---

## What it does

```
Notion database  ←→  ~/notes/todos/*.md  ←→  kanban.md (Obsidian board)
```

All three directions are live:

- **Notion → Local**: new or changed Notion pages pull to `.md` files with YAML frontmatter within one poll interval (default 5 min, or immediately via HTTP trigger)
- **Local → Notion**: edits to `.md` files (title, status, horizon, outcome, category, body) push to Notion within ~500 ms via a file watcher — no poll needed
- **Kanban → Notion**: dragging a card to a different column in the Obsidian kanban plugin updates the Notion status within ~1 s, via a dedicated `kanban.md` watcher
- **Local create**: drop a new `.md` file in the folder → a Notion page is created automatically
- **Instant Notion→Local**: HTTP trigger endpoint + Cloudflare Tunnel lets webhook integrations (n8n, Zapier) force an immediate poll on any Notion change
- **Dead-letter journal**: failed syncs are tracked in a local SQLite database; `node deadletter.js --status` shows stuck files
- **Heartbeat alerts**: if the daemon goes silent for 30+ minutes, a Telegram message is sent (credentials via macOS Keychain or env vars)

### Conflict resolution

When both sides change between polls, the daemon compares timestamps:

- **Local file mtime > Notion `last_edited_time`** → local wins, push to Notion
- **Notion is newer** → remote wins, pull overwrites local

Both cases are logged at `warn` level so you can audit them.

### Safety guards (learned from a 28-task wipeout)

1. **Empty-kanban guard** — if `kanban.md` is parsed with zero active items but internal state has active items, the sync aborts. Fires when Obsidian writes a blank file or races with the daemon.

2. **Catastrophic-drop guard** — if removing items from the kanban would affect more than 5 items *and* more than 50% of the active board in one pass, the drop is aborted. Status changes and new cards still go through.

3. **Concurrency guard** — a `pollInFlight` flag prevents the scheduled poll and the HTTP trigger from running simultaneously. The second caller skips and logs.

4. **Mtime skip** — `syncKanbanToNotion` checks `kanban.md` mtime before parsing. If the file hasn't changed since the last run, the parse is skipped — so the every-5-min poll has no extra cost for the kanban path.

All guards log a `SAFETY:` warn entry so you know what happened.

---

## Notion database schema

Create a database with these properties (exact names matter):

| Property | Type |
|---|---|
| `Name` | Title |
| `Status` | Status (options: `Backlog`, `In progress`, `Done`) |
| `Horizon` | Select (options: `Now`, `Later`) |
| `Outcome` | Select (options: `Completed`, `Dropped`) |
| `Category` | Multi-select (any tags you want) |

The daemon validates the schema on startup and exits with a clear error if `Status` or `Horizon` are missing.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/waldo-van-der-code/notion-obsidian-sync.git
cd notion-obsidian-sync
npm install
```

### 2. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Copy the **Internal Integration Token** (`secret_...`)
3. Open your database → **···** → **Connections** → add your integration

### 3. Configure

Config is resolved in priority order: **env var → config.json → built-in default**.

The simplest approach — set everything via env vars (also what the launchd plist uses):

```bash
export NOTION_TOKEN=secret_YOUR_TOKEN
export NOTION_DB_ID=YOUR_DATABASE_ID
export LOCAL_ROOT=/Users/you/notes/todos
export KANBAN_PATH=/Users/you/notes/kanban.md
```

Or copy `config.example.json` to `config.json` and fill in your values:

```json
{
  "dbId": "YOUR_DATABASE_ID",
  "localRoot": "/Users/you/notes/todos",
  "kanbanPath": "/Users/you/notes/kanban.md"
}
```

The database ID is the 32-character hex string in the Notion page URL. To run with a non-default config file path: `CONFIG_PATH=/path/to/my.json node index.js`

See `config.example.json` for the full list of options.

### 4. Run

```bash
# Normal mode (watches files + polls every 5 min)
npm start

# Dry-run (shows what would happen, no writes)
npm run dry-run
```

### 5. Run as a background service

**macOS**: copy `extras/com.yourname.notion-obsidian-sync.plist` to `~/Library/LaunchAgents/`, edit the paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.notion-obsidian-sync.plist
```

**Linux (systemd)**: copy `extras/notion-obsidian-sync.service` to `~/.config/systemd/user/`, edit the paths, then:

```bash
systemctl --user enable --now notion-obsidian-sync
```

---

## Local file format

Each synced item is a `.md` file with YAML frontmatter:

```markdown
---
notion_id: abc123...
status: In progress
horizon: Now
outcome:
category: work, project-x
last_synced_at: 2026-04-30T12:00:00.000Z
last_modified_at: 2026-04-30T11:58:00.000Z
---

# My task title

Optional body content that syncs to the Notion page body.

<!-- local: notes below this line are not synced to Notion -->
Private notes here — only visible locally.
```

| Field | Owner | Notes |
|---|---|---|
| `notion_id` | Notion | Set on first pull or push; never edit manually |
| `last_synced_at` | daemon | Updated on every pull; read-only |
| `last_modified_at` | daemon | Set from file mtime when a push succeeds; reflects when you last edited the file |
| `status` | local | Push wins on conflict |
| `horizon` | local | Push wins on conflict |
| `outcome` | local | Push wins on conflict |
| `category` | local | Comma-separated; must match `validCategories` if that list is non-empty |
| title (H1) | local | Push wins on conflict |
| body | local | Everything below the H1, above the `<!-- local: -->` marker |
| local notes | never synced | Everything below the `<!-- local: -->` marker |

---

## How each sync path works

### Local `.md` → Notion (file watcher, ~500 ms)

chokidar watches `LOCAL_ROOT`. On any `.md` change, the daemon debounces 500 ms, parses the file, hashes the fields, and pushes only if the hash changed. A `last_modified_at` timestamp (from `fs.stat` mtime) is written back to the frontmatter on success so you can see when you last edited it.

Validation runs before every push. If a field value isn't in the allowed enum (e.g. an unknown `category`), the push is rejected and a `<!-- sync-error: -->` comment is injected at the bottom of the file. Fix the frontmatter and save to retry — the daemon will pick it up immediately.

### kanban.md → Notion (kanban watcher, ~1 s)

A second chokidar watcher monitors `KANBAN_PATH` specifically. When Obsidian rewrites the file after a card drag, the watcher debounces 800 ms (after chokidar's own 500 ms write-finish stabilization) and calls `syncKanbanToNotion`. That function:

1. Checks `mtime` — skips entirely if the file hasn't changed since last run
2. Parses the column headings and card wikilinks
3. Pushes any status changes to Notion (e.g. `Backlog → In progress`)
4. Creates local files + Notion pages for new cards added directly in the kanban UI
5. Marks items removed from active columns as `Done/Dropped` (with catastrophic-drop guard)

The watcher is suppressed while the daemon is writing `kanban.md` itself (using a `__kanban__` suppress token), so self-writes don't loop back.

### Notion → Local (poll, every 5 min or triggered)

The daemon queries the Notion DB for all in-scope items (default: `Backlog` + `In progress`). For each item whose `last_edited_time` changed since the last sync, it fetches the page body and writes the local `.md` file. On conflict (both sides changed), the newer timestamp wins.

---

## HTTP trigger endpoint

The daemon runs a local HTTP server on port 9876 (configurable via `TRIGGER_PORT`). Send a `POST /trigger-poll` to kick off an immediate poll without waiting for the interval:

```bash
curl -X POST http://127.0.0.1:9876/trigger-poll
```

Use this to make Notion→Local sync effectively instant. The pattern that works:

1. Expose the endpoint externally with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (or similar)
2. Register a Notion webhook pointing at your n8n/Zapier/Make instance
3. Have the automation POST to your tunnel URL on every Notion change

The daemon uses `127.0.0.1` (not `localhost`) — make sure your curl command and automation use the right host.

### Useful alias

```bash
alias sync-now='curl -s -X POST http://127.0.0.1:9876/trigger-poll && echo "sync triggered"'
```

---

## Configuration reference

| Env var | config.json key | Default | Description |
|---|---|---|---|
| `NOTION_TOKEN` | — | — | Notion integration token (required if `tokenPath` not set) |
| `NOTION_DB_ID` | `dbId` | — | Notion database ID (required) |
| `NOTION_TOKEN_PATH` | `tokenPath` | `~/.config/notion/token` | Path to token file |
| `LOCAL_ROOT` | `localRoot` | `~/notion-todos` | Folder for local `.md` files |
| `ARCHIVE_DIR` | `archiveDir` | `<localRoot>/.archive` | Where completed files are archived |
| `KANBAN_PATH` | `kanbanPath` | `<localRoot>/../kanban.md` | Output path for the kanban board |
| `STATE_PATH` | `statePath` | `~/.config/notion-obsidian-sync/state.json` | Sync state file |
| `LOG_PATH` | `logPath` | `~/.config/notion-obsidian-sync/sync.log` | Log file (JSON lines, 5 MB rotation) |
| `LOCK_PATH` | `lockPath` | `/tmp/notion-obsidian-sync.lock` | Lockfile (prevents duplicate instances) |
| `POLL_INTERVAL_MS` | `pollIntervalMs` | `300000` (5 min) | How often to poll Notion |
| `TRIGGER_PORT` | `triggerPort` | `9876` | Port for the HTTP trigger endpoint |
| `CONFIG_PATH` | — | `./config.json` | Path to config file |

Custom field enums (via `config.json` only):

| Key | Default | Notes |
|---|---|---|
| `validStatuses` | `["Backlog", "In progress", "Done"]` | Must match your Notion Status options |
| `validHorizons` | `["Now", "Later", ""]` | Must match your Horizon select options |
| `validOutcomes` | `["Completed", "Dropped", ""]` | Must match your Outcome select options |
| `validCategories` | `[]` (any value accepted) | If non-empty, pushes with unlisted categories are rejected |

> **Tip:** If a push is rejected with `Invalid category "X"`, add `"X"` to `validCategories` in `config.json` and restart the daemon. The rejected file will be automatically retried on startup.

---

## Known edge cases

- **Obsidian kanban plugin race**: if the plugin rewrites `kanban.md` while the daemon is mid-poll, the empty-kanban guard will block any drops. The next poll (or a manual `POST /trigger-poll`) resolves it cleanly.
- **kanban.md is both input and output**: the daemon rebuilds it on every poll, but also watches it for changes. The `__kanban__` suppress token prevents the daemon's own writes from triggering a sync loop.
- **Body sync is best-effort**: complex Notion blocks (databases, synced blocks, embeds) are flattened to markdown. Text, headings, bullets, and code blocks round-trip cleanly.
- **Rename detection**: if you rename a file in Obsidian (which creates a new file), the daemon detects the `notion_id` match and updates state + pushes the new title to Notion.
- **`last_synced_at` vs `last_modified_at`**: `last_synced_at` is updated on every pull (daemon-owned). `last_modified_at` is set only when a push succeeds and reflects your last edit (from `fs.stat` mtime). Use `last_modified_at` to see when you last touched the file.

---

## Multi-database setup (running two instances)

You can run multiple instances of the daemon — one per Notion database — each with its own config, state file, lock file, and kanban board. This is useful when you want to keep a project-specific board separate from a personal todo board.

### Example: personal todos + project task tracker

**Instance 1 — personal todos** (`~/.config/notion/personal.json`):
```json
{
  "dbId": "YOUR_PERSONAL_DB_ID",
  "localRoot": "/Users/you/notes/todos",
  "kanbanPath": "/Users/you/notes/kanban.md",
  "statePath": "/Users/you/.config/notion/state-personal.json",
  "lockPath": "/tmp/notion-sync-personal.lock"
}
```

**Instance 2 — project board** (`~/.config/notion/project.json`):
```json
{
  "dbId": "YOUR_PROJECT_DB_ID",
  "localRoot": "/Users/you/projects/myproject/todos",
  "kanbanPath": "/Users/you/projects/myproject/kanban-project.md",
  "statePath": "/Users/you/.config/notion/state-project.json",
  "lockPath": "/tmp/notion-sync-project.lock",
  "validStatuses": ["Not started", "In progress", "Done"],
  "validCategories": []
}
```

Run each with its own config path:
```bash
CONFIG_PATH=~/.config/notion/personal.json node index.js
CONFIG_PATH=~/.config/notion/project.json  node index.js
```

Or register each as a separate launchd agent (macOS) by copying the plist template twice with different labels and env vars.

### Project-specific frontmatter

When syncing a project board, you can add custom fields to your `.md` files beyond the standard schema. Fields not in the Notion schema are ignored by the sync — they stay local-only (or you can add them as custom properties to your Notion DB).

Example WAG (Work Against Goals) ticket format for a project board:
```markdown
---
notion_id: abc123...
status: Not started
epic: Epic 1 — Telegram Connection
assignee: henrik
---

# WAG-002: Set up Telegram bot

Tasks:
- Set up bot via BotFather
- Connect to Notion workspace

<!-- local: private notes below this line are not synced -->
```

---

## Local-first pattern — reducing Notion API costs

The recommended way to work with this daemon is **local-first**: write and edit `.md` files directly, let the daemon push to Notion, rather than editing Notion and waiting for a pull.

This reduces Notion API calls significantly:

| Pattern | API calls |
|---|---|
| Edit Notion, wait for pull (every 5 min) | 1 poll + 1 page fetch per change |
| Edit local `.md`, push triggers immediately | 1 write per change, no polling needed |
| Drag card in Obsidian kanban | 1 status update, triggered within ~1 s |

For teams using Notion as a read/view layer (dashboards, mobile access, sharing) while doing all editing locally, the daemon can run with `POLL_INTERVAL_MS=3600000` (hourly) — pulling Notion changes rarely — and rely on the file watcher for near-instant pushes.

---

## License

MIT
