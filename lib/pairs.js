// pairs.js
// Paired terminal lifecycle: create, relay, park, restore, disband.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { captainPrompt, firstMatePrompt } = require('./pair-prompts');

let server; // set by init()

const commWatchers = {}; // pairId -> { watcher, lastLineCount }

function init(serverModule) {
  server = serverModule;
  // Start watching existing pairs on init
  setTimeout(() => startAllWatchers(), 2000);
}

function startAllWatchers() {
  const state = server.loadState();
  for (const pair of (state.pairs || [])) {
    startCommWatcher(pair);
  }
}

function startCommWatcher(pair) {
  if (commWatchers[pair.id]) return;
  if (!fs.existsSync(pair.comm_file)) return;

  let lastLineCount = 0;
  try {
    lastLineCount = fs.readFileSync(pair.comm_file, 'utf8').split('\n').filter(l => l.trim()).length;
  } catch {}

  const interval = setInterval(async () => {
    try {
      if (!fs.existsSync(pair.comm_file)) {
        clearInterval(interval);
        delete commWatchers[pair.id];
        return;
      }
      const content = fs.readFileSync(pair.comm_file, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length <= lastLineCount) return;

      // New lines detected
      const newLines = lines.slice(lastLineCount);
      lastLineCount = lines.length;

      for (const line of newLines) {
        if (line.includes('Captain:') && !line.includes('Standing by')) {
          // Captain wrote something - nudge First Mate
          await autoRelay(pair, 'first_mate', pair.comm_file);
        } else if (line.includes('First Mate:') && !line.includes('Aye aye') && !line.includes('Ready to continue')) {
          // First Mate responded - nudge Captain
          await autoRelay(pair, 'captain', pair.comm_file);
        }
      }
    } catch {}
  }, 3000); // Check every 3 seconds

  commWatchers[pair.id] = { interval, lastLineCount };
}

function stopCommWatcher(pairId) {
  if (commWatchers[pairId]) {
    clearInterval(commWatchers[pairId].interval);
    delete commWatchers[pairId];
  }
}

async function autoRelay(pair, targetRole, commFile) {
  const target = pair[targetRole];
  if (!target || !target.iterm_uuid) return;

  const msg = targetRole === 'first_mate'
    ? 'Check the comm file for new Captain messages and respond.'
    : 'Your First Mate responded. Check the comm file.';

  try {
    await server.runOsascript(`
tell application "iTerm2"
    repeat with w from 1 to (count of windows)
        repeat with t from 1 to (count of tabs of (window w))
            repeat with s from 1 to (count of sessions of tab t of (window w))
                set sess to session s of tab t of (window w)
                if (unique ID of sess) is "${target.iterm_uuid}" then
                    tell sess
                        write text "${msg.replace(/"/g, '\\"')}"
                    end tell
                    return "done"
                end if
            end repeat
        end repeat
    end repeat
end tell`);
    console.log(`[pair] Auto-relayed to ${targetRole} for ${pair.id}`);
  } catch {}
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function pairsDir() {
  const dir = path.join(server.SNAPSHOT_DIR, 'pairs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Open Terminal Helper ─────────────────────────────────────────────────────

async function openPairTerminal(cwdEscaped, badge, promptFile, safeMode, resumeSessionId) {
  const badgeB64 = Buffer.from(badge).toString('base64');

  // Write a shell script that launches Claude with the system prompt
  const launchScript = path.join(os.tmpdir(), `tt-pair-launch-${Date.now()}.sh`);
  const claudeArgs = safeMode ? '' : '--dangerously-skip-permissions ';
  const resumeArg = resumeSessionId ? `--resume ${resumeSessionId} ` : '';
  fs.writeFileSync(launchScript, [
    '#!/bin/bash',
    `cd '${cwdEscaped}'`,
    `PROMPT=$(cat '${promptFile}')`,
    `claude ${claudeArgs}${resumeArg}--name '${badge}' --append-system-prompt "$PROMPT"`
  ].join('\n') + '\n');
  fs.chmodSync(launchScript, '755');

  // Open iTerm2 window and run the script
  const appleScript = path.join(os.tmpdir(), `tt-pair-as-${Date.now()}.applescript`);
  fs.writeFileSync(appleScript, `tell application "iTerm2"
    set newWindow to (create window with default profile)
    tell current session of current tab of newWindow
        write text "source '${launchScript}' && rm -f '${launchScript}'"
    end tell
    return tty of current session of current tab of newWindow
end tell`);

  let tty = '';
  try {
    tty = await server.runOsascriptFile(appleScript);
  } finally {
    try { fs.unlinkSync(appleScript); } catch {}
  }

  // Set badge via TTY
  if (tty) {
    await new Promise(r => setTimeout(r, 1000));
    try { fs.writeFileSync(tty, `\x1b]1337;SetBadgeFormat=${badgeB64}\x07`); } catch {}
  }

  return tty;
}

// ─── Create Pair ─────────────────────────────────────────────────────────────

async function createPair(captainBadge, firstMateBadge, cwd) {
  const pairId = 'pair-' + Date.now();
  const commFile = path.join(pairsDir(), pairId + '.txt');
  cwd = cwd || path.join(os.homedir(), 'repos', 'fleet');

  // Write initial handshake
  const ts = now();
  fs.writeFileSync(commFile, [
    `[${ts}] Captain: Ahoy First Mate. I am your Captain. Standing by for orders.`,
    `[${ts}] First Mate: Aye aye, Captain. Ready and awaiting your command.`,
    ''
  ].join('\n'));

  // Write system prompt files
  const captainPromptFile = path.join(os.tmpdir(), `tt-pair-captain-${pairId}.txt`);
  const matePromptFile = path.join(os.tmpdir(), `tt-pair-mate-${pairId}.txt`);
  fs.writeFileSync(captainPromptFile, captainPrompt(commFile, firstMateBadge));
  fs.writeFileSync(matePromptFile, firstMatePrompt(commFile, captainBadge));

  const safeMode = server.SAFE_MODE;
  const cwdEscaped = cwd.replace(/'/g, "'\\''");

  // Open Captain terminal via shell script (avoids AppleScript escaping issues)
  const captainTty = await openPairTerminal(cwdEscaped, captainBadge, captainPromptFile, safeMode);

  // Wait before opening second terminal
  await new Promise(r => setTimeout(r, 3000));

  // Open First Mate terminal
  const mateTty = await openPairTerminal(cwdEscaped, firstMateBadge, matePromptFile, safeMode);

  // Wait for Claude to start, then snapshot
  await new Promise(r => setTimeout(r, 5000));
  await server.takeSnapshot();

  // Find the new sessions by badge
  const state = server.loadState();
  const captainSession = state.snapshot.sessions.find(s => s.badge === captainBadge);
  const mateSession = state.snapshot.sessions.find(s => s.badge === firstMateBadge);

  // Save pair record
  const pair = {
    id: pairId,
    created_at: now(),
    status: 'active',
    cwd,
    captain: {
      badge: captainBadge,
      iterm_uuid: captainSession ? captainSession.iterm_uuid : '',
      claude_session_id: captainSession ? captainSession.claude_session_id : '',
      tty: captainTty
    },
    first_mate: {
      badge: firstMateBadge,
      iterm_uuid: mateSession ? mateSession.iterm_uuid : '',
      claude_session_id: mateSession ? mateSession.claude_session_id : '',
      tty: mateTty
    },
    comm_file: commFile
  };

  if (!state.pairs) state.pairs = [];
  state.pairs.push(pair);
  server.saveState(state);

  // Start watching the comm file for auto-relay
  startCommWatcher(pair);

  // Clean up prompt files after Claude has read them
  setTimeout(() => {
    try { fs.unlinkSync(captainPromptFile); } catch {}
    try { fs.unlinkSync(matePromptFile); } catch {}
  }, 30000);

  return { ok: true, pair };
}

// ─── Relay Messages ──────────────────────────────────────────────────────────

async function relayToMate(pairId) {
  const state = server.loadState();
  const pair = (state.pairs || []).find(p => p.id === pairId);
  if (!pair) return { ok: false, error: 'Pair not found' };
  if (!pair.first_mate.iterm_uuid) return { ok: false, error: 'First Mate session not found' };

  const msg = `Check the comm file at ${pair.comm_file} for new messages from the Captain. Read the latest Captain message, fulfill the request, then append your response using: echo "[$(date '+%Y-%m-%d %H:%M:%S')] First Mate: <your response>" >> "${pair.comm_file}"`;

  try {
    await server.runOsascript(`
tell application "iTerm2"
    repeat with w from 1 to (count of windows)
        repeat with t from 1 to (count of tabs of (window w))
            repeat with s from 1 to (count of sessions of tab t of (window w))
                set sess to session s of tab t of (window w)
                if (unique ID of sess) is "${pair.first_mate.iterm_uuid}" then
                    tell sess
                        write text "${msg.replace(/"/g, '\\"')}"
                    end tell
                    return "done"
                end if
            end repeat
        end repeat
    end repeat
end tell`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function relayToCaptain(pairId) {
  const state = server.loadState();
  const pair = (state.pairs || []).find(p => p.id === pairId);
  if (!pair) return { ok: false, error: 'Pair not found' };
  if (!pair.captain.iterm_uuid) return { ok: false, error: 'Captain session not found' };

  const msg = `Your First Mate has responded. Read the comm file: cat "${pair.comm_file}" -- find the latest "First Mate:" line and report what they said.`;

  try {
    await server.runOsascript(`
tell application "iTerm2"
    repeat with w from 1 to (count of windows)
        repeat with t from 1 to (count of tabs of (window w))
            repeat with s from 1 to (count of sessions of tab t of (window w))
                set sess to session s of tab t of (window w)
                if (unique ID of sess) is "${pair.captain.iterm_uuid}" then
                    tell sess
                        write text "${msg.replace(/"/g, '\\"')}"
                    end tell
                    return "done"
                end if
            end repeat
        end repeat
    end repeat
end tell`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Park Pair ───────────────────────────────────────────────────────────────

async function parkPair(pairId) {
  const state = server.loadState();
  const pair = (state.pairs || []).find(p => p.id === pairId);
  if (!pair) return { ok: false, error: 'Pair not found' };

  // Add to history as a single entry
  state.history.push({
    badge: pair.captain.badge + ' / ' + pair.first_mate.badge,
    session_name: 'Pair: ' + pair.captain.badge + ' + ' + pair.first_mate.badge,
    is_pair: true,
    pair_id: pair.id,
    captain_session_id: pair.captain.claude_session_id,
    first_mate_session_id: pair.first_mate.claude_session_id,
    captain_badge: pair.captain.badge,
    first_mate_badge: pair.first_mate.badge,
    cwd: pair.cwd,
    parked_at: now(),
    claude_session_id: pair.captain.claude_session_id // for compatibility
  });

  // Close both terminals
  for (const role of [pair.captain, pair.first_mate]) {
    if (role.iterm_uuid) {
      try {
        await server.runOsascript(`
tell application "iTerm2"
    repeat with w from 1 to (count of windows)
        repeat with t from 1 to (count of tabs of (window w))
            repeat with s from 1 to (count of sessions of tab t of (window w))
                set sess to session s of tab t of (window w)
                if (unique ID of sess) is "${role.iterm_uuid}" then
                    close sess
                    return "closed"
                end if
            end repeat
        end repeat
    end repeat
end tell`);
      } catch {}
    }
  }

  // Stop watching comm file
  stopCommWatcher(pairId);

  // Delete comm file (sessions hold all context internally)
  try { fs.unlinkSync(pair.comm_file); } catch {}

  // Remove both sessions from snapshot
  const pairSessionIds = new Set([pair.captain.claude_session_id, pair.first_mate.claude_session_id,
    pair.captain.iterm_uuid, pair.first_mate.iterm_uuid].filter(Boolean));
  state.snapshot.sessions = state.snapshot.sessions.filter(s =>
    !pairSessionIds.has(s.claude_session_id) && !pairSessionIds.has(s.iterm_uuid));
  state.snapshot.session_count = state.snapshot.sessions.length;

  // Remove pair from active pairs
  state.pairs = (state.pairs || []).filter(p => p.id !== pairId);
  server.saveState(state);

  await new Promise(r => setTimeout(r, 2000));
  await server.takeSnapshot();

  return { ok: true };
}

// ─── Restore Pair ────────────────────────────────────────────────────────────

async function restorePair(historyIdx) {
  const state = server.loadState();
  const entry = state.history[historyIdx];
  if (!entry || !entry.is_pair) return { ok: false, error: 'Not a pair' };

  const pairId = 'pair-' + Date.now();
  const commFile = path.join(pairsDir(), pairId + '.txt');
  const cwd = entry.cwd || path.join(os.homedir(), 'repos', 'fleet');

  // Create fresh comm file with handshake
  const ts = now();
  fs.writeFileSync(commFile, [
    `[${ts}] Captain: Ahoy First Mate. Resuming our session. Standing by.`,
    `[${ts}] First Mate: Aye aye, Captain. Ready to continue.`,
    ''
  ].join('\n'));

  // Write system prompt files
  const captainPromptFile = path.join(os.tmpdir(), `tt-pair-captain-${pairId}.txt`);
  const matePromptFile = path.join(os.tmpdir(), `tt-pair-mate-${pairId}.txt`);
  fs.writeFileSync(captainPromptFile, captainPrompt(commFile, entry.first_mate_badge));
  fs.writeFileSync(matePromptFile, firstMatePrompt(commFile, entry.captain_badge));

  const safeMode = server.SAFE_MODE;
  const cwdEscaped = cwd.replace(/'/g, "'\\''");

  // Restore Captain
  const captainTty = await openPairTerminal(cwdEscaped, entry.captain_badge, captainPromptFile, safeMode, entry.captain_session_id);

  await new Promise(r => setTimeout(r, 3000));

  // Restore First Mate
  const mateTty = await openPairTerminal(cwdEscaped, entry.first_mate_badge, matePromptFile, safeMode, entry.first_mate_session_id);

  // Wait for Claude, snapshot, find sessions
  await new Promise(r => setTimeout(r, 5000));
  await server.takeSnapshot();

  const freshState = server.loadState();
  const captainSession = freshState.snapshot.sessions.find(s => s.badge === entry.captain_badge);
  const mateSession = freshState.snapshot.sessions.find(s => s.badge === entry.first_mate_badge);

  // Create new active pair
  const pair = {
    id: pairId,
    created_at: now(),
    status: 'active',
    cwd,
    captain: {
      badge: entry.captain_badge,
      iterm_uuid: captainSession ? captainSession.iterm_uuid : '',
      claude_session_id: entry.captain_session_id,
      tty: captainTty
    },
    first_mate: {
      badge: entry.first_mate_badge,
      iterm_uuid: mateSession ? mateSession.iterm_uuid : '',
      claude_session_id: entry.first_mate_session_id,
      tty: mateTty
    },
    comm_file: commFile
  };

  if (!freshState.pairs) freshState.pairs = [];
  freshState.pairs.push(pair);

  // Remove from history
  freshState.history.splice(historyIdx, 1);
  server.saveState(freshState);

  // Clean up prompt files
  setTimeout(() => {
    try { fs.unlinkSync(captainPromptFile); } catch {}
    try { fs.unlinkSync(matePromptFile); } catch {}
  }, 30000);

  return { ok: true, pair };
}

// ─── Disband Pair ────────────────────────────────────────────────────────────

function disbandPair(pairId) {
  const state = server.loadState();
  state.pairs = (state.pairs || []).filter(p => p.id !== pairId);
  server.saveState(state);
  return { ok: true };
}

// ─── Get Comm Log ────────────────────────────────────────────────────────────

function getCommLog(pairId) {
  const state = server.loadState();
  const pair = (state.pairs || []).find(p => p.id === pairId);
  if (!pair) return { ok: false, error: 'Pair not found' };

  try {
    const content = fs.readFileSync(pair.comm_file, 'utf8');
    return { ok: true, messages: content };
  } catch {
    return { ok: true, messages: '(no comm file)' };
  }
}

// ─── API Handler ─────────────────────────────────────────────────────────────

async function handlePairAPI(req, res, url, pathParts) {
  // GET /api/pairs
  if (req.method === 'GET' && pathParts.length === 2 && pathParts[1] === 'pairs') {
    const state = server.loadState();
    const enriched = (state.pairs || []).map(p => {
      let msgCount = 0;
      try {
        const content = fs.readFileSync(p.comm_file, 'utf8');
        msgCount = content.split('\n').filter(l => l.trim()).length;
      } catch {}
      return { ...p, comm_messages: msgCount };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(enriched));
    return;
  }

  // POST /api/pairs (create)
  if (req.method === 'POST' && pathParts.length === 2 && pathParts[1] === 'pairs') {
    const body = await readBody(req);
    const { captainBadge, firstMateBadge, cwd } = JSON.parse(body);
    if (!captainBadge || !firstMateBadge) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Both names required' }));
      return;
    }
    const result = await createPair(captainBadge, firstMateBadge, cwd);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/pairs/:id/comm
  if (req.method === 'GET' && pathParts.length === 4 && pathParts[3] === 'comm') {
    const result = getCommLog(pathParts[2]);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/pairs/:id/relay-to-mate
  if (req.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'relay-to-mate') {
    const result = await relayToMate(pathParts[2]);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/pairs/:id/relay-to-captain
  if (req.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'relay-to-captain') {
    const result = await relayToCaptain(pathParts[2]);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/pairs/:id/park
  if (req.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'park') {
    const result = await parkPair(pathParts[2]);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/pairs/:id/restore
  if (req.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'restore') {
    const pairId = pathParts[2];
    const state = server.loadState();
    const idx = state.history.findIndex(h => h.pair_id === pairId || (h.is_pair && h.pair_id === pairId));
    if (idx === -1) {
      // Try by history index from query
      const histIdx = parseInt(url.searchParams.get('histIdx'));
      if (!isNaN(histIdx)) {
        const result = await restorePair(histIdx);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Pair not found in history' }));
      return;
    }
    const result = await restorePair(idx);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/pairs/:id/disband
  if (req.method === 'POST' && pathParts.length === 4 && pathParts[3] === 'disband') {
    const result = disbandPair(pathParts[2]);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
  });
}

function getPairSessionIds() {
  const state = server.loadState();
  const ids = new Set();
  for (const pair of (state.pairs || [])) {
    if (pair.captain.claude_session_id) ids.add(pair.captain.claude_session_id);
    if (pair.first_mate.claude_session_id) ids.add(pair.first_mate.claude_session_id);
    if (pair.captain.iterm_uuid) ids.add(pair.captain.iterm_uuid);
    if (pair.first_mate.iterm_uuid) ids.add(pair.first_mate.iterm_uuid);
  }
  return ids;
}

module.exports = { init, handlePairAPI, getPairSessionIds };
