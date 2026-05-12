#!/usr/bin/env node
/**
 * GitNexus Claude Code Plugin Hook
 *
 * PreToolUse  — intercepts Grep/Glob/Bash searches and augments
 *               with graph context from the GitNexus index.
 * PostToolUse — detects stale index after git mutations and notifies
 *               the agent to reindex.
 *
 * NOTE: SessionStart hooks are broken on Windows (Claude Code bug #23576).
 * Session context is injected via CLAUDE.md / skills instead.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Find the .gitnexus directory by walking up from startDir.
 * Returns the path to .gitnexus/ or null if not found.
 */
function isGlobalRegistryDir(candidate) {
  if (fs.existsSync(path.join(candidate, 'meta.json'))) return false;
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

/**
 * Walk up from `startDir` looking for a non-registry `.gitnexus/` folder.
 * Returns the path to `.gitnexus/` or null if not found within 5 levels.
 */
function walkForGitNexusDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) {
      if (!isGlobalRegistryDir(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the canonical (main) worktree root for `cwd`, when `cwd` is inside
 * any git working tree — including a *linked* worktree created via
 * `git worktree add`. Linked worktrees never contain `.gitnexus/`, so the
 * upward walk from cwd alone misses the index. Returns null when `cwd` is
 * not inside a git repo or `git` is not available.
 *
 * Implementation: `git rev-parse --git-common-dir` resolves to the canonical
 * `.git/` directory (or `.git/worktrees/...` parent) that is shared across
 * all linked worktrees. The canonical repo root is its parent directory.
 */
function findCanonicalRepoRoot(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 2000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    const commonDir = (result.stdout || '').trim();
    if (!commonDir || !path.isAbsolute(commonDir)) return null;
    return path.dirname(commonDir);
  } catch {
    return null;
  }
}

function findGitNexusDir(startDir) {
  const cwd = startDir || process.cwd();

  // Fast path: the cwd is inside the canonical repo (most common case).
  const fromCwd = walkForGitNexusDir(cwd);
  if (fromCwd) return fromCwd;

  // Fallback: cwd may be inside a linked git worktree whose `.gitnexus/`
  // only lives in the canonical repo root. Resolve the shared git dir
  // and retry from there.
  const canonicalRoot = findCanonicalRepoRoot(cwd);
  if (canonicalRoot && canonicalRoot !== cwd) {
    return walkForGitNexusDir(canonicalRoot);
  }
  return null;
}

/**
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '-g',
      '--glob',
      '-t',
      '--type',
      '--include',
      '--exclude',
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

/**
 * Concurrency guard for the augment subprocess (hard cap).
 *
 * Claude Code fires PreToolUse hooks per parallel tool call. With no cap, N
 * parallel Grep/Glob/Bash tool calls spawn N concurrent `gitnexus augment`
 * subprocesses — each a Node + LadybugDB cold start that holds resources
 * for several seconds. Issue #1486 reported 180+ piled-up processes and
 * load average > 100. We cap in-flight augments to MAX_INFLIGHT and skip
 * silently above that. Augment is a best-effort enrichment; missing a few
 * fires under heavy parallel load is preferable to melting the box.
 *
 * Implementation: fixed-name slot files `slot-0.lock` ... `slot-N.lock`
 * under `<.gitnexus>/.hook-locks/`. Each file is created with `wx`
 * (O_CREAT|O_EXCL), which is atomic across processes at the OS level —
 * exactly one process wins each slot. This is a HARD cap, not the
 * count-then-claim soft cap that an earlier revision shipped (it had a
 * TOCTOU window between readdirSync and the per-pid wx write).
 *
 * Owner identity is written into the slot file as the PID, used for
 * stale-takeover when a hook crashes without releasing. PID-liveness is
 * checked before age so a slow-but-alive hook is never wrongly evicted;
 * the age window only kicks in to defend against PID reuse on a long-
 * abandoned slot.
 */
const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

function acquireHookSlot(gitNexusDir) {
  const lockDir = path.join(gitNexusDir, HOOK_LOCK_SUBDIR);
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch {
    // Cannot create lock dir — fall through unguarded so the hook still works.
    return () => {};
  }

  const myPidStr = String(process.pid);

  for (let slot = 0; slot < HOOK_LOCK_MAX_INFLIGHT; slot++) {
    const slotPath = path.join(lockDir, `slot-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(slotPath, myPidStr, { flag: 'wx' });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try {
            // Only unlink if we still own the slot. If we appeared stale and
            // another hook took over, the file now belongs to it — leave alone.
            const content = fs.readFileSync(slotPath, 'utf-8').trim();
            if (content === myPidStr) fs.unlinkSync(slotPath);
          } catch {
            /* already removed or unreadable */
          }
        };
        process.on('exit', release);
        return release;
      } catch {
        // Slot exists. Decide whether to take it over.
        // Open once and inspect mtime + content via the same fd so there's
        // no TOCTOU between the metadata check and the content read
        // (codeql js/file-system-race).
        let fd;
        try {
          fd = fs.openSync(slotPath, 'r');
        } catch {
          continue; // Vanished between EEXIST and open — retry this slot.
        }
        let isLive = false;
        let mtimeMs = Date.now();
        try {
          mtimeMs = fs.fstatSync(fd).mtimeMs;
          const buf = Buffer.alloc(32);
          const n = fs.readSync(fd, buf, 0, 32, 0);
          const ownerStr = buf.slice(0, n).toString('utf-8').trim();
          if (ownerStr === '') {
            // Owner created the file but hasn't written its PID yet. The
            // wx open+write window is microseconds; give it the benefit
            // of the doubt and treat as live.
            isLive = true;
          } else {
            const owner = Number.parseInt(ownerStr, 10);
            if (Number.isFinite(owner) && owner > 0) {
              try {
                process.kill(owner, 0);
                isLive = true;
              } catch (e) {
                // ESRCH = process gone → treat as dead. EPERM = process exists
                // but owned by another user (cross-user lock dir) → still alive,
                // keep the slot. Anything else: be conservative, assume alive.
                if (e && e.code === 'ESRCH') {
                  isLive = false;
                } else {
                  isLive = true;
                }
              }
            }
          }
        } catch {
          /* unreadable — treat as dead */
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
        // PID-liveness wins over age (avoids evicting a slow-but-alive hook).
        // Age check is a safety net against PID reuse on long-abandoned slots:
        // 30s >> the 7s augment timeout, so a healthy run never hits it.
        if (isLive && Date.now() - mtimeMs > HOOK_LOCK_STALE_MS) {
          isLive = false;
        }
        if (isLive) break; // Try the next slot.
        try {
          fs.unlinkSync(slotPath);
        } catch {
          /* another hook beat us to it — retry will hit EEXIST */
        }
        // Loop and retry this slot.
      }
    }
  }

  return null;
}

/**
 * Spawn a gitnexus CLI command synchronously.
 * Detects binary on PATH once, then runs exactly once.
 *
 * SECURITY: Never use shell: true with user-controlled arguments.
 * On Windows, invoke gitnexus.cmd directly (no shell needed).
 */
function runGitNexusCli(args, cwd, timeout) {
  const isWin = process.platform === 'win32';

  // Detect whether 'gitnexus' is on PATH (cheap check, no execution)
  let useDirectBinary = false;
  try {
    const which = spawnSync(isWin ? 'where' : 'which', ['gitnexus'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    useDirectBinary = which.status === 0;
  } catch {
    /* not on PATH */
  }

  if (useDirectBinary) {
    return spawnSync(isWin ? 'gitnexus.cmd' : 'gitnexus', args, {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  // npx fallback needs shell on Windows since npx is a .cmd script
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Emit a hook response with additional context for the agent.
 */
function sendHookResponse(hookEventName, message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: message },
    }),
  );
}

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const pattern = extractPattern(toolName, toolInput);
  if (!pattern || pattern.length < 3) return;

  const release = acquireHookSlot(gitNexusDir);
  if (!release) return;

  let result = '';
  try {
    const child = runGitNexusCli(['augment', '--', pattern], cwd, 7000);
    if (!child.error && child.status === 0) {
      result = child.stderr || '';
    }
  } catch {
    /* graceful failure */
  } finally {
    release();
  }

  if (result && result.trim()) {
    sendHookResponse('PreToolUse', result.trim());
  }
}

/**
 * PostToolUse handler — detect index staleness after git mutations.
 *
 * Instead of spawning a full `gitnexus analyze` synchronously (which blocks
 * the agent for up to 120s and risks LadybugDB corruption on timeout), we do a
 * lightweight staleness check: compare `git rev-parse HEAD` against the
 * lastCommit stored in `.gitnexus/meta.json`. If they differ, notify the
 * agent so it can decide when to reindex.
 */
function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Bash') return;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return;

  // Only proceed if the command succeeded
  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  // Compare HEAD against last indexed commit — skip if unchanged
  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return;
  }

  if (!currentHead) return;

  let lastCommit = '';
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gitNexusDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  } catch {
    /* no meta — treat as stale */
  }

  // If HEAD matches last indexed commit, no reindex needed
  if (currentHead && currentHead === lastCommit) return;

  const analyzeCmd = `npx gitnexus analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  sendHookResponse(
    'PostToolUse',
    `GitNexus index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
      `Run \`${analyzeCmd}\` to update the knowledge graph.`,
  );
}

// Dispatch map for hook events
const handlers = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
