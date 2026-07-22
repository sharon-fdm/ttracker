#!/usr/bin/env node
// ttracker/server.js
//
// Web dashboard for terminal session tracking.
// Replaces the daemon: takes periodic snapshots and serves a UI.
//
// Usage:
//   node server.js              # Start on port 3847
//   node server.js --open       # Start and open browser
//   TT_PORT=8080 node server.js # Custom port
//   TT_INTERVAL=5 node server.js # Snapshot every 5 minutes

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, exec } = require('node:child_process');
const os = require('node:os');

// ─── Constants ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.TT_PORT || '3847');
const INTERVAL_MIN = parseInt(process.env.TT_INTERVAL || '10');
const SAFE_MODE = process.env.TT_SAFE_MODE === '1';
const SCRIPT_DIR = __dirname;
const SNAPSHOT_DIR = path.join(SCRIPT_DIR, 'snapshots');
const STATE_FILE = path.join(SNAPSHOT_DIR, 'state.json');
const PID_FILE = path.join(SNAPSHOT_DIR, 'daemon.pid');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ─── Utilities ───────────────────────────────────────────────────────────────

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function runOsascriptFile(filepath) {
  return new Promise((resolve, reject) => {
    execFile('osascript', [filepath], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function processIsRunning(pid) {
  try {
    process.kill(parseInt(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function readJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function projectDirToPath(dirName) {
  // Convert "-Users-sharonkatz-repos-fleet" to "~/repos/fleet"
  return dirName.replace(/^-Users-[^-]+-/, '~/').replace(/-/g, '/');
}

function getProjectDirs() {
  try {
    return fs.readdirSync(CLAUDE_PROJECTS_DIR)
      .filter(d => {
        const full = path.join(CLAUDE_PROJECTS_DIR, d);
        return fs.statSync(full).isDirectory() && fs.readdirSync(full).some(f => f.endsWith('.jsonl'));
      })
      .map(d => ({ dir: d, label: projectDirToPath(d), count: fs.readdirSync(path.join(CLAUDE_PROJECTS_DIR, d)).filter(f => f.endsWith('.jsonl')).length }))
      .sort((a, b) => b.count - a.count);
  } catch { return []; }
}

function findProjectDir(claudeSessionId) {
  // Find which project dir contains a given session's JSONL
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const jsonl = path.join(CLAUDE_PROJECTS_DIR, d, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(jsonl)) return d;
    }
  } catch {}
  return null;
}

// ─── State Management ────────────────────────────────────────────────────────
// All persistent data lives in a single state.json file:
//   { snapshot: { timestamp, sessions[] }, history: [], notes: {} }

function loadState() {
  const state = readJSON(STATE_FILE);
  if (state && state.snapshot) return state;

  // Migrate from old separate files if they exist
  const migrated = {
    snapshot: readJSON(path.join(SNAPSHOT_DIR, 'latest.json')) || { timestamp: '', session_count: 0, sessions: [] },
    history: readJSON(path.join(SNAPSHOT_DIR, 'history.json')) || [],
    notes: readJSON(path.join(SNAPSHOT_DIR, 'notes.json')) || {}
  };
  saveState(migrated);
  return migrated;
}

function saveState(state) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeJSON(STATE_FILE, state);
}

// ─── Snapshot Logic ──────────────────────────────────────────────────────────

const ITERM_APPLESCRIPT = `
tell application "iTerm2"
    set output to ""
    repeat with w from 1 to (count of windows)
        set win to window w
        repeat with t from 1 to (count of tabs of win)
            set theTab to tab t of win
            repeat with s from 1 to (count of sessions of theTab)
                set sess to session s of theTab
                set b to ""
                try
                    tell sess
                        set b to (variable named "badge")
                    end tell
                end try
                set output to output & (id of win) & "\t" & t & "\t" & s & "\t" & (unique ID of sess) & "\t" & (tty of sess) & "\t" & b & "\t" & (name of sess) & linefeed
            end repeat
        end repeat
    end repeat
    return output
end tell`;

let snapshotInProgress = false;

async function takeSnapshot() {
  if (snapshotInProgress) return null;
  snapshotInProgress = true;

  try {
    const raw = await runOsascript(ITERM_APPLESCRIPT).catch(() => '');
    if (!raw) {
      console.log(`[${now()}] Warning: could not reach iTerm2`);
      snapshotInProgress = false;
      return null;
    }

    const lines = raw.split('\n').filter(l => l.trim());
    const sessions = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 7) continue;

      const [winId, tab, sess, itermUuid, tty, badge, ...nameParts] = parts;
      const sessName = nameParts.join('\t');
      const shortTty = path.basename(tty);

      // Find Claude process on this TTY
      let claudeSessionId = '';
      let cwd = '';
      const psOut = await runCommand('ps', ['-t', shortTty, '-o', 'pid,command']);
      const claudeMatch = psOut.split('\n').find(l => l.includes('claude') && !l.includes('awk'));
      if (claudeMatch) {
        const claudePid = claudeMatch.trim().split(/\s+/)[0];
        const sessFile = path.join(CLAUDE_SESSIONS_DIR, `${claudePid}.json`);
        const sessData = readJSON(sessFile);
        if (sessData) {
          claudeSessionId = sessData.sessionId || '';
          cwd = sessData.cwd || '';
        }
      }

      // Get cwd from the shell process if not already set (non-Claude terminals)
      if (!cwd) {
        const shellMatch = psOut.split('\n').find(l => l.includes('-zsh') || l.includes('bash'));
        if (shellMatch) {
          const shellPid = shellMatch.trim().split(/\s+/)[0];
          cwd = await runCommand('lsof', ['-a', '-p', shellPid, '-d', 'cwd', '-Fn']).then(out => {
            const line = out.split('\n').find(l => l.startsWith('n'));
            return line ? line.slice(1) : '';
          });
        }
      }

      // Find foreground process
      const statOut = await runCommand('ps', ['-t', shortTty, '-o', 'stat,command']);
      let procName = 'unknown';
      const fgLine = statOut.split('\n').find(l => l.match(/^\s*\S*\+/));
      if (fgLine) {
        const cmd = fgLine.trim().split(/\s+/).slice(1)[0] || '';
        procName = path.basename(cmd);
      }

      // Get last activity time from JSONL file modification time
      let lastActive = '';
      if (claudeSessionId) {
        const projDir = findProjectDir(claudeSessionId);
        const jsonlFile = projDir ? path.join(CLAUDE_PROJECTS_DIR, projDir, `${claudeSessionId}.jsonl`) : '';
        try {
          const stat = fs.statSync(jsonlFile);
          lastActive = stat.mtime.toISOString().replace('T', ' ').slice(0, 16);
        } catch {}
      }

      sessions.push({
        window_id: parseInt(winId) || 0,
        tab: parseInt(tab) || 1,
        session: parseInt(sess) || 1,
        iterm_uuid: itermUuid,
        tty,
        badge: badge || '',
        session_name: sessName || '',
        process: procName,
        claude_session_id: claudeSessionId,
        cwd,
        last_active: lastActive
      });
    }

    // For non-Claude shell sessions, save recent commands from ~/.zsh_history
    // so we have them if the terminal is killed accidentally. This is shared
    // history (not per-terminal) but it's completely silent.
    const state = loadState();
    const hasNonClaude = sessions.some(s => !s.claude_session_id && (s.process === '-zsh' || s.process === 'bash' || s.process === 'zsh'));
    if (hasNonClaude) {
      try {
        const histFile = path.join(os.homedir(), '.zsh_history');
        const histRaw = fs.readFileSync(histFile, 'utf8');
        const lines = histRaw.split('\n').filter(l => l.trim());
        const cmds = lines.slice(-30).map(l => {
          // zsh history format: ": timestamp:0;command" or just "command"
          const match = l.match(/^:\s*\d+:\d+;(.+)/);
          return match ? match[1] : l;
        }).filter(l => l && !l.startsWith('fc '));
        for (const sess of sessions) {
          if (!sess.claude_session_id && (sess.process === '-zsh' || sess.process === 'bash' || sess.process === 'zsh')) {
            state.notes[`hist:${sess.iterm_uuid}`] = cmds;
          }
        }
      } catch {}
    }

    const snapshot = {
      timestamp: now(),
      session_count: sessions.length,
      sessions
    };

    // Update state, preserving missing sessions from previous snapshot
    const liveUuids = new Set(sessions.map(s => s.iterm_uuid));
    const liveSessionIds = new Set(sessions.filter(s => s.claude_session_id).map(s => s.claude_session_id));
    const parkedIds = new Set(state.history.map(h => h.claude_session_id || h.iterm_uuid));
    if (state.snapshot && state.snapshot.sessions) {
      for (const prev of state.snapshot.sessions) {
        if (liveUuids.has(prev.iterm_uuid)) continue;
        if (prev.claude_session_id && liveSessionIds.has(prev.claude_session_id)) continue;
        const key = prev.claude_session_id || prev.iterm_uuid;
        if (parkedIds.has(key)) continue;
        // Keep Claude sessions as missing
        if (prev.claude_session_id) {
          sessions.push(prev);
        }
        // Keep non-Claude sessions that have saved history (killed accidentally)
        else if (state.notes[`hist:${prev.iterm_uuid}`]) {
          prev.cmd_history = state.notes[`hist:${prev.iterm_uuid}`];
          prev.process = 'killed';
          sessions.push(prev);
        }
      }
      snapshot.sessions = sessions;
      snapshot.session_count = sessions.length;
    }
    state.snapshot = snapshot;
    saveState(state);

    // Timestamped backup
    const backupName = `snapshot-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}.json`;
    writeJSON(path.join(SNAPSHOT_DIR, backupName), snapshot);

    // Prune old backups (keep last 50)
    const backups = fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const old of backups.slice(50)) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, old));
    }

    const claudeCount = sessions.filter(s => s.claude_session_id).length;
    console.log(`[${now()}] Snapshot: ${sessions.length} sessions (${claudeCount} Claude)`);

    return snapshot;
  } finally {
    snapshotInProgress = false;
  }
}

// ─── Liveness Check ──────────────────────────────────────────────────────────

function getRunningSessionIds() {
  const running = new Set();
  try {
    const files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const pid = f.replace('.json', '');
      if (processIsRunning(pid)) {
        const data = readJSON(path.join(CLAUDE_SESSIONS_DIR, f));
        if (data && data.sessionId) {
          running.add(data.sessionId);
        }
      }
    }
  } catch { /* no sessions dir */ }
  return running;
}

// ─── Focus / Park / Restore ─────────────────────────────────────────────────

async function focusSession(itermUuid) {
  try {
    await runOsascript(`
tell application "iTerm2"
    activate
    repeat with w from 1 to (count of windows)
        set win to window w
        repeat with t from 1 to (count of tabs of win)
            repeat with s from 1 to (count of sessions of tab t of win)
                set sess to session s of tab t of win
                if (unique ID of sess) is "${itermUuid}" then
                    select win
                    return "focused"
                end if
            end repeat
        end repeat
    end repeat
    return "not found"
end tell`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function parkSession(itermUuid) {
  const state = loadState();
  const session = state.snapshot.sessions.find(s => s.iterm_uuid === itermUuid);
  if (!session) return { ok: false, error: 'Session not found' };

  // Capture recent commands from ~/.zsh_history (shared, but silent)
  let cmdHistory = [];
  try {
    const histFile = path.join(os.homedir(), '.zsh_history');
    const histRaw = fs.readFileSync(histFile, 'utf8');
    const lines = histRaw.split('\n').filter(l => l.trim());
    cmdHistory = lines.slice(-30).map(l => {
      const match = l.match(/^:\s*\d+:\d+;(.+)/);
      return match ? match[1] : l;
    }).filter(l => l && !l.startsWith('fc '));
  } catch {}

  // Add or update in history
  const key = session.claude_session_id || session.iterm_uuid;
  const existingIdx = state.history.findIndex(h => (h.claude_session_id || h.iterm_uuid) === key);
  const entry = {
    ...session,
    parked_at: new Date().toISOString().replace('T', ' ').slice(0, 16),
    cmd_history: cmdHistory.length ? cmdHistory : undefined
  };
  if (existingIdx >= 0) {
    state.history[existingIdx] = entry;
  } else {
    state.history.push(entry);
  }
  saveState(state);

  // Close the iTerm2 session
  try {
    await runOsascript(`
tell application "iTerm2"
    repeat with w from 1 to (count of windows)
        set win to window w
        repeat with t from 1 to (count of tabs of win)
            repeat with s from 1 to (count of sessions of tab t of win)
                set sess to session s of tab t of win
                if (unique ID of sess) is "${itermUuid}" then
                    close sess
                    return "closed"
                end if
            end repeat
        end repeat
    end repeat
    return "not found"
end tell`);
  } catch { /* window may already be closed */ }

  // Wait for iTerm2 to finish processing the close, then snapshot
  await new Promise(r => setTimeout(r, 2000));
  await takeSnapshot();
  return { ok: true, badge: session.badge };
}

async function createNewSession(badge) {
  const cwd = path.join(os.homedir(), 'repos', 'fleet');
  const badgeB64 = badge ? Buffer.from(badge).toString('base64') : '';
  const claudeCmd = 'claude --dangerously-skip-permissions';

  const tmpFile = path.join(os.tmpdir(), `tt-new-${Date.now()}.applescript`);
  const badgeLine = badgeB64
    ? `write text "printf '\\\\e]1337;SetBadgeFormat=%s\\\\a' '${badgeB64}'"\n        delay 2`
    : '';
  fs.writeFileSync(tmpFile, `tell application "iTerm2"
    set newWindow to (create window with default profile)
    tell current session of current tab of newWindow
        write text "cd ${cwd}"
        delay 1
        ${badgeLine}
        write text "${claudeCmd}"
    end tell
end tell`);

  try {
    await runOsascriptFile(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // Wait for the window and badge to be set, then snapshot
  await new Promise(r => setTimeout(r, 4000));
  await takeSnapshot();
  return { ok: true };
}

async function restoreSession(sessionId, fromHistory) {
  const state = loadState();
  let session;
  let historyIdx = -1;

  if (fromHistory) {
    const idx = state.history.findIndex(h =>
      h.claude_session_id === sessionId || h.iterm_uuid === sessionId);
    if (idx === -1) return { ok: false, error: 'Not found in history' };
    session = { ...state.history[idx] };
    historyIdx = idx;
  } else {
    session = state.snapshot.sessions.find(s => s.claude_session_id === sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
  }

  const cwd = (session.cwd || os.homedir()).replace(/'/g, "'\\''");
  const badgeB64 = Buffer.from(session.badge || '').toString('base64');
  const badgeLine = badgeB64
    ? `write text "printf '\\\\e]1337;SetBadgeFormat=%s\\\\a' '${badgeB64}'"\n        delay 2`
    : '';

  // Build the command to run after cd + badge
  let launchCmd;
  if (session.claude_session_id) {
    launchCmd = SAFE_MODE
      ? `claude --resume ${session.claude_session_id}`
      : `claude --dangerously-skip-permissions --resume ${session.claude_session_id}`;
  } else {
    launchCmd = '';
  }

  // Write a shell script that does cd, badge, launch, and optionally prints history
  // This avoids all AppleScript escaping issues
  const restoreScript = path.join(os.tmpdir(), `tt-restore-${Date.now()}.sh`);
  const lines = ['#!/bin/bash', `cd '${cwd}'`];
  if (badgeB64) {
    lines.push(`printf '\\e]1337;SetBadgeFormat=%s\\a' '${badgeB64}'`);
    lines.push('sleep 1');
  }
  if (!launchCmd && session.cmd_history && session.cmd_history.length) {
    const histFile = path.join(os.tmpdir(), `tt-hist-display-${Date.now()}.txt`);
    fs.writeFileSync(histFile, session.cmd_history.join('\n'));
    lines.push('echo ""');
    lines.push(`printf '\\033[1;36m--- Last commands before parking ---\\033[0m\\n'`);
    lines.push(`cat ${histFile}`);
    lines.push(`printf '\\033[1;36m------\\033[0m\\n'`);
    lines.push('echo ""');
    lines.push(`rm -f ${histFile}`);
  }
  if (launchCmd) {
    lines.push(launchCmd);
  }
  fs.writeFileSync(restoreScript, lines.join('\n') + '\n');
  fs.chmodSync(restoreScript, '755');

  const tmpFile = path.join(os.tmpdir(), `tt-restore-${Date.now()}.applescript`);
  fs.writeFileSync(tmpFile, `tell application "iTerm2"
    set newWindow to (create window with default profile)
    tell current session of current tab of newWindow
        write text "source ${restoreScript} && rm -f ${restoreScript}"
    end tell
end tell`);

  try {
    await runOsascriptFile(tmpFile);
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // Remove from history only after successful restore
  if (fromHistory && historyIdx >= 0) {
    const freshState = loadState();
    freshState.history.splice(historyIdx, 1);
    saveState(freshState);
  }

  // Take fresh snapshot after a delay (let the window open)
  await new Promise(r => setTimeout(r, 4000));
  await takeSnapshot();
  return { ok: true, badge: session.badge };
}

// ─── API Handler ─────────────────────────────────────────────────────────────

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  // GET /api/sessions
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const state = loadState();
    const running = getRunningSessionIds();
    const parkedIds = new Set(state.history.filter(h => h.claude_session_id).map(h => h.claude_session_id));

    const sessions = state.snapshot.sessions
      .filter(s => {
        const key = s.claude_session_id || s.iterm_uuid;
        return !parkedIds.has(key);
      })
      .map(s => ({
        ...s,
        note: state.notes[s.claude_session_id] || state.notes[s.iterm_uuid] || '',
        status: s.process === 'killed' ? 'killed'
          : !s.claude_session_id ? 'no-claude'
          : running.has(s.claude_session_id) ? 'running'
          : 'missing'
      }));

    // Sort by last_active descending (most recent first)
    sessions.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state.snapshot, sessions }));
    return;
  }

  // GET /api/history
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const state = loadState();
    const running = getRunningSessionIds();

    const entries = state.history.map(h => ({
      ...h,
      note: (h.claude_session_id && state.notes[h.claude_session_id]) || '',
      status: running.has(h.claude_session_id) ? 'running' : 'parked'
    }));

    // Sort by parked_at descending (most recent first)
    entries.sort((a, b) => (b.parked_at || '').localeCompare(a.parked_at || ''));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // GET /api/search?q=...&deep=1
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').toLowerCase();
    const deep = url.searchParams.get('deep') === '1';
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing q parameter' }));
      return;
    }

    const state = loadState();
    const results = [];
    const projectDir = CLAUDE_PROJECTS_DIR;

    // Build list of all sessions to search
    const allSessions = [];
    const running = getRunningSessionIds();
    for (const s of state.snapshot.sessions) {
      if (s.claude_session_id) {
        allSessions.push({ ...s, location: 'Active Sessions', status: running.has(s.claude_session_id) ? 'running' : 'missing' });
      }
    }
    for (let i = 0; i < state.history.length; i++) {
      const h = state.history[i];
      if (h.claude_session_id) {
        allSessions.push({ ...h, location: 'Parked Sessions' });
      }
    }

    // Phase 1: Surface search (badge, session_name, notes)
    for (const s of allSessions) {
      const badge = (s.badge || '').toLowerCase();
      const name = (s.session_name || '').toLowerCase();
      const note = (state.notes[s.claude_session_id] || '').toLowerCase();
      if (badge.includes(query) || name.includes(query) || note.includes(query)) {
        const matchField = badge.includes(query) ? 'badge' : name.includes(query) ? 'session name' : 'note';
        results.push({ ...s, match: `Found in ${matchField}`, phase: 'surface' });
      }
    }

    if (!deep) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, phase: 'surface', done: false }));
      return;
    }

    // Phase 2: Deep search (first 5 user messages in JSONL)
    for (const s of allSessions) {
      // Skip if already found in surface
      if (results.some(r => r.claude_session_id === s.claude_session_id)) continue;

      const projDir = findProjectDir(s.claude_session_id);
      const jsonlFile = projDir ? path.join(CLAUDE_PROJECTS_DIR, projDir, `${s.claude_session_id}.jsonl`) : '';
      try {
        if (!fs.existsSync(jsonlFile)) continue;
        const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n');
        let msgCount = 0;
        let found = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user') {
              const content = obj.message?.content || '';
              let text = '';
              if (typeof content === 'string') text = content;
              else if (Array.isArray(content)) {
                text = content.filter(c => c.type === 'text').map(c => c.text).join(' ');
              }
              if (text.toLowerCase().includes(query)) {
                const snippet = text.substring(Math.max(0, text.toLowerCase().indexOf(query) - 30), text.toLowerCase().indexOf(query) + query.length + 30).replace(/\n/g, ' ');
                results.push({ ...s, match: `"...${snippet}..."`, phase: 'deep' });
                found = true;
                break;
              }
              msgCount++;
              if (msgCount >= 20) break;
            }
          } catch {}
        }
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results, phase: 'deep', done: true, searched: allSessions.length }));
    return;
  }

  // GET /api/projects
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getProjectDirs()));
    return;
  }

  // POST /api/import-sessions
  if (req.method === 'POST' && url.pathname === '/api/import-sessions') {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => resolve(data));
    });
    const { projectDir } = JSON.parse(body);
    const fullDir = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    if (!fs.existsSync(fullDir)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Project not found' }));
      return;
    }

    const state = loadState();
    const existingIds = new Set([
      ...state.snapshot.sessions.filter(s => s.claude_session_id).map(s => s.claude_session_id),
      ...state.history.filter(h => h.claude_session_id).map(h => h.claude_session_id)
    ]);

    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
    let imported = 0;
    const friendlyPath = projectDirToPath(projectDir);

    for (const f of files) {
      const sid = f.replace('.jsonl', '');
      if (existingIds.has(sid)) continue;

      const jsonlPath = path.join(fullDir, f);
      const mtime = fs.statSync(jsonlPath).mtime;
      const parkedAt = mtime.toISOString().replace('T', ' ').slice(0, 16);

      // Extract first user message as topic
      let topic = '';
      try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user') {
              const msg = obj.message?.content || '';
              let text = '';
              if (typeof msg === 'string') text = msg;
              else if (Array.isArray(msg)) {
                text = msg.filter(c => c.type === 'text').map(c => c.text).join(' ');
              }
              text = text.replace(/<[^>]+>/g, '').trim();
              if (text.length > 5) {
                topic = text.substring(0, 80).replace(/\n/g, ' ');
                break;
              }
            }
          } catch {}
        }
      } catch {}

      // Generate badge from topic
      let badge = '';
      const ticketMatch = topic.match(/(?:solve|fix|review|reproduce|spec|#)\s*(\d{4,5})/i);
      if (ticketMatch) badge = ticketMatch[1];
      else if (topic.length > 0) {
        const words = topic.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
          .filter(w => w.length > 3 && !['this','that','what','with','from','have','just','want','need','please','here'].includes(w));
        badge = words[0] || '';
      }

      state.history.push({
        claude_session_id: sid,
        badge,
        session_name: topic || '(no topic)',
        cwd: friendlyPath.replace('~', os.homedir()),
        parked_at: parkedAt,
        window_id: 0, tab: 1, session: 1,
        iterm_uuid: '', tty: '', process: 'claude'
      });
      imported++;
    }

    saveState(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, imported, total: files.length, skipped: files.length - imported }));
    return;
  }

  // POST /api/new-session
  if (req.method === 'POST' && url.pathname === '/api/new-session') {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => resolve(data));
    });
    const { badge } = JSON.parse(body);
    const result = await createNewSession(badge || '');
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/snapshot
  if (req.method === 'POST' && url.pathname === '/api/snapshot') {
    await takeSnapshot();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/minimize-all
  if (req.method === 'POST' && url.pathname === '/api/minimize-all') {
    try {
      await runOsascript(`
tell application "iTerm2"
    set allWindows to every window
    repeat with win in allWindows
        set miniaturized of win to true
    end repeat
end tell`);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/focus/:iterm_uuid
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'focus' && pathParts[2]) {
    const result = await focusSession(decodeURIComponent(pathParts[2]));
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/park/:iterm_uuid
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'park' && pathParts[2]) {
    const result = await parkSession(decodeURIComponent(pathParts[2]));
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/park-missing/:claude_session_id (park a session that's already closed)
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'park-missing' && pathParts[2]) {
    const sid = decodeURIComponent(pathParts[2]);
    const state = loadState();
    const session = state.snapshot.sessions.find(s => s.claude_session_id === sid || s.iterm_uuid === sid);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      return;
    }
    const key = session.claude_session_id || session.iterm_uuid;
    if (!state.history.some(h => (h.claude_session_id || h.iterm_uuid) === key)) {
      state.history.push({
        ...session,
        parked_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
      });
    }
    // Remove from active snapshot
    state.snapshot.sessions = state.snapshot.sessions.filter(s =>
      s.claude_session_id !== sid && s.iterm_uuid !== sid);
    state.snapshot.session_count = state.snapshot.sessions.length;
    saveState(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/restore/:claude_session_id
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'restore' && pathParts[2]) {
    const result = await restoreSession(decodeURIComponent(pathParts[2]), false);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/restore-history/:claude_session_id
  if (req.method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'restore-history' && pathParts[2]) {
    const result = await restoreSession(decodeURIComponent(pathParts[2]), true);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // DELETE /api/delete-history/:claude_session_id
  if (req.method === 'DELETE' && pathParts[0] === 'api' && pathParts[1] === 'delete-history' && pathParts[2]) {
    const sid = decodeURIComponent(pathParts[2]);
    const state = loadState();
    const idx = state.history.findIndex(h => h.claude_session_id === sid || h.iterm_uuid === sid);
    if (idx === -1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }
    state.history.splice(idx, 1);
    // Also remove from snapshot if it was a carried-over missing session
    state.snapshot.sessions = state.snapshot.sessions.filter(s =>
      s.claude_session_id !== sid && s.iterm_uuid !== sid);
    state.snapshot.session_count = state.snapshot.sessions.length;
    // Clean up note
    delete state.notes[sid];
    saveState(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PUT /api/badge/:session_id
  if (req.method === 'PUT' && pathParts[0] === 'api' && pathParts[1] === 'badge' && pathParts[2]) {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => resolve(data));
    });
    const { badge, iterm_uuid } = JSON.parse(body);
    const sid = decodeURIComponent(pathParts[2]);
    const state = loadState();

    // Update in snapshot
    for (const s of state.snapshot.sessions) {
      if (s.claude_session_id === sid || s.iterm_uuid === sid) {
        s.badge = badge;
      }
    }
    // Update in history
    for (const h of state.history) {
      if (h.claude_session_id === sid) {
        h.badge = badge;
      }
    }
    saveState(state);

    // Update iTerm2 badge by writing escape sequence directly to the TTY device
    // This works even when a process (claude, node, etc.) is running in the terminal
    const ttySession = state.snapshot.sessions.find(s =>
      s.claude_session_id === sid || s.iterm_uuid === sid);
    if (ttySession && ttySession.tty) {
      const badgeB64 = Buffer.from(badge).toString('base64');
      try {
        fs.writeFileSync(ttySession.tty, `\x1b]1337;SetBadgeFormat=${badgeB64}\x07`);
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PUT /api/note/:session_id
  if (req.method === 'PUT' && pathParts[0] === 'api' && pathParts[1] === 'note' && pathParts[2]) {
    const body = await new Promise((resolve) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => resolve(data));
    });
    const { note } = JSON.parse(body);
    const sid = decodeURIComponent(pathParts[2]);
    const state = loadState();
    if (note) {
      state.notes[sid] = note;
    } else {
      delete state.notes[sid];
    }
    saveState(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─── HTML Dashboard ──────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='16' fill='%23fdf6e3'/><text x='44' y='70' font-family='monospace' font-size='56' font-weight='bold' text-anchor='middle' letter-spacing='-8'><tspan fill='%23268bd2'>t</tspan><tspan fill='%232aa198'>t</tspan></text></svg>">
<title>ttracker</title>
<style>
  /* Solarized palette */
  :root {
    --bg:       #fdf6e3;
    --bg-alt:   #eee8d5;
    --bg-border:#d3cdb8;
    --fg:       #586e75;
    --fg-dim:   #839496;
    --fg-muted: #93a1a1;
    --yellow:   #b58900;
    --orange:   #cb4b16;
    --red:      #dc322f;
    --magenta:  #d33682;
    --violet:   #6c71c4;
    --blue:     #268bd2;
    --cyan:     #2aa198;
    --green:    #859900;
  }
  body.dark {
    --bg:       #002b36;
    --bg-alt:   #073642;
    --bg-border:#586e75;
    --fg:       #839496;
    --fg-dim:   #657b83;
    --fg-muted: #586e75;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
    background: var(--bg);
    color: var(--fg);
    padding: 24px;
    font-size: 13px;
  }
  h1 {
    color: var(--blue);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }
  h1 span { color: var(--cyan); }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 2px solid var(--bg-alt);
  }
  .header-info { color: var(--fg-dim); font-size: 12px; }
  .header-info span { margin-left: 16px; }
  .refresh-btn {
    background: var(--cyan);
    color: var(--bg);
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
  }
  .refresh-btn:hover { opacity: 0.85; }
  .refresh-btn:disabled { background: var(--fg-muted); }
  h2 {
    color: var(--blue);
    font-size: 15px;
    font-weight: 600;
    margin: 28px 0 12px;
    padding-left: 8px;
    border-left: 3px solid var(--blue);
  }
  .history-heading { color: var(--violet); border-left-color: var(--violet); }
  .count { color: var(--fg-muted); font-weight: 400; margin-left: 8px; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
    border-radius: 6px;
    overflow: hidden;
  }
  th {
    text-align: left;
    padding: 10px 12px;
    background: var(--bg-alt);
    color: var(--fg);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 2px solid var(--bg-border);
  }
  td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--bg-alt);
    vertical-align: middle;
  }
  tr:hover { background: var(--bg-alt); }
  .badge-cell {
    color: var(--magenta);
    font-weight: 700;
  }
  .session-name { color: var(--fg); }
  .process-cell { color: var(--cyan); font-weight: 500; }
  .folder-cell { color: var(--yellow); font-size: 12px; }
  .session-id {
    color: var(--fg-muted);
    font-size: 11px;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }
  .dot-running { background: var(--green); }
  .dot-missing { background: var(--red); }
  .dot-parked { background: var(--violet); }
  .dot-killed { background: var(--orange); }
  .dot-no-claude { background: var(--fg-muted); }
  .status-running { color: var(--green); }
  .status-missing { color: var(--red); }
  .status-parked { color: var(--violet); }
  .status-killed { color: var(--orange); }
  .status-no-claude { color: var(--fg-muted); }
  .btn {
    border: none;
    border-radius: 5px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    transition: all 0.15s;
    color: var(--bg);
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-focus { background: var(--green); }
  .btn-focus:hover:not(:disabled) { opacity: 0.85; }
  .btn-park { background: var(--orange); }
  .btn-park:hover:not(:disabled) { opacity: 0.85; }
  .btn-restore { background: var(--blue); }
  .btn-restore:hover:not(:disabled) { opacity: 0.85; }
  .empty-state {
    color: var(--fg-muted);
    padding: 24px;
    text-align: center;
    font-style: italic;
  }
  .parked-at { color: var(--violet); font-size: 12px; font-weight: 500; }
  .actions { white-space: nowrap; }
  .note-input {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--fg);
    font-family: inherit;
    font-size: 12px;
    padding: 3px 6px;
    width: 100%;
    min-width: 120px;
  }
  .badge-input {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--magenta);
    font-family: inherit;
    font-size: 13px;
    font-weight: 700;
    padding: 3px 6px;
    width: 100%;
    min-width: 80px;
  }
  .badge-input:hover { border-color: var(--magenta); }
  .badge-input:focus {
    outline: none;
    border-color: var(--magenta);
    background: var(--bg-alt);
  }
  .note-input:hover { border-color: var(--cyan); }
  .note-input:focus {
    outline: none;
    border-color: var(--blue);
    background: var(--bg-alt);
  }
  .new-session {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .new-session input, .new-session select {
    background: var(--bg-alt);
    border: 1px solid var(--fg-muted);
    border-radius: 5px;
    color: var(--fg);
    font-family: inherit;
    font-size: 12px;
    padding: 5px 10px;
    width: 180px;
  }
  .new-session input:focus, .new-session select:focus {
    outline: none;
    border-color: var(--blue);
  }
  .btn-new {
    background: var(--blue);
    color: var(--bg);
    border: none;
    border-radius: 5px;
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
  }
  .btn-new:hover { opacity: 0.85; }
  .btn-new:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-delete { background: var(--red); }
  .btn-delete:hover { opacity: 0.85; }
  .theme-toggle {
    background: var(--bg-alt);
    border: 1px solid var(--fg-muted);
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
    color: var(--fg);
    line-height: 1;
  }
  .theme-toggle:hover { border-color: var(--blue); }
  .modal-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4);
    z-index: 100;
    justify-content: center;
    align-items: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: var(--bg);
    border: 2px solid var(--red);
    border-radius: 8px;
    padding: 24px;
    max-width: 420px;
    width: 90%;
  }
  .modal h3 {
    color: var(--red);
    font-size: 15px;
    margin-bottom: 12px;
  }
  .modal p {
    color: var(--fg);
    font-size: 13px;
    margin-bottom: 8px;
  }
  .modal .badge-name {
    color: var(--magenta);
    font-weight: 700;
  }
  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 20px;
  }
  .btn-cancel { background: var(--fg-muted); }
  .btn-cancel:hover { opacity: 0.85; }
  .btn-confirm-delete { background: var(--red); }
  .btn-confirm-delete:hover { opacity: 0.85; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>t<span>tracker</span></h1>
  </div>
  <div class="header-info">
    <span id="snapshot-time"></span>
    <span id="session-counts"></span>
    <button class="refresh-btn" onclick="forceSnapshot()">Snapshot Now</button>
    <button class="refresh-btn" onclick="minimizeAll()">Minimize All</button>
    <button class="theme-toggle" onclick="toggleTheme()" id="theme-btn" title="Toggle light/dark">&#9789; Light</button>
  </div>
</div>

<div class="new-session">
  <input id="new-badge" type="text" placeholder="badge (optional)" onkeydown="if(event.key==='Enter')document.getElementById('new-btn').click()" />
  <button id="new-btn" class="btn-new" onclick="newSession()">+ New Claude Session</button>
</div>

<div class="new-session">
  <input id="search-input" type="text" placeholder="Search all Claude sessions..." style="width:350px" onkeydown="if(event.key==='Enter')searchSessions()" />
  <button id="search-btn" class="btn-new" style="background:#6c71c4" onclick="searchSessions()">Search</button>
  <button id="search-cancel" class="btn-new" style="background:#dc322f;display:none" onclick="cancelSearch()">Cancel</button>
  <button id="search-clear" class="btn-new" style="background:#93a1a1;display:none" onclick="clearSearch()">Clear</button>
  <span id="search-status" style="color:#93a1a1;font-size:12px;margin-left:8px"></span>
</div>
<div id="search-results" style="display:none;margin-bottom:24px">
  <h2 style="color:#6c71c4;border-left-color:#6c71c4">Search Results <span class="count" id="result-count"></span></h2>
  <table>
    <thead>
      <tr>
        <th>Location</th>
        <th>Badge</th>
        <th>Session Name</th>
        <th>Match</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="search-body"></tbody>
  </table>
</div>

<div class="new-session">
  <select id="import-project" style="background:#eee8d5;border:1px solid #93a1a1;border-radius:5px;color:#586e75;font-family:inherit;font-size:12px;padding:5px 10px;min-width:250px">
    <option value="">Loading projects...</option>
  </select>
  <button id="import-btn" class="btn-new" style="background:#b58900" onclick="importSessions()">Import Sessions</button>
  <span id="import-status" style="color:#93a1a1;font-size:12px;margin-left:8px"></span>
</div>

<h2>Active Sessions <span class="count" id="active-count"></span></h2>
<table>
  <thead>
    <tr>
      <th style="width:50px">#</th>
      <th>Badge</th>
      <th>Session Name</th>
      <th>Folder</th>
      <th>Note</th>
      <th>Process</th>
      <th>Claude Session</th>
      <th>Status</th>
      <th style="width:200px">Action</th>
    </tr>
  </thead>
  <tbody id="active-body"></tbody>
</table>

<h2 class="history-heading">Parked Sessions <span class="count" id="history-count"></span></h2>
<table>
  <thead>
    <tr>
      <th style="width:50px">#</th>
      <th>Badge</th>
      <th>Session Name</th>
      <th>Folder</th>
      <th>Note</th>
      <th>Claude Session</th>
      <th>Parked At</th>
      <th>Status</th>
      <th style="width:100px">Action</th>
    </tr>
  </thead>
  <tbody id="history-body"></tbody>
</table>

<div id="delete-modal" class="modal-overlay">
  <div class="modal">
    <h3>Delete Session Forever</h3>
    <p>This will permanently remove <span class="badge-name" id="modal-badge"></span> from the parked list.</p>
    <p>The Claude conversation history will remain in <code>~/.claude/</code> but ttracker will no longer track it.</p>
    <div class="modal-actions">
      <button class="btn btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn btn-confirm-delete" id="modal-confirm">Delete Forever</button>
    </div>
  </div>
</div>

<script>
const API = '';
let refreshTimer;

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function statusDot(status) {
  const labels = { running: 'running', missing: 'missing', killed: 'killed', parked: 'parked', 'no-claude': 'idle' };
  return '<span class="status status-' + status + '"><span class="dot dot-' + status + '"></span>' + (labels[status] || status) + '</span>';
}

async function fetchSessions() {
  try {
    const res = await fetch(API + '/api/sessions');
    return await res.json();
  } catch { return { timestamp: '?', sessions: [], session_count: 0 }; }
}

async function fetchHistory() {
  try {
    const res = await fetch(API + '/api/history');
    return await res.json();
  } catch { return []; }
}

function renderActive(data) {
  const el = document.getElementById('active-body');
  const sessions = data.sessions;
  document.getElementById('active-count').textContent = '(' + sessions.length + ')';
  document.getElementById('snapshot-time').textContent = 'Snapshot: ' + (data.timestamp || '?');

  const running = sessions.filter(s => s.status === 'running').length;
  const missing = sessions.filter(s => s.status === 'missing').length;
  document.getElementById('session-counts').textContent = running + ' running, ' + missing + ' missing';

  if (sessions.length === 0) {
    el.innerHTML = '<tr><td colspan="9" class="empty-state">No sessions found</td></tr>';
    return;
  }

  el.innerHTML = sessions.map((s, i) => {
    let action = '';
    if (s.status === 'running' || s.status === 'no-claude') {
      action = '<button class="btn btn-focus" onclick="focusSession(\\'' + s.iterm_uuid + '\\')">Focus</button>'
        + ' <button class="btn btn-park" onclick="parkSession(\\'' + s.iterm_uuid + '\\')">Park</button>';
    } else if (s.status === 'missing') {
      action = '<button class="btn btn-restore" onclick="restoreSession(\\'' + s.claude_session_id + '\\')">Restore</button>'
        + ' <button class="btn btn-park" onclick="parkMissing(\\'' + s.claude_session_id + '\\')">Park</button>';
    } else if (s.status === 'killed') {
      action = '<button class="btn btn-restore" onclick="restoreFromHistory(\\'' + s.iterm_uuid + '\\')">Restore</button>'
        + ' <button class="btn btn-park" onclick="parkMissing(\\'' + s.iterm_uuid + '\\')">Park</button>';
    }
    const noteKey = s.claude_session_id || s.iterm_uuid;
    const noteVal = escapeHtml(s.note);
    const folder = s.cwd ? s.cwd.replace(/^\\/Users\\/[^\\/]+\\//, '~/') : '';
    return '<tr>'
      + '<td>' + (i + 1) + '</td>'
      + '<td><input class="badge-input" value="' + escapeHtml(s.badge) + '" placeholder="badge" '
      + 'onblur="saveBadge(\\'' + (s.claude_session_id || s.iterm_uuid) + '\\', this.value, \\'' + s.iterm_uuid + '\\')" '
      + 'onkeydown="if(event.key===\\'Enter\\')this.blur()" /></td>'
      + '<td>' + escapeHtml(s.session_name) + '</td>'
      + '<td class="folder-cell">' + escapeHtml(folder) + '</td>'
      + '<td><input class="note-input" value="' + noteVal + '" placeholder="..." '
      + 'onblur="saveNote(\\'' + noteKey + '\\', this.value)" '
      + 'onkeydown="if(event.key===\\'Enter\\')this.blur()" /></td>'
      + '<td class="process-cell">' + escapeHtml(s.process) + '</td>'
      + '<td class="session-id">' + escapeHtml(s.claude_session_id) + '</td>'
      + '<td>' + statusDot(s.status) + '</td>'
      + '<td class="actions">' + action + '</td>'
      + '</tr>';
  }).join('');
}

function renderHistory(entries) {
  const el = document.getElementById('history-body');
  document.getElementById('history-count').textContent = '(' + entries.length + ')';

  if (entries.length === 0) {
    el.innerHTML = '<tr><td colspan="9" class="empty-state">No parked sessions</td></tr>';
    return;
  }

  el.innerHTML = entries.map((h, i) => {
    const hKey = h.claude_session_id || h.iterm_uuid;
    let action = '';
    if (h.status === 'running') {
      action = '<span style="color:#859900;font-size:12px">open</span>';
    } else {
      action = '<button class="btn btn-restore" onclick="restoreFromHistory(\\'' + hKey + '\\')">Restore</button>'
        + ' <button class="btn btn-delete" onclick="confirmDelete(\\'' + hKey + '\\', \\'' + escapeHtml(h.badge) + '\\')">Delete</button>';
    }
    const noteVal = escapeHtml(h.note);
    const folder = h.cwd ? h.cwd.replace(/^\\/Users\\/[^\\/]+\\//, '~/') : '';
    return '<tr>'
      + '<td>' + (i + 1) + '</td>'
      + '<td><input class="badge-input" value="' + escapeHtml(h.badge) + '" placeholder="badge" '
      + 'onblur="saveBadge(\\'' + hKey + '\\', this.value, \\'\\')" '
      + 'onkeydown="if(event.key===\\'Enter\\')this.blur()" /></td>'
      + '<td>' + escapeHtml(h.session_name) + '</td>'
      + '<td class="folder-cell">' + escapeHtml(folder) + '</td>'
      + '<td><input class="note-input" value="' + noteVal + '" placeholder="..." '
      + 'onblur="saveNote(\\'' + hKey + '\\', this.value)" '
      + 'onkeydown="if(event.key===\\'Enter\\')this.blur()" /></td>'
      + '<td class="session-id">' + escapeHtml(h.claude_session_id) + '</td>'
      + '<td class="parked-at">' + escapeHtml(h.parked_at) + '</td>'
      + '<td>' + statusDot(h.status) + '</td>'
      + '<td class="actions">' + action + '</td>'
      + '</tr>';
  }).join('');
}

async function refresh() {
  // Skip refresh if user is typing in a note field
  if (document.activeElement && (document.activeElement.classList.contains('note-input') || document.activeElement.classList.contains('badge-input'))) return;
  const [sessions, history] = await Promise.all([fetchSessions(), fetchHistory()]);
  renderActive(sessions);
  renderHistory(history);
}

function confirmDelete(sessionId, badge) {
  const modal = document.getElementById('delete-modal');
  document.getElementById('modal-badge').textContent = badge || sessionId.slice(0, 12) + '...';
  document.getElementById('modal-confirm').onclick = async function() {
    await fetch(API + '/api/delete-history/' + encodeURIComponent(sessionId), { method: 'DELETE' });
    closeModal();
    await refresh();
  };
  modal.classList.add('active');
}

function closeModal() {
  document.getElementById('delete-modal').classList.remove('active');
}

let searchAbort = null;

async function searchSessions() {
  const input = document.getElementById('search-input');
  const query = input.value.trim();
  if (!query) return;

  const btn = document.getElementById('search-btn');
  const cancel = document.getElementById('search-cancel');
  const status = document.getElementById('search-status');
  const resultsDiv = document.getElementById('search-results');
  const body = document.getElementById('search-body');
  const countEl = document.getElementById('result-count');

  btn.disabled = true;
  cancel.style.display = '';
  searchAbort = new AbortController();

  // Phase 1: Surface search
  status.textContent = 'Searching badges, names, notes...';
  try {
    const res = await fetch(API + '/api/search?q=' + encodeURIComponent(query), { signal: searchAbort.signal });
    const data = await res.json();
    renderSearchResults(data.results, body, countEl);
    resultsDiv.style.display = '';

    if (data.results.length > 0) {
      status.textContent = 'Found in surface search. Going deeper...';
    } else {
      status.textContent = 'Not in surface. Searching conversation messages...';
    }

    // Phase 2: Deep search
    const res2 = await fetch(API + '/api/search?q=' + encodeURIComponent(query) + '&deep=1', { signal: searchAbort.signal });
    const data2 = await res2.json();
    renderSearchResults(data2.results, body, countEl);
    status.textContent = data2.results.length + ' result(s) found across ' + data2.searched + ' sessions.';
  } catch (e) {
    if (e.name === 'AbortError') {
      status.textContent = 'Search cancelled.';
    } else {
      status.textContent = 'Search error.';
    }
  }

  btn.disabled = false;
  cancel.style.display = 'none';
  document.getElementById('search-clear').style.display = '';
  searchAbort = null;
}

function cancelSearch() {
  if (searchAbort) searchAbort.abort();
}

function clearSearch() {
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('search-status').textContent = '';
  document.getElementById('search-clear').style.display = 'none';
  document.getElementById('search-input').value = '';
}

function renderSearchResults(results, body, countEl) {
  countEl.textContent = '(' + results.length + ')';
  if (results.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">No matches found</td></tr>';
    return;
  }
  body.innerHTML = results.map(r => {
    const key = r.claude_session_id || r.iterm_uuid;
    const action = r.location === 'Parked Sessions'
      ? '<button class="btn btn-restore" onclick="restoreFromHistory(\\'' + key + '\\')">Restore</button>'
      : '<button class="btn btn-focus" onclick="focusSession(\\'' + r.iterm_uuid + '\\')">Focus</button>';
    return '<tr>'
      + '<td><span style="color:' + (r.location === 'Active Sessions' ? '#859900' : '#6c71c4') + ';font-weight:600">' + escapeHtml(r.location) + '</span></td>'
      + '<td class="badge-cell">' + escapeHtml(r.badge) + '</td>'
      + '<td>' + escapeHtml(r.session_name).substring(0, 50) + '</td>'
      + '<td style="font-size:12px;color:#586e75;max-width:300px;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(r.match) + '</td>'
      + '<td class="actions">' + action + '</td>'
      + '</tr>';
  }).join('');
}

async function newSession() {
  const btn = document.getElementById('new-btn');
  const input = document.getElementById('new-badge');
  const badge = input.value.trim();
  btn.disabled = true;
  btn.textContent = 'Opening...';
  await fetch(API + '/api/new-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge })
  });
  input.value = '';
  btn.textContent = '+ New Claude Session';
  btn.disabled = false;
  await refresh();
}

async function minimizeAll() {
  await fetch(API + '/api/minimize-all', { method: 'POST' });
}

async function forceSnapshot() {
  const btn = document.querySelector('.refresh-btn');
  btn.textContent = 'Snapshotting...';
  btn.disabled = true;
  await fetch(API + '/api/snapshot', { method: 'POST' });
  await refresh();
  btn.textContent = 'Snapshot Now';
  btn.disabled = false;
}

async function saveBadge(sessionId, badge, itermUuid) {
  await fetch(API + '/api/badge/' + encodeURIComponent(sessionId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge: badge.trim(), iterm_uuid: itermUuid })
  });
}

async function saveNote(sessionId, note) {
  await fetch(API + '/api/note/' + encodeURIComponent(sessionId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: note.trim() })
  });
}

async function focusSession(itermUuid) {
  await fetch(API + '/api/focus/' + encodeURIComponent(itermUuid), { method: 'POST' });
}

async function parkSession(itermUuid) {
  if (!confirm('Park this session and close the terminal?')) return;
  await fetch(API + '/api/park/' + encodeURIComponent(itermUuid), { method: 'POST' });
  await refresh();
}

async function parkMissing(sessionId) {
  await fetch(API + '/api/park-missing/' + encodeURIComponent(sessionId), { method: 'POST' });
  await refresh();
}

async function restoreSession(sessionId) {
  await fetch(API + '/api/restore/' + encodeURIComponent(sessionId), { method: 'POST' });
  setTimeout(refresh, 3000);
}

async function restoreFromHistory(sessionId) {
  await fetch(API + '/api/restore-history/' + encodeURIComponent(sessionId), { method: 'POST' });
  await refresh();
}

async function loadProjects() {
  try {
    const res = await fetch(API + '/api/projects');
    const projects = await res.json();
    const sel = document.getElementById('import-project');
    sel.innerHTML = projects.map(p =>
      '<option value="' + escapeHtml(p.dir) + '">' + escapeHtml(p.label) + ' (' + p.count + ' sessions)</option>'
    ).join('');
  } catch {}
}

async function importSessions() {
  const sel = document.getElementById('import-project');
  const btn = document.getElementById('import-btn');
  const status = document.getElementById('import-status');
  const projectDir = sel.value;
  if (!projectDir) return;

  btn.disabled = true;
  btn.textContent = 'Importing...';
  status.textContent = '';

  try {
    const res = await fetch(API + '/api/import-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir })
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = 'Imported ' + data.imported + ' new sessions (' + data.skipped + ' already tracked).';
      await refresh();
    } else {
      status.textContent = 'Error: ' + data.error;
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }

  btn.textContent = 'Import Sessions';
  btn.disabled = false;
}

function toggleTheme() {
  const body = document.body;
  const btn = document.getElementById('theme-btn');
  body.classList.toggle('dark');
  const isDark = body.classList.contains('dark');
  btn.innerHTML = isDark ? '&#9788; Dark' : '&#9789; Light';
  localStorage.setItem('tt-theme', isDark ? 'dark' : 'light');
}

// Restore saved theme
if (localStorage.getItem('tt-theme') === 'dark') {
  document.body.classList.add('dark');
  document.getElementById('theme-btn').innerHTML = '&#9788; Dark';
}

// Initial load + auto-refresh
refresh();
loadProjects();
refreshTimer = setInterval(refresh, 5000);
</script>

</body>
</html>`;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  try {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }

    if (req.url.startsWith('/api/')) {
      await handleAPI(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Request error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // Kill any existing ttracker server on our port (only node processes)
  try {
    const { stdout } = await new Promise((resolve) => {
      exec(`lsof -ti:${PORT}`, (err, stdout) => resolve({ stdout: (stdout || '').trim() }));
    });
    if (stdout) {
      for (const pid of stdout.split('\n').filter(Boolean)) {
        // Only kill node processes to avoid killing unrelated services
        const cmdOut = await runCommand('ps', ['-p', pid, '-o', 'command=']);
        if (cmdOut.includes('node') && cmdOut.includes('server.js')) {
          try { process.kill(parseInt(pid)); } catch {}
          console.log('Stopped previous server');
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch {}

  // Stop existing shell daemon if running
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (processIsRunning(pid)) {
        process.kill(parseInt(pid));
        console.log(`Stopped existing daemon (PID ${pid})`);
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch {}

  // Take initial snapshot
  console.log('Taking initial snapshot...');
  await takeSnapshot();

  // Start periodic snapshots
  setInterval(() => takeSnapshot(), INTERVAL_MIN * 60 * 1000);

  // Start HTTP server
  const server = http.createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nttracker dashboard: http://localhost:${PORT}`);
    console.log(`Snapshot interval: ${INTERVAL_MIN} minutes`);
    console.log(`Permission mode: ${SAFE_MODE ? 'safe' : 'dangerously-skip-permissions'}`);
    console.log('');
  });

  // Open browser if --open flag
  if (process.argv.includes('--open')) {
    exec(`open http://localhost:${PORT}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
