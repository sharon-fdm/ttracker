# ttracker

Terminal session tracker for iTerm2 + Claude Code. Web dashboard to manage, park, restore, and search Claude sessions.

## Quick Start

```bash
node server.js
```

Open **http://localhost:3847** in your browser. Bookmark it.

Or add an alias:
```bash
echo "alias ttracker='node ~/repos/ttracker/server.js'" >> ~/.zshrc
source ~/.zshrc
ttracker
```

## Features

- **Active Sessions** table with live status (running/missing/idle)
- **Parked Sessions** for terminals you closed on purpose
- **Focus** button brings a terminal window to front
- **Park** closes a terminal and saves it for later
- **Restore** reopens a parked or missing session with `claude --resume`
- **Editable badges and notes** per session
- **Search** across all Claude sessions (surface + deep message search)
- **New Claude Session** button with optional badge
- **Minimize All** terminals
- **Command history** saved on park for non-Claude terminals
- Solarized light theme
- Localhost only (127.0.0.1)
- Zero dependencies (Node.js built-in modules only)

## How it works

The server snapshots all iTerm2 terminals every 10 minutes via AppleScript. It tracks Claude session IDs so it can restore them with `claude --resume` after a crash or restart.

All state is stored in `snapshots/state.json` (gitignored).

## CLI Tools

```bash
./status.sh       # One-shot terminal status report
./daemon.sh --bg  # Background snapshot daemon (if not using web server)
./restore.sh      # Restore missing sessions from CLI
./done.sh         # Park current session from CLI (after /exit)
./history.sh      # Browse parked sessions from CLI
```

## Requirements

- macOS with iTerm2
- Node.js
- Claude Code CLI
