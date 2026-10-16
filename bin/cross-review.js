#!/usr/bin/env node

// Runtime guard: Node.js >= 22 required (Codex CLI requirement)
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(`Error: Node.js >= 22 required (found ${process.version})`);
  process.exit(1);
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSkillTemplate } from './lib/render-skill.js';

// `npx github:lploc94/cross-review dashboard`: run the dashboard from the package itself; no install step runs
if (process.argv[2] === 'dashboard') {
  const { runDashboardCli } = await import('../skill-packs/cross-review/scripts/lib/dashboard/server.js');
  process.exit(await runDashboardCli(process.argv.slice(3)));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const PACK = 'cross-review';
const skillPackDir = path.join(packageRoot, 'skill-packs', PACK);
const home = os.homedir();
// Claude Code skills, plus the shared runtime (runner, MCP server, dependencies)
const claudeSkillsRoot = path.join(home, '.claude', 'skills');
// Codex reads user skills from ~/.agents/skills; $CODEX_HOME/skills is its deprecated location
const agentsSkillsRoot = path.join(home, '.agents', 'skills');
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
const legacyCodexSkillsRoot = path.join(codexHome, 'skills');

const runtimeDir = path.join(claudeSkillsRoot, PACK);
const runnerPath = path.join(runtimeDir, 'scripts', 'review-runner.js');
const mcpServerPath = path.join(runtimeDir, 'scripts', 'mcp-server.js');

// RUNNER_SKILLS drive the reviewer through the runner; their SKILL.md templates are rendered with the shared protocol.
// PLAIN_SKILLS are self-contained SKILL.md templates rendered only with the client's {{CLIENT_*}} values.
const RUNNER_SKILLS = ['review-plan', 'review-impl', 'review-think', 'review-pr'];
const PLAIN_SKILLS = ['loop-plan', 'loop-implement'];
// Names from the earlier codex-review pack; copies it installed are deleted on install.
const LEGACY_RUNTIME = 'codex-review';
const LEGACY_SKILLS = [
  'codex-plan-review', 'codex-impl-review', 'codex-think-about', 'codex-commit-review', 'codex-pr-review',
  'codex-parallel-review', 'codex-codebase-review', 'codex-security-review',
];
const LEGACY_MCP_NAME = 'codex-review';
// Skills this pack used to install and has since dropped (review-commit: folded into review-impl).
const RETIRED_SKILLS = ['review-commit'];

const MCP_NAME = PACK;
const MCP_TOOLS = ['review_begin', 'review_wait', 'review_reply', 'review_end'];
// Seconds review_wait blocks by default: few calls per review, each under the 5-minute prompt
// cache TTL. Codex allows 60 s per MCP tool call unless the server sets tool_timeout_sec.
const WAIT_DEFAULT_S = 270;
const CODEX_TOOL_TIMEOUT_S = 300;

// The cross-review command: a shell script that runs the installed runner (`cross-review dashboard`, …).
// The marker tells a script this installer wrote from anyone else's file of the same name.
const commandDir = path.join(home, '.local', 'bin');
const commandPath = path.join(commandDir, PACK);
const COMMAND_MARKER = '# cross-review command, written by the cross-review installer; reinstalling rewrites it';

const autoMode = process.argv.includes('--auto');
const SKILLS = [...RUNNER_SKILLS, ...PLAIN_SKILLS];

if (process.argv.includes('-full')) {
  console.warn('Note: -full is no longer needed; parallel, codebase and security reviews were removed from the pack.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape characters special in double-quoted shell strings: \ " $ ` */
function escapeForDoubleQuotedShell(s) {
  return s.replace(/[\\"$`]/g, '\\$&');
}

/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Run a CLI quietly; returns { ok, output }. */
function run(cmd, args, opts = {}) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      timeout: 120_000,
      ...opts,
    });
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message };
  }
}

function commandExists(cmd) {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 5000 }).ok;
}

/**
 * Node binary for the MCP registration. Prefer the PATH entry (e.g. /opt/homebrew/bin/node)
 * when it is the node running this installer: versioned paths such as
 * /opt/homebrew/Cellar/node/<version>/bin/node disappear on upgrade.
 */
function stableNodePath() {
  const found = run(process.platform === 'win32' ? 'where' : 'which', ['node'], { timeout: 5000 });
  const candidate = found.ok ? found.output.split(/\r?\n/)[0].trim() : '';
  try {
    if (candidate && fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate;
  } catch { /* fall through */ }
  return process.execPath;
}

/**
 * Pre-approve this server's tools in Codex's config.toml and raise its tool timeout above
 * WAIT_DEFAULT_S. `codex exec` runs with approval policy "never", which rejects MCP tool calls
 * that need approval; `codex mcp add` drops these settings on re-add, so they are rewritten
 * after every registration.
 */
function approveCodexTools(configPath) {
  const header = `[mcp_servers.${MCP_NAME}]`;
  const prefix = `[mcp_servers.${MCP_NAME}.tools.`;
  const kept = [];
  let skipping = false;
  let inServer = false;
  for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
    if (line.startsWith('[')) {
      skipping = line.startsWith(prefix);
      inServer = line === header;
    }
    if (skipping || (inServer && /^tool_timeout_sec\s*=/.test(line))) continue;
    kept.push(line);
    if (line === header) kept.push(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_S}.0`);
  }
  let text = kept.join('\n').replace(/\n*$/, '\n');
  for (const tool of MCP_TOOLS) text += `\n${prefix}${tool}]\napproval_mode = "approve"\n`;
  fs.writeFileSync(configPath, text, 'utf8');
}

/** Quote a string for a POSIX shell: single quotes, with each ' written as '\'' */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Write ~/.local/bin/cross-review, or rewrite the one an earlier install wrote. Anything else at that path
 * (another file, a link) is left alone. Returns { written, note }; never throws.
 */
function installCommand(nodePath) {
  try {
    let st = null;
    try {
      st = fs.lstatSync(commandPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (st && !(st.isFile() && fs.readFileSync(commandPath, 'utf8').includes(COMMAND_MARKER))) {
      return { written: false, note: `left ${commandPath} in place; the installer did not write it. Run the dashboard with: node ${shellQuote(runnerPath)} dashboard` };
    }
    fs.mkdirSync(commandDir, { recursive: true });
    const text = `#!/bin/sh\n${COMMAND_MARKER}\nexec ${shellQuote(nodePath)} ${shellQuote(runnerPath)} "$@"\n`;
    const tmp = path.join(commandDir, `.${PACK}-${uid}`);
    fs.writeFileSync(tmp, text, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, commandPath);
    const onPath = (process.env.PATH || '').split(path.delimiter).some(d => d && path.resolve(d) === commandDir);
    return { written: true, note: onPath ? null : `${commandDir} is not on your PATH; add it (for example: export PATH="$HOME/.local/bin:$PATH" in your shell profile)` };
  } catch (e) {
    return { written: false, note: `could not write ${commandPath}: ${e.message}` };
  }
}

// The earlier pack's runtime lived only here; its skills had this runner path rendered into them
const legacyRuntimeDir = path.join(claudeSkillsRoot, LEGACY_RUNTIME);
const legacyRunnerRef = escapeForDoubleQuotedShell(path.join(legacyRuntimeDir, 'scripts', 'codex-runner.js'));
// Retired skills of this pack carry this pack's runner path instead
const currentRunnerRef = escapeForDoubleQuotedShell(runnerPath);

/**
 * True when a directory in a skills root was installed by the earlier pack (safe to delete): the runtime holds
 * its runner; a skill has the old name and the old runner path, as the earlier installer rendered it.
 */
function isLegacyInstall(dir, name) {
  if (name === LEGACY_RUNTIME) return fs.existsSync(path.join(dir, 'scripts', 'codex-runner.js'));
  try {
    const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const runnerRef = RETIRED_SKILLS.includes(name) ? currentRunnerRef : legacyRunnerRef;
    return new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(skillMd) && skillMd.includes(runnerRef);
  } catch {
    return false;
  }
}

// The only server path the earlier pack registered. Compared with '/' separators: config files
// may store Windows paths with escaped backslashes.
const slashed = s => String(s).replace(/\\+/g, '/');
const legacyServerPath = slashed(path.join(legacyRuntimeDir, 'scripts', 'mcp-server.js'));

/** The earlier pack's MCP server is registered with Claude Code (user scope). */
function claudeHasLegacyServer() {
  try {
    const servers = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers || {};
    return (servers[LEGACY_MCP_NAME]?.args || []).some(a => slashed(a) === legacyServerPath);
  } catch {
    return false;
  }
}

/**
 * The earlier pack's MCP server is registered with Codex (args as Codex itself parses config.toml).
 * Run from the filesystem root, outside any project: a trusted project's config would otherwise
 * shadow the global registration, which is the one `codex mcp remove` deletes.
 */
function codexHasLegacyServer() {
  const r = run('codex', ['mcp', 'get', LEGACY_MCP_NAME, '--json'], { cwd: path.parse(home).root });
  if (!r.ok) return false;
  try {
    return (JSON.parse(r.output).transport?.args || []).some(a => slashed(a) === legacyServerPath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build staging directories (one per skills root, so the final renames stay on one filesystem)
// ---------------------------------------------------------------------------

const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const targets = [
  { root: claudeSkillsRoot, dirs: [PACK, ...SKILLS] },
  { root: agentsSkillsRoot, dirs: [...SKILLS] },
];
for (const t of targets) t.staging = path.join(t.root, `.${PACK}-staging-${uid}`);
const [claudeTarget, agentsTarget] = targets;

try {
  for (const t of targets) fs.mkdirSync(t.staging, { recursive: true });

  // 1. Shared runtime: runner, its modules, MCP server, and the MCP SDK from the lock file
  const stagedRuntime = path.join(claudeTarget.staging, PACK);
  const stagedScripts = path.join(stagedRuntime, 'scripts');
  fs.mkdirSync(stagedScripts, { recursive: true });
  for (const file of ['review-runner.js', 'mcp-server.js']) {
    fs.copyFileSync(path.join(skillPackDir, 'scripts', file), path.join(stagedScripts, file));
  }
  copyDirSync(path.join(skillPackDir, 'scripts', 'lib'), path.join(stagedScripts, 'lib'));
  // manifest.json gives the dashboard its pack version
  for (const file of ['package.json', 'package-lock.json', 'manifest.json']) {
    fs.copyFileSync(path.join(skillPackDir, file), path.join(stagedRuntime, file));
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(stagedScripts, 'review-runner.js'), 0o755);
  }

  console.log('Installing MCP server dependencies ...');
  const npmCi = run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stagedRuntime, timeout: 300_000 });
  const mcpReady = npmCi.ok;
  if (!mcpReady) {
    console.warn('⚠️  Warning: npm ci failed; the MCP server will not be registered. The skills still work through the runner CLI.');
    console.warn(`   ${npmCi.output.split('\n').slice(-3).join('\n   ')}`);
  }

  // 2. Skills for both clients. Codex copies use the shared runtime under ~/.claude/skills.
  const renderOpts = {
    runnerPath: escapeForDoubleQuotedShell(runnerPath),
    skillsDir: escapeForDoubleQuotedShell(claudeSkillsRoot),
  };
  for (const skill of SKILLS) {
    const skillSrcDir = path.join(skillPackDir, 'skills', skill);
    const isRunnerSkill = RUNNER_SKILLS.includes(skill);
    for (const [target, client] of [[claudeTarget, 'claude'], [agentsTarget, 'codex']]) {
      const skillDestDir = path.join(target.staging, skill);
      fs.mkdirSync(skillDestDir, { recursive: true });
      const rendered = renderSkillTemplate(skillPackDir, skill, isRunnerSkill ? renderOpts : { ...renderOpts, client });
      fs.writeFileSync(path.join(skillDestDir, 'SKILL.md'), rendered, 'utf8');
    }
    if (isRunnerSkill) {
      // Prompt templates and output formats the runner renders (read from ~/.claude/skills only)
      const refsSrc = path.join(skillSrcDir, 'references');
      if (!fs.existsSync(refsSrc)) throw new Error(`Missing references/ directory for ${skill}`);
      copyDirSync(refsSrc, path.join(claudeTarget.staging, skill, 'references'));
    }
    // Codex UI metadata
    const agentsMeta = path.join(skillSrcDir, 'agents');
    if (fs.existsSync(agentsMeta)) copyDirSync(agentsMeta, path.join(agentsTarget.staging, skill, 'agents'));
  }

  // 3. Verify runner works
  console.log('Verifying review-runner.js ...');
  const versionOutput = execFileSync(process.execPath, [path.join(stagedScripts, 'review-runner.js'), 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  console.log(`  review-runner.js version: ${versionOutput}`);

  if (!commandExists('codex')) {
    console.warn('');
    console.warn('⚠️  Warning: codex CLI not found in PATH.');
    console.warn('   The default reviewer is the Codex CLI.');
    console.warn('   Install: npm install -g @openai/codex');
  }

  // 4. Atomic swap per directory: backup old → move staging → cleanup. Any failure rolls back every root.
  const backups = [];    // dirs that had a previous install → backed up
  const swapped = [];    // dirs successfully moved from staging → target
  try {
    for (const t of targets) {
      for (const dir of t.dirs) {
        const target = path.join(t.root, dir);
        if (fs.existsSync(target)) {
          const backup = path.join(t.root, `.${dir}-backup-${uid}`);
          fs.renameSync(target, backup);
          backups.push({ dir, target, backup });
        }
        fs.renameSync(path.join(t.staging, dir), target);
        swapped.push({ dir, target });
      }
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const { dir, target } of swapped) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) {
        rollbackErrors.push(`rm ${dir}: ${e.message}`);
      }
    }
    for (const { dir, target, backup } of backups) {
      try { fs.renameSync(backup, target); } catch (e) {
        rollbackErrors.push(`restore ${dir}: ${e.message}`);
      }
    }
    if (rollbackErrors.length) {
      console.error('Rollback errors (manual cleanup may be needed):');
      for (const re of rollbackErrors) console.error(`  - ${re}`);
    }
    throw new Error(`Installation failed: ${err.message}`);
  }

  // Cleanup (non-critical — install already succeeded)
  for (const { backup } of backups) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      console.warn(`Warning: could not remove backup at ${backup}`);
    }
  }
  // Remove the earlier pack's runtime and skills and this pack's retired skills, including copies in
  // Codex's deprecated skills root
  const stale = [claudeSkillsRoot, agentsSkillsRoot, legacyCodexSkillsRoot]
    .flatMap(root => [LEGACY_RUNTIME, ...LEGACY_SKILLS, ...RETIRED_SKILLS].map(name => ({ root, name })));
  // A stale root may alias an install root (e.g. ~/.codex/skills → ~/.agents/skills); never delete what was just installed
  const installedReal = new Set(targets.flatMap(t => t.dirs.map(dir => fs.realpathSync(path.join(t.root, dir)))));
  for (const { root, name } of stale) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir) || installedReal.has(fs.realpathSync(dir))) continue;
    if (!isLegacyInstall(dir, name)) {
      console.warn(`Warning: left ${dir} in place; it does not look like a ${RETIRED_SKILLS.includes(name) ? PACK : LEGACY_RUNTIME} install`);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      console.warn(`Warning: could not remove old skill at ${dir}`);
    }
  }
  for (const t of targets) {
    try { fs.rmSync(t.staging, { recursive: true, force: true }); } catch { /* already gone */ }
  }

  // 5. Register the MCP server with both clients (idempotent: remove then add for Claude; Codex overwrites).
  // The earlier pack's registration goes with its runtime, even when the new server cannot be registered.
  // `codex mcp remove` also drops the server's tool approval tables.
  if (commandExists('claude') && claudeHasLegacyServer()) run('claude', ['mcp', 'remove', '-s', 'user', LEGACY_MCP_NAME]);
  if (commandExists('codex') && codexHasLegacyServer()) run('codex', ['mcp', 'remove', LEGACY_MCP_NAME]);
  const registered = [];
  if (mcpReady) {
    const serverCmd = ['--', stableNodePath(), mcpServerPath];
    if (commandExists('claude')) {
      run('claude', ['mcp', 'remove', '-s', 'user', MCP_NAME]);
      const r = run('claude', ['mcp', 'add', '-s', 'user', MCP_NAME, '-e', `REVIEW_WAIT_DEFAULT_S=${WAIT_DEFAULT_S}`, ...serverCmd]);
      if (r.ok) registered.push('Claude Code');
      else console.warn(`Warning: could not register the MCP server with Claude Code: ${r.output}`);
    }
    if (commandExists('codex')) {
      fs.mkdirSync(codexHome, { recursive: true });
      const r = run('codex', ['mcp', 'add', MCP_NAME, '--env', `REVIEW_WAIT_DEFAULT_S=${WAIT_DEFAULT_S}`, ...serverCmd]);
      if (r.ok) {
        approveCodexTools(path.join(codexHome, 'config.toml'));
        registered.push('Codex');
      } else {
        console.warn(`Warning: could not register the MCP server with Codex: ${r.output}`);
      }
    }
  }

  // 6. The cross-review command (POSIX shells only; on Windows the dashboard runs through npx)
  const command = process.platform === 'win32'
    ? { written: false, note: null }
    : installCommand(stableNodePath());

  // 7. Success message
  console.log('');
  console.log(`${PACK} skills installed successfully!`);
  console.log(`  Runtime:       ${runtimeDir}`);
  console.log(`  Claude Code:   ${claudeSkillsRoot}`);
  console.log(`  Codex:         ${agentsSkillsRoot}`);
  console.log(`  MCP server:    ${registered.length ? `registered with ${registered.join(' and ')}` : 'not registered (runner CLI fallback)'}`);
  console.log(`  Command:       ${command.written ? `${commandPath} (cross-review dashboard)` : 'npx github:lploc94/cross-review dashboard'}`);
  if (command.note) console.warn(`  Note: ${command.note}`);
  console.log('');
  console.log('Skills (Claude Code: /name, Codex: $name):');
  console.log('  loop-plan             — write a phased, code-grounded implementation plan');
  console.log('  loop-implement        — execute an approved loop plan phase by phase');
  console.log('  review-plan           — debate plans before implementation');
  console.log('  review-impl           — review uncommitted changes, unpushed commits, or a branch');
  console.log('  review-think          — peer reasoning/debate');
  console.log('  review-pr             — review PRs (branch diff + description)');

  // Review guidance in ~/.claude/CLAUDE.md. --auto adds it; a block already there is refreshed on every
  // install, so one written by the earlier pack stops recommending its removed skills.
  try {
    const claudeDir = path.join(home, '.claude');
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const START_MARKER = `<!-- ${PACK}-start -->`;
    const END_MARKER = `<!-- ${PACK}-end -->`;
    // Blocks written by the earlier pack are replaced in place
    const MARKERS = [[START_MARKER, END_MARKER], ['<!-- codex-auto-review-start -->', '<!-- codex-auto-review-end -->']];

    const guidanceBlock = [
      START_MARKER,
      '',
      '## Cross Review — automatic reviews',
      '',
      'Run these review skills yourself; do not ask first. They apply to every plan and implementation, not only those of the loop-plan and loop-implement skills:',
      '- After you finish writing a plan (a plan file, plan mode, or a design doc you were asked to write): use the `review-plan` skill on it before presenting it as final or starting to code.',
      '- After you finish implementing a change and its tests pass, before you report it done or commit: use the `review-impl` skill on the uncommitted changes (or the branch diff).',
      '',
      'Skip the review when:',
      '- the change is trivial: docs or comments only, or a one-line fix with no behaviour risk;',
      '- a skill already ran it: the loop-plan skill gets its plan approved through review-plan, and the loop-implement skill runs review-impl at its checkpoints;',
      '- the user said to skip it this time.',
      '',
      END_MARKER,
    ].join('\n');

    let existing = '';
    try {
      existing = fs.readFileSync(claudeMdPath, 'utf8');
    } catch (readErr) {
      if (readErr?.code === 'ENOENT') {
        existing = '';
      } else {
        throw readErr; // Permission error, etc. — let outer catch handle
      }
    }

    const found = MARKERS.map(([start, end]) => ({ start, end, startIdx: existing.indexOf(start), endIdx: existing.indexOf(end) }));
    const block = found.find(m => m.startIdx !== -1 && m.endIdx !== -1 && m.startIdx < m.endIdx);

    let updated;
    if (block) {
      // Replace existing block (idempotent)
      updated = existing.slice(0, block.startIdx) + guidanceBlock + existing.slice(block.endIdx + block.end.length);
    } else if (!autoMode) {
      updated = null;
    } else if (found.some(m => m.startIdx !== -1 || m.endIdx !== -1)) {
      // Partial/corrupt markers — warn and skip to avoid data corruption
      throw new Error('Found partial review-guidance markers in ~/.claude/CLAUDE.md — remove them manually and re-run');
    } else {
      // Append to end
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
      updated = existing + separator + guidanceBlock + '\n';
    }

    if (updated === null) {
      console.log('');
      console.log('Optional: npx github:lploc94/cross-review --auto');
      console.log('  Has Claude Code use the review-plan and review-impl skills automatically (block in ~/.claude/CLAUDE.md)');
    } else {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(claudeMdPath, updated, 'utf8');
      console.log('');
      console.log(`Automatic review block ${block ? 'updated' : 'added'} in ~/.claude/CLAUDE.md`);
    }
  } catch (err) {
    console.warn('');
    console.warn(`Warning: could not write the automatic review block into ~/.claude/CLAUDE.md`);
    console.warn(`  Reason: ${err.message}`);
    console.warn('  Skills were installed successfully — only the automatic review block failed.');
  }
} catch (err) {
  // Cleanup staging on any error
  for (const t of targets) {
    if (fs.existsSync(t.staging)) fs.rmSync(t.staging, { recursive: true, force: true });
  }
  console.error(err.message || err);
  process.exit(1);
}
