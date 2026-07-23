<p align="center">
  <picture>
    <img src="logo.svg" width="80" height="80" alt="ttracker logo">
  </picture>
</p>
<h1 align="center">ttracker</h1>

<p align="center">
  <strong>Never lose a Claude session again.</strong>
  <br>
  Terminal session tracker for iTerm2 + Claude Code with a web dashboard.
</p>

<p align="center">
  macOS only &middot; iTerm2 &middot; Zero dependencies
  <br><br>
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#cli-tools">CLI Tools</a>
</p>

---

You have 10 Claude Code sessions open across iTerm2 windows. Your Mac restarts. Everything is gone. Which sessions were open? What were you working on?

**ttracker** snapshots your terminal sessions every 10 minutes and gives you a web dashboard to restore them all with one click.

## Quick Start

**1.** Clone and start:
```bash
git clone https://github.com/sharon-fdm/ttracker.git
cd ttracker
node server.js
```

**2.** Open in your browser: **http://localhost:3847**

**3.** Bookmark it. The port never changes.

**Optional:** Add an alias for instant access:
```bash
echo "alias ttracker='node ~/repos/ttracker/server.js'" >> ~/.zshrc
source ~/.zshrc
```
Then just type `ttracker`.

## Getting Started

Once the server is running and the dashboard is open:

### 1. Pick up your live terminals

Click **Snapshot Now**. ttracker scans all open iTerm2 windows and populates the **Active Sessions** table. Every terminal running Claude Code is automatically detected with its session ID, badge, folder, and process.

### 2. Import your history

Already have past Claude sessions on disk? Use the **Import Sessions** dropdown at the top of the dashboard. Select a project folder (e.g. `~/repos/fleet`) and click **Import Sessions**. ttracker scans `~/.claude/projects/` for all JSONL session files, extracts the topic from the first message, generates a badge, and adds them to the **Parked Sessions** table. Sessions already tracked are skipped.

### 3. Keep it running

Leave the server running in a terminal. It snapshots every 10 minutes in the background. If a terminal dies or your Mac restarts, the missing sessions appear with a red dot and a **Restore** button. Click it to reopen the terminal with its badge and `claude --resume`.

### 4. Day-to-day workflow

- **Starting work:** Open the dashboard, click **Focus** to jump to a session, or **+ New Claude Session** to start fresh
- **Switching context:** Use **Focus** buttons to hop between terminals, or **Minimize All** to clear the screen
- **Done with a session:** Click **Park** to close it and save to history. You can restore it anytime
- **Finding old work:** Use **Search** to find any session by keyword across all conversations
- **Adding context:** Edit badges and notes directly in the table to remind yourself what each session is for

## Features

### Dashboard

| Feature | Description |
|---------|-------------|
| **Active Sessions** | Live table of all open terminals with status indicators |
| **Parked Sessions** | Terminals you intentionally closed, saved for later |
| **Auto-refresh** | Dashboard updates every 5 seconds |
| **Solarized theme** | Light and dark modes with one-click toggle. Preference saved |

### Session Management

| Action | What it does |
|--------|-------------|
| **Focus** | Brings a terminal window to the front, even if minimized |
| **Park** | Closes a terminal and saves it to history with command history |
| **Restore** | Reopens a session in a new iTerm2 window with `claude --resume` |
| **Minimize All** | Minimizes every iTerm2 window to the dock |

### Session Data

| Feature | Description |
|---------|-------------|
| **Editable badges** | Click to rename any session. Updates iTerm2 badge live |
| **Notes** | Add status text to any session. Persists across restarts |
| **Folder** | Shows the working directory of each terminal |
| **Command history** | Saves recent shell commands when parking non-Claude terminals |

### Search

Two-phase search across all Claude sessions (active and parked):

1. **Surface search** - badges, session names, notes (instant)
2. **Deep search** - scans conversation messages in session files (< 1 second for 70+ sessions)

Results show exactly where each match was found with **Focus** or **Restore** buttons.

### Crash Recovery

- Snapshots all terminals every 10 minutes automatically
- Missing sessions survive server restarts
- After a Mac restart: start `ttracker`, open the dashboard, click **Restore** on each session
- Sessions resume exactly where you left off via `claude --resume`

### New Sessions

Click **+ New Claude Session** with an optional badge name. Opens a new iTerm2 window with `claude --dangerously-skip-permissions` ready to go.

## How It Works

```
Browser (localhost:3847)
  |
  +-- GET  /                    Dashboard
  +-- GET  /api/sessions        Active sessions + liveness
  +-- GET  /api/history         Parked sessions
  +-- GET  /api/search?q=...    Two-phase search
  +-- POST /api/snapshot        Force snapshot
  +-- POST /api/focus/:id       Bring window to front
  +-- POST /api/park/:id        Park + close terminal
  +-- POST /api/restore/:id     Restore session
  +-- PUT  /api/badge/:id       Update badge
  +-- PUT  /api/note/:id        Update note
  ...

server.js
  +-- Snapshots iTerm2 via AppleScript every 10 min
  +-- Tracks Claude session IDs from ~/.claude/sessions/
  +-- Reads/writes snapshots/state.json
  +-- Binds to 127.0.0.1 only (localhost)
```

**Zero dependencies.** Built entirely on Node.js built-in modules (`http`, `fs`, `child_process`). No npm install needed.

**Single file.** The entire server, API, and dashboard UI live in `server.js` (~1600 lines).

**Local only.** Binds to `127.0.0.1` - not accessible from other machines on your network.

## CLI Tools

The shell scripts work independently of the web server:

```bash
./status.sh       # One-shot terminal status report
./daemon.sh --bg  # Background snapshot daemon (alternative to web server)
./restore.sh      # Restore missing sessions interactively
./done.sh         # Park current session (run after /exit from Claude)
./history.sh      # Browse and reopen parked sessions
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TT_PORT` | `3847` | Server port |
| `TT_INTERVAL` | `10` | Snapshot interval in minutes |
| `TT_SAFE_MODE` | `0` | Set to `1` to use default Claude permissions instead of `--dangerously-skip-permissions` |

## Data Storage

All state lives in `snapshots/state.json` (gitignored):

- **snapshot** - current terminal state (sessions, badges, folders)
- **history** - parked sessions with timestamps
- **notes** - user-added notes and saved command history

Timestamped snapshot backups are kept in `snapshots/` (last 50).

## Requirements

- macOS
- [iTerm2](https://iterm2.com/)
- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## License

MIT
