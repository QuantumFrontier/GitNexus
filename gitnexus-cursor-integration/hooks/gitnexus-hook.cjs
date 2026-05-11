#!/usr/bin/env node
/**
 * GitNexus Cursor postToolUse Hook
 *
 * Receives a JSON event on stdin describing a finished tool call, derives a
 * search pattern (Grep query, Read file basename, or rg/grep arg from a Shell
 * command), runs `gitnexus augment <pattern>`, and emits the enriched context
 * back as `{ additional_context: "..." }` so the agent sees it alongside the
 * tool result.
 *
 * Replaces the legacy beforeShellExecution / augment-shell.sh pipeline:
 *   - Cross-platform (no bash, no jq — runs on Windows out of the box)
 *   - Covers Read and Grep, not just Shell rg/grep
 *
 * Cursor 2.4+ generic hooks: https://cursor.com/docs/agent/hooks
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function isGlobalRegistryDir(candidate) {
  if (fs.existsSync(path.join(candidate, 'meta.json'))) return false;
  return (
    fs.existsSync(path.join(candidate, 'registry.json')) ||
    fs.existsSync(path.join(candidate, 'repos'))
  );
}

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
  const fromCwd = walkForGitNexusDir(cwd);
  if (fromCwd) return fromCwd;
  const canonicalRoot = findCanonicalRepoRoot(cwd);
  if (canonicalRoot && canonicalRoot !== cwd) {
    return walkForGitNexusDir(canonicalRoot);
  }
  return null;
}

function parseRgGrepPattern(cmd) {
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

/**
 * Extract a search pattern from the tool input. Cursor 2.4 docs at
 * https://cursor.com/docs/agent/hooks list the tool *matchers* but do not
 * formally specify the per-tool tool_input field names, so we probe a
 * generous set of MCP-style aliases. As a last-resort fallback for Grep
 * (the highest-frequency search path) we also accept the longest plausible
 * string value in tool_input. Set GITNEXUS_DEBUG=1 to log the raw payload
 * to stderr if Cursor changes the contract and aliases stop matching.
 */
function pickLongestStringValue(obj) {
  let best = null;
  if (!obj || typeof obj !== 'object') return null;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length >= 3 && (!best || v.length > best.length)) {
      best = v;
    }
  }
  return best;
}

function extractPattern(toolName, toolInput) {
  const t = (toolName || '').toLowerCase();

  if (t === 'grep') {
    const aliases = [
      toolInput.query,
      toolInput.pattern,
      toolInput.regex,
      toolInput.q,
      toolInput.search,
      toolInput.searchQuery,
    ];
    for (const a of aliases) {
      if (typeof a === 'string' && a.length >= 3) return a;
    }
    // Last resort: scan tool_input for any reasonable-looking string value.
    return pickLongestStringValue(toolInput);
  }

  if (t === 'read') {
    const filePath =
      toolInput.target_file ||
      toolInput.file_path ||
      toolInput.filePath ||
      toolInput.path ||
      toolInput.file ||
      '';
    if (!filePath) return null;
    const base = path.basename(String(filePath), path.extname(String(filePath)));
    const cleaned = base.replace(/[^a-zA-Z0-9_]/g, '');
    return cleaned.length >= 3 ? cleaned : null;
  }

  if (t === 'shell') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;
    // NOTE: parseRgGrepPattern uses split(/\s+/) and cannot handle shell
    // quoting. `rg "User Service" src/` returns "User" (the first token
    // after the rg/grep arg, with surrounding quotes stripped) — the
    // multi-word pattern is intentionally not reconstructed since BM25 is
    // already token-tolerant. Quoted single tokens (`rg "validateUser"`)
    // work fine.
    return parseRgGrepPattern(cmd);
  }

  return null;
}

function resolveCliPath() {
  try {
    return require.resolve('gitnexus/dist/cli/index.js');
  } catch {
    return '';
  }
}

/**
 * Concurrency guard for the augment subprocess.
 *
 * Editors fire postToolUse hooks per parallel tool call. With no cap, N
 * parallel Grep/Read/Shell tool calls spawn N concurrent `gitnexus augment`
 * subprocesses — each a Node + LadybugDB cold start that holds resources
 * for several seconds. Issue #1486 reported 180+ piled-up processes and
 * load average > 100 on the Claude variant; the same shape applies here.
 *
 * Implementation: lockfiles named `<pid>.lock` under `<.gitnexus>/.hook-locks/`.
 * Stale entries are pruned by age (>30s mtime) or by pid-liveness check.
 */
const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

function acquireHookSlot(gitNexusDir) {
  const lockDir = path.join(gitNexusDir, HOOK_LOCK_SUBDIR);
  let entries;
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    entries = fs.readdirSync(lockDir);
  } catch {
    return () => {};
  }

  const now = Date.now();
  let active = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue;
    const lockPath = path.join(lockDir, entry);
    const pid = Number.parseInt(entry, 10);
    let stale = false;
    try {
      const stat = fs.statSync(lockPath);
      if (now - stat.mtimeMs > HOOK_LOCK_STALE_MS) stale = true;
    } catch {
      stale = true;
    }
    if (!stale && Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        active++;
        continue;
      } catch {
        stale = true;
      }
    }
    if (stale) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another hook beat us to it */
      }
    }
  }

  if (active >= HOOK_LOCK_MAX_INFLIGHT) return null;

  const ownLock = path.join(lockDir, `${process.pid}.lock`);
  try {
    fs.writeFileSync(ownLock, '', { flag: 'wx' });
  } catch {
    return () => {};
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(ownLock);
    } catch {
      /* pruned by another hook */
    }
  };
  process.on('exit', release);
  return release;
}

function runGitNexusCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function main() {
  try {
    const input = readInput();
    if (process.env.GITNEXUS_DEBUG) {
      // Echo the payload so users can capture Cursor's actual contract when
      // diagnosing why augmentation isn't firing. Stderr only — stdout is
      // reserved for the JSON response Cursor consumes.
      try {
        process.stderr.write(
          `GitNexus Cursor hook stdin: ${JSON.stringify(input).slice(0, 500)}\n`,
        );
      } catch {
        /* never let debug logging break the hook */
      }
    }
    const cwd = input.cwd || process.cwd();
    if (!path.isAbsolute(cwd)) return;
    const gitNexusDir = findGitNexusDir(cwd);
    if (!gitNexusDir) return;

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    const pattern = extractPattern(toolName, toolInput);
    if (!pattern || pattern.length < 3) return;

    const release = acquireHookSlot(gitNexusDir);
    if (!release) return;

    const cliPath = resolveCliPath();
    let result = '';
    try {
      const child = runGitNexusCli(cliPath, ['augment', '--', pattern], cwd, 7000);
      if (!child.error && child.status === 0) {
        result = child.stderr || '';
      }
    } catch {
      /* graceful failure */
    } finally {
      release();
    }

    if (result && result.trim()) {
      console.log(JSON.stringify({ additional_context: result.trim() }));
    }
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus Cursor hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
