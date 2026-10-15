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
const RUNNER_SKILLS = ['review-plan', 'review-impl', 'review-think', 'review-commit', 'review-pr'];
const PLAIN_SKILLS = ['loop-plan', 'loop-implement'];
// Names from the earlier codex-review pack; copies it installed are deleted on install.
const LEGACY_RUNTIME = 'codex-review';
const LEGACY_SKILLS = [
  'codex-plan-review', 'codex-impl-review', 'codex-think-about', 'codex-commit-review', 'codex-pr-review',
  'codex-parallel-review', 'codex-codebase-review', 'codex-security-review',
];
const LEGACY_MCP_NAME = 'codex-review';

const MCP_NAME = PACK;
const MCP_TOOLS = ['review_begin', 'review_wait', 'review_reply', 'review_end'];
// Seconds review_wait blocks by default. Codex allows 60 s per MCP tool call (tool_timeout_sec);
// Claude Code allows far longer, so fewer calls are needed there.
const WAIT_DEFAULT_S = { claude: 300, codex: 50 };

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
 * Pre-approve this server's tools in Codex's config.toml. `codex exec` runs with approval
 * policy "never", which rejects MCP tool calls that need approval; `codex mcp add` drops
 * these tables on re-add, so they are rewritten after every registration.
 */
function approveCodexTools(configPath) {
  const prefix = `[mcp_servers.${MCP_NAME}.tools.`;
  const kept = [];
  let skipping = false;
  for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
    if (line.startsWith('[')) skipping = line.startsWith(prefix);
    if (!skipping) kept.push(line);
  }
  let text = kept.join('\n').replace(/\n*$/, '\n');
  for (const tool of MCP_TOOLS) text += `\n${prefix}${tool}]\napproval_mode = "approve"\n`;
  fs.writeFileSync(configPath, text, 'utf8');
}

/** True when a directory in a skills root was installed by this pack or its predecessor (safe to delete). */
function isPackInstall(dir, name) {
  if (name === PACK) return fs.existsSync(path.join(dir, 'scripts', 'review-runner.js'));
  if (name === LEGACY_RUNTIME) return fs.existsSync(path.join(dir, 'scripts', 'codex-runner.js'));
  try {
    const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    return new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(skillMd);
  } catch {
    return false;
  }
}

// Compared with '/' separators: config files may store Windows paths with escaped backslashes
const LEGACY_SERVER_SCRIPT = `${LEGACY_RUNTIME}/scripts/mcp-server.js`;
const slashed = s => String(s).replace(/\\+/g, '/');

/** The earlier pack's MCP server is registered with Claude Code (user scope). */
function claudeHasLegacyServer() {
  try {
    const servers = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers || {};
    return (servers[LEGACY_MCP_NAME]?.args || []).some(a => slashed(a).endsWith(LEGACY_SERVER_SCRIPT));
  } catch {
    return false;
  }
}

/** The earlier pack's MCP server is registered in Codex's config.toml. */
function codexHasLegacyServer() {
  try {
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const block = toml.split(/^(?=\[)/m).find(b => b.startsWith(`[mcp_servers.${LEGACY_MCP_NAME}]`));
    return Boolean(block && slashed(block).includes(LEGACY_SERVER_SCRIPT));
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
  for (const file of ['package.json', 'package-lock.json']) {
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
      const rendered = renderSkillTemplate(skillPackDir, skill, isRunnerSkill ? renderOpts : { client });
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
  // Remove the earlier pack's runtime and skills, and this pack's copies in Codex's deprecated skills root
  const stale = [
    ...[claudeSkillsRoot, agentsSkillsRoot].flatMap(root => [LEGACY_RUNTIME, ...LEGACY_SKILLS].map(name => ({ root, name }))),
    ...[PACK, LEGACY_RUNTIME, ...SKILLS, ...LEGACY_SKILLS].map(name => ({ root: legacyCodexSkillsRoot, name })),
  ];
  // A stale root may alias an install root (e.g. ~/.codex/skills → ~/.agents/skills); never delete what was just installed
  const installedReal = new Set(targets.flatMap(t => t.dirs.map(dir => fs.realpathSync(path.join(t.root, dir)))));
  for (const { root, name } of stale) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir) || installedReal.has(fs.realpathSync(dir))) continue;
    if (!isPackInstall(dir, name)) {
      console.warn(`Warning: left ${dir} in place; it does not look like a ${PACK} or ${LEGACY_RUNTIME} install`);
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
  // The earlier pack's server registration is removed when it points at that pack's runtime.
  const registered = [];
  if (mcpReady) {
    const serverCmd = ['--', stableNodePath(), mcpServerPath];
    if (commandExists('claude')) {
      if (claudeHasLegacyServer()) run('claude', ['mcp', 'remove', '-s', 'user', LEGACY_MCP_NAME]);
      run('claude', ['mcp', 'remove', '-s', 'user', MCP_NAME]);
      const r = run('claude', ['mcp', 'add', '-s', 'user', MCP_NAME, '-e', `REVIEW_WAIT_DEFAULT_S=${WAIT_DEFAULT_S.claude}`, ...serverCmd]);
      if (r.ok) registered.push('Claude Code');
      else console.warn(`Warning: could not register the MCP server with Claude Code: ${r.output}`);
    }
    if (commandExists('codex')) {
      fs.mkdirSync(codexHome, { recursive: true });
      // `codex mcp remove` also drops the server's tool approval tables
      if (codexHasLegacyServer()) run('codex', ['mcp', 'remove', LEGACY_MCP_NAME]);
      const r = run('codex', ['mcp', 'add', MCP_NAME, '--env', `REVIEW_WAIT_DEFAULT_S=${WAIT_DEFAULT_S.codex}`, ...serverCmd]);
      if (r.ok) {
        approveCodexTools(path.join(codexHome, 'config.toml'));
        registered.push('Codex');
      } else {
        console.warn(`Warning: could not register the MCP server with Codex: ${r.output}`);
      }
    }
  }

  // 6. Success message
  console.log('');
  console.log(`${PACK} skills installed successfully!`);
  console.log(`  Runtime:       ${runtimeDir}`);
  console.log(`  Claude Code:   ${claudeSkillsRoot}`);
  console.log(`  Codex:         ${agentsSkillsRoot}`);
  console.log(`  MCP server:    ${registered.length ? `registered with ${registered.join(' and ')}` : 'not registered (runner CLI fallback)'}`);
  console.log('');
  console.log('Skills (Claude Code: /name, Codex: $name):');
  console.log('  loop-plan             — write a phased, code-grounded implementation plan');
  console.log('  loop-implement        — execute an approved loop plan phase by phase');
  console.log('  review-plan           — debate plans before implementation');
  console.log('  review-impl           — review uncommitted or branch changes');
  console.log('  review-think          — peer reasoning/debate');
  console.log('  review-commit         — review committed code before push');
  console.log('  review-pr             — review PRs (branch diff + description)');

  // --auto: inject review guidance into global ~/.claude/CLAUDE.md
  if (autoMode) {
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
        '## Cross Review — Auto-review Guidance',
        '',
        'When the user is working on code changes, **proactively suggest** the appropriate review skill based on context:',
        '',
        '| Context | Suggested Skill | Trigger | Note |',
        '|---------|----------------|---------|------|',
        '| Multi-step feature or change that needs a plan | `/loop-plan` | Before coding | |',
        '| Approved loop plan with incomplete phases | `/loop-implement` | After the plan is approved | |',
        '| Uncommitted changes (staged/unstaged) | `/review-impl` | Before committing | |',
        '| Feature branch with commits | `/review-pr` | Before creating/merging PR | |',
        '| Plan/design document created or modified | `/review-plan` | After writing plan | |',
        '| Recent commits before push | `/review-commit` | After committing, before push | |',
        '| Technical question or architecture debate | `/review-think` | On design discussions | |',
        '',
        '**Rules:**',
        '- Always ask the user before running a review skill — never auto-run without confirmation',
        '- Phrase as a suggestion: "Would you like me to run `/review-impl` before committing?"',
        '- Only suggest when context clearly matches — do not over-suggest',
        '',
        END_MARKER,
      ].join('\n');

      fs.mkdirSync(claudeDir, { recursive: true });

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
      } else if (found.some(m => m.startIdx !== -1 || m.endIdx !== -1)) {
        // Partial/corrupt markers — warn and skip to avoid data corruption
        throw new Error('Found partial review-guidance markers in ~/.claude/CLAUDE.md — remove them manually and re-run');
      } else {
        // Append to end
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
        updated = existing + separator + guidanceBlock + '\n';
      }

      fs.writeFileSync(claudeMdPath, updated, 'utf8');
      console.log('');
      console.log('Auto-review guidance injected into ~/.claude/CLAUDE.md');
    } catch (err) {
      console.warn('');
      console.warn(`Warning: could not inject auto-review guidance into ~/.claude/CLAUDE.md`);
      console.warn(`  Reason: ${err.message}`);
      console.warn('  Skills were installed successfully — only guidance injection failed.');
    }
  } else {
    console.log('');
    console.log('Optional: npx github:lploc94/cross-review --auto');
    console.log('  Injects review guidance into ~/.claude/CLAUDE.md');
  }
} catch (err) {
  // Cleanup staging on any error
  for (const t of targets) {
    if (fs.existsSync(t.staging)) fs.rmSync(t.staging, { recursive: true, force: true });
  }
  console.error(err.message || err);
  process.exit(1);
}
