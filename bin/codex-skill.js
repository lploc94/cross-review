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

const skillPackDir = path.join(packageRoot, 'skill-packs', 'codex-review');
const skillsRoot = path.join(os.homedir(), '.claude', 'skills');
const runnerDir = path.join(skillsRoot, 'codex-review');
const runnerPath = path.join(runnerDir, 'scripts', 'codex-runner.js');

// RUNNER_SKILLS drive Codex through codex-runner.js; their SKILL.md templates are rendered with the shared protocol and need references/.
// PLAIN_SKILLS are self-contained SKILL.md templates rendered only with the client's {{CLIENT_*}} values.
const RUNNER_SKILLS = ['codex-plan-review', 'codex-impl-review', 'codex-think-about', 'codex-commit-review', 'codex-pr-review'];
const PLAIN_SKILLS = ['loop-plan', 'loop-implement'];
// Skills removed from the pack; previously installed copies are deleted on install.
const REMOVED_SKILLS = ['codex-parallel-review', 'codex-codebase-review', 'codex-security-review'];

const autoMode = process.argv.includes('--auto');
const SKILLS = [...RUNNER_SKILLS, ...PLAIN_SKILLS];

if (process.argv.includes('-full')) {
  console.warn('Note: -full is no longer needed; parallel, codebase and security reviews were removed from the pack.');
}

// All directories managed by this installer (runner + skills)
// INSTALL_DIRS: dirs in staging to swap in. CLEANUP_DIRS: removed skills to delete from earlier installs.
const INSTALL_DIRS = ['codex-review', ...SKILLS];
const CLEANUP_DIRS = REMOVED_SKILLS;

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

// ---------------------------------------------------------------------------
// Build staging directory
// ---------------------------------------------------------------------------

const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stagingDir = path.join(skillsRoot, `.codex-staging-${uid}`);

try {
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1. Copy codex-runner.js into staging/codex-review/scripts/
  const runnerSrc = path.join(skillPackDir, 'scripts', 'codex-runner.js');
  const runnerDest = path.join(stagingDir, 'codex-review', 'scripts', 'codex-runner.js');
  fs.mkdirSync(path.dirname(runnerDest), { recursive: true });
  fs.copyFileSync(runnerSrc, runnerDest);
  // Runner modules imported by codex-runner.js
  copyDirSync(path.join(skillPackDir, 'scripts', 'lib'), path.join(path.dirname(runnerDest), 'lib'));

  // Ensure ESM works on Node 22 even if --experimental-detect-module is disabled
  fs.writeFileSync(path.join(stagingDir, 'codex-review', 'package.json'), '{"type":"module"}\n', 'utf8');

  // chmod +x on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(runnerDest, 0o755);
  }

  // 2. Process each skill: render SKILL.md, copy references/
  const escapedRunnerPath = escapeForDoubleQuotedShell(runnerPath);
  const escapedSkillsRoot = escapeForDoubleQuotedShell(skillsRoot);

  for (const skill of SKILLS) {
    const skillSrcDir = path.join(skillPackDir, 'skills', skill);
    const skillDestDir = path.join(stagingDir, skill);
    fs.mkdirSync(skillDestDir, { recursive: true });

    if (PLAIN_SKILLS.includes(skill)) {
      const rendered = renderSkillTemplate(skillPackDir, skill, { client: 'claude' });
      fs.writeFileSync(path.join(skillDestDir, 'SKILL.md'), rendered, 'utf8');
      continue;
    }
    // Inline the shared protocol and inject runner path and skills dir
    const rendered = renderSkillTemplate(skillPackDir, skill, {
      runnerPath: escapedRunnerPath,
      skillsDir: escapedSkillsRoot,
    });
    fs.writeFileSync(path.join(skillDestDir, 'SKILL.md'), rendered, 'utf8');

    // Copy references/ (prompt templates and output formats the runner renders)
    const refsSrc = path.join(skillSrcDir, 'references');
    if (!fs.existsSync(refsSrc)) {
      throw new Error(`Missing references/ directory for ${skill}`);
    }
    copyDirSync(refsSrc, path.join(skillDestDir, 'references'));
  }

  // 3. Verify runner works
  console.log('Verifying codex-runner.js ...');
  const runnerTestPath = path.join(stagingDir, 'codex-review', 'scripts', 'codex-runner.js');
  const versionOutput = execFileSync(process.execPath, [runnerTestPath, 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  console.log(`  codex-runner.js version: ${versionOutput}`);

  // Check Codex CLI availability (warning only)
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, ['codex'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    console.warn('');
    console.warn('⚠️  Warning: codex CLI not found in PATH.');
    console.warn('   Skills require the Codex CLI to run.');
    console.warn('   Install: npm install -g @openai/codex');
  }

  // 4. Atomic swap per directory: backup old → move staging → cleanup
  fs.mkdirSync(skillsRoot, { recursive: true });
  const backups = [];    // dirs that had a previous install → backed up
  const swapped = [];    // dirs successfully moved from staging → target
  try {
    for (const dir of INSTALL_DIRS) {
      const target = path.join(skillsRoot, dir);
      const staged = path.join(stagingDir, dir);
      if (fs.existsSync(target)) {
        const backup = path.join(skillsRoot, `.${dir}-backup-${uid}`);
        fs.renameSync(target, backup);
        backups.push({ dir, target, backup });
      }
      fs.renameSync(staged, target);
      swapped.push({ dir, target });
    }
  } catch (err) {
    // Swap failed → full rollback: remove new targets, restore backups
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

  // Cleanup backups and empty staging dir (non-critical — install already succeeded)
  for (const { backup } of backups) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      console.warn(`Warning: could not remove backup at ${backup}`);
    }
  }
  // Remove skills that are no longer part of the pack
  for (const dir of CLEANUP_DIRS) {
    const target = path.join(skillsRoot, dir);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        console.warn(`Warning: could not remove old skill at ${target}`);
      }
    }
  }
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // staging dir may already be gone
  }

  // 5. Success message
  console.log('');
  console.log('codex-review skills installed successfully!');
  console.log(`  Runner:  ${runnerDir}`);
  console.log(`  Skills:  ${SKILLS.map(s => s.replace('codex-', '')).join(', ')}`);
  console.log('');
  console.log('Skills available in Claude Code:');
  console.log('  /loop-plan             — write a phased, code-grounded implementation plan');
  console.log('  /loop-implement        — execute an approved loop plan phase by phase');
  console.log('  /codex-plan-review     — debate plans before implementation');
  console.log('  /codex-impl-review     — review uncommitted or branch changes');
  console.log('  /codex-think-about     — peer reasoning/debate');
  console.log('  /codex-commit-review   — review committed code before push');
  console.log('  /codex-pr-review       — review PRs (branch diff + description)');

  // --auto: inject review guidance into global ~/.claude/CLAUDE.md
  if (autoMode) {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      const START_MARKER = '<!-- codex-auto-review-start -->';
      const END_MARKER = '<!-- codex-auto-review-end -->';

      const guidanceBlock = [
        START_MARKER,
        '',
        '## Codex Review — Auto-review Guidance',
        '',
        'When the user is working on code changes, **proactively suggest** the appropriate codex-review skill based on context:',
        '',
        '| Context | Suggested Skill | Trigger | Note |',
        '|---------|----------------|---------|------|',
        '| Multi-step feature or change that needs a plan | `/loop-plan` | Before coding | |',
        '| Approved loop plan with incomplete phases | `/loop-implement` | After the plan is approved | |',
        '| Uncommitted changes (staged/unstaged) | `/codex-impl-review` | Before committing | |',
        '| Feature branch with commits | `/codex-pr-review` | Before creating/merging PR | |',
        '| Plan/design document created or modified | `/codex-plan-review` | After writing plan | |',
        '| Recent commits before push | `/codex-commit-review` | After committing, before push | |',
        '| Technical question or architecture debate | `/codex-think-about` | On design discussions | |',
        '',
        '**Rules:**',
        '- Always ask the user before running a review skill — never auto-run without confirmation',
        '- Phrase as a suggestion: "Would you like me to run `/codex-impl-review` before committing?"',
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

      const startIdx = existing.indexOf(START_MARKER);
      const endIdx = existing.indexOf(END_MARKER);

      let updated;
      if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        // Replace existing block (idempotent)
        updated = existing.slice(0, startIdx) + guidanceBlock + existing.slice(endIdx + END_MARKER.length);
      } else if (startIdx !== -1 || endIdx !== -1) {
        // Partial/corrupt markers — warn and skip to avoid data corruption
        throw new Error('Found partial codex-auto-review markers in ~/.claude/CLAUDE.md — remove them manually and re-run');
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
    console.log('Optional: npx github:lploc94/codex_skill --auto');
    console.log('  Injects review guidance into ~/.claude/CLAUDE.md');
  }
} catch (err) {
  // Cleanup staging on any error
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  console.error(err.message || err);
  process.exit(1);
}
