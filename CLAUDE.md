# CLAUDE.md

This repository provides a single-command installer (`npx github:lploc94/codex_skill`) that installs the `codex-review` skill pack into `~/.claude/skills/codex-review/`.

## Project Overview

`codex-review` provides seven skills: five powered by OpenAI Codex CLI and two plain planning/execution skills:
- `/loop-plan` — write a phased, code-grounded implementation plan (`loop-plan/v1`)
- `/loop-implement` — execute an approved loop plan phase by phase with TDD, reviews, and commits
- `/codex-plan-review` — debate plans before implementation
- `/codex-impl-review` — review uncommitted or branch changes before commit/merge
- `/codex-think-about` — peer reasoning/debate on technical topics
- `/codex-commit-review` — review committed code quality before push (report + suggest)
- `/codex-pr-review` — review PRs (branch diff, commit hygiene, description)

`/codex-parallel-review`, `/codex-codebase-review`, and `/codex-security-review` were removed; the installer deletes previously installed copies.


## Distribution Model

- Single command install: `npx github:lploc94/codex_skill`
- Installs to: `~/.claude/skills/codex-review/`
- No global npm install, no CLI left behind, no node_modules on user machine

## Requirements

- Node.js >= 22
- Claude Code CLI
- OpenAI Codex CLI in PATH (`codex`)
- OpenAI API key configured for Codex

## Development Commands

```bash
node ./bin/codex-skill.js                                          # run installer locally
node ./bin/codex-skill.js --auto                                   # install + inject guidance into ~/.claude/CLAUDE.md
node skill-packs/codex-review/scripts/codex-runner.js version      # runner version
```

There is no build system, test suite, or linter. The project is JavaScript + Markdown + JSON.

## Architecture

### Installer

`bin/codex-skill.js` — single file, Node.js stdlib only, no dependencies:
1. Parse CLI arguments (`--auto`; `-full` is accepted but only prints a notice)
2. Runtime guard: Node.js >= 22
3. Build staging directory alongside install target
4. Copy `codex-runner.js` from `skill-packs/`
5. Runner skills (`codex-*`): read SKILL.md templates (contain `{{RUNNER_PATH}}`), inject absolute path, write to staging, copy `references/` and `shared/` files. Plain skills (`loop-plan`, `loop-implement`): copy SKILL.md as-is
6. Verify runner by spawning `node codex-runner.js version`
7. Atomic swap: backup old install → rename staging → cleanup; delete installed copies of removed skills
8. If `--auto`: inject review guidance into `~/.claude/CLAUDE.md` (idempotent, append-only)

### Skill Pack Layout (templates + runner)

```text
skill-packs/codex-review/
├── manifest.json
├── scripts/
│   └── codex-runner.js          ← single shared Node.js runner
└── skills/
    ├── codex-plan-review/
    │   ├── SKILL.md             ← template with {{RUNNER_PATH}}
    │   └── references/
    ├── codex-impl-review/
    │   ├── SKILL.md
    │   └── references/
    ├── codex-think-about/
    │   ├── SKILL.md
    │   └── references/
    ├── codex-commit-review/
    │   ├── SKILL.md
    │   └── references/
    ├── codex-pr-review/
    │   ├── SKILL.md
    │   └── references/
    ├── loop-plan/
    │   └── SKILL.md             ← plain skill, no runner, copied as-is
    └── loop-implement/
        └── SKILL.md
```

### Installed Output (on user machine)

```text
~/.claude/skills/
├── codex-review/
│   └── scripts/
│       └── codex-runner.js              ← shared runner
├── codex-plan-review/
│   ├── SKILL.md                         ← RUNNER="/abs/path/codex-runner.js" hardcoded
│   └── references/
├── codex-impl-review/
│   ├── SKILL.md
│   └── references/
├── codex-think-about/
│   ├── SKILL.md
│   └── references/
├── codex-commit-review/
│   ├── SKILL.md
│   └── references/
├── codex-pr-review/
│   ├── SKILL.md
│   └── references/
├── loop-plan/
│   └── SKILL.md
└── loop-implement/
    └── SKILL.md
```

### Core Execution Flow

1. **Skill invocation** (`/codex-plan-review`, `/codex-impl-review`, `/codex-think-about`, `/codex-commit-review`, or `/codex-pr-review`) follows SKILL.md step-by-step. `/loop-plan` and `/loop-implement` do not use the runner
2. **Runner path**: SKILL.md contains hardcoded absolute path to `codex-runner.js`
3. **Prompt rendering**: SKILL.md calls `render --skill X --template Y --skills-dir $SKILLS_DIR` with JSON vars on stdin → receives rendered prompt on stdout
4. **Session lifecycle**: `init` → `start` (stdin prompt) → `poll` (JSON response) → `resume` (stdin prompt) → `poll` → ... → `finalize` → `stop` for a normal terminal outcome; a qualifying runner-deadline timeout preserves the same session for later `stop` → `resume`, while all other timeout/error paths use `stop` only and preserve the unfinalized session
5. **codex-runner.js** spawns `codex exec --json --sandbox read-only` as a detached process, polls JSONL output, parses markdown into structured JSON
6. **Review debate loop** (plan-review, impl-review, commit-review, pr-review): Claude reads `poll` JSON → `review.blocks[].id` ISSUE-{N} → fixes/rebuts → `render` rebuttal → `resume` → repeats until `APPROVE` or stalemate
7. **Peer debate loop** (think-about): Claude and Codex think independently → compare JSON responses → exchange perspectives → repeat until consensus or stalemate → present to user
8. **All state managed by runner**: Claude NEVER writes directly to session dir. `rounds.json`, `meta.json`, `prompt.txt`, JSONL archival all handled by runner commands.

### Key Design Decisions

- **Node.js runner**: `codex-runner.js` uses Node.js stdlib only — no Python/bash dependency
- **Cross-platform**: Works on Windows, macOS, and Linux
- **JSON-only output**: All commands return structured JSON (except `version`, `init`, `render`). No text protocol parsing needed.
- **Built-in output parsers**: Runner parses Codex markdown into structured blocks (ISSUE, CROSS, RESPONSE, think-about format) with variant detection
- **Prompt template engine**: `render` command reads `prompts.md`, resolves placeholders, auto-injects output format
- **Prompt minimalism**: Prompts contain only file paths and context; Codex reads files/diffs itself
- **Structured output**: Review skills use `ISSUE-{N}` format with `VERDICT` block; think-about uses Key Insights / Considerations / Recommendations
- **Thread persistence**: `init` creates a session; `start` begins round 1; `resume` continues with auto thread_id lookup
- **Review timeout**: The runner defaults to 18,000 seconds (5 hours) so long-running exhaustive reviews can finish while Codex is still making progress; callers may still pass `--timeout` for bounded tests or deliberately shorter runs
- **Timeout recovery metadata**: A timeout is resumable only when poll JSON reports `timeout_reason: "runner_deadline"`, `recoverable: true`, a non-empty `thread_id`, and `progress_observed: true`; `turn.failed`, process/runner errors, missing or invalid state/thread context, `CODEX_NOT_FOUND`, and stalled results are stop-only
- **ABSOLUTE USER AUTHORITY**: For review-operation decisions, the user's latest explicit instruction is final, binding, and absolute. It overrides default skill rules, the shared protocol, loop rules, and Codex findings/recommendations. Follow a clear user decision exactly; never resist, reinterpret, delay, or refuse it by citing a protocol or rule. Ask only when genuinely ambiguous. This does not override higher-priority system/developer instructions or authorize an unrequested product behavior, API, schema, persistence, or compatibility change
- **Stalemate detection**: Stops if same points repeat for 2 consecutive rounds with no progress
- **PID-reuse protection**: `verifyCodex()` and `verifyWatchdog()` check process cmdline before killing — prevents killing wrong process if OS reuses the PID
- **Atomic install**: Uses staging dir + rename for safe install/update with rollback on failure

### codex-runner.js Commands (v13)

| Command | Input | Output |
|---------|-------|--------|
| `version` | (none) | Plain text: `13` |
| `init --skill-name X --working-dir Y` | (none) | Plain text: `CODEX_SESSION:/path` |
| `start <session_dir> [--model <name>] [--effort] [--timeout] [--sandbox]` | Prompt on stdin | JSON: `{ status, session_dir, round }` |
| `resume <session_dir> [--model <name>] [--effort] [--timeout]` | Prompt on stdin | JSON: `{ status, session_dir, round, thread_id }` |
| `poll <session_dir>` | (none) | JSON: `{ status, round, elapsed_seconds, review, activities, recovery metadata when terminal }` |
| `stop <session_dir>` | (none) | JSON: `{ status: "stopped", session_dir }` |
| `finalize <session_dir>` | Override JSON on stdin | JSON: `{ status: "finalized", meta }` |
| `status <session_dir>` | (none) | JSON: `{ status, session_id, rounds, ... }` |
| `render --skill X --template Y --skills-dir Z` | Placeholder JSON on stdin | Plain text: rendered prompt |

`--model <name>` forwards the exact model name to Codex CLI. Omit it to keep CLI default selection. The runner does not persist this override; pass it on every `resume`, including recovery, to explicitly keep the selected model.

### codex-runner.js Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Runner deadline timeout (default 18000s / 5h); recoverability is determined by poll metadata |
| 3 | Turn failed |
| 4 | Stalled (no output for ~3 minutes) |
| 5 | Codex CLI not found in PATH |

## Design Principles

- Progressive disclosure: keep `SKILL.md` lean (~40–70 lines).
- Move long prompts/protocol details into `references/`.
- Single shared runner at skill-pack level, not duplicated per skill.
- `skill-packs/` is the single source of truth for templates and runner.

## Breaking Changes

### v10: review.txt → review.md
- **Output file renamed**: `review.txt` is no longer created. All markdown review output is now written to `review.md`.
- **format="both" simplified**: Previously wrote `review.txt` + `review.json` + `review.sarif.json` + `review.md` (re-rendered from JSON). Now writes `review.md` (original markdown) + `review.json` + `review.sarif.json`. The re-rendered markdown is removed since `review.md` is the primary output.
- **CI/CD impact**: Any scripts referencing `review.txt` must be updated to use `review.md`.
- **Existing state directories**: Old runs in `.codex-review/runs/*/` may still contain `review.txt` from v9. These are not retroactively renamed.
- **Historical docs**: SESSION_SUMMARY.md, PROGRESS_REPORT.md, FINAL_REPORT.md reference v9 behavior and are not updated.
- See v11 — format options fully removed.

### v11: Remove JSON/SARIF output formats
- **`--format` flag removed**: Runner only produces markdown. `review.md` is the sole output.
- **Files no longer generated**: `review.json`, `review.sarif.json`
- **Test files deleted**: `test-converters.js`, `test-converters-comprehensive.js`, `test-integration.js`
- **Schema doc deleted**: `docs/CANONICAL_JSON_SCHEMA.md`

### v12: Unified session directories (runs/ → sessions/)
- **New runner commands**: `init` (creates session dir), `resume` (round 2+ with auto thread_id).
- **`start` changed**: Now takes session dir as positional arg (from `init`), no longer creates dir.
- **`poll` enhanced**: Adds `SUMMARY:` line to stdout with activity summary. Claude no longer needs to parse stderr for reporting.
- **Run directories removed**: `.codex-review/runs/` no longer created. All state lives in `.codex-review/sessions/{skill}-{yyyymmdd}-{NNN}/`.
- **Session naming**: Human-readable `{skill}-{yyyymmdd}-{NNN}` (e.g., `codex-plan-review-20260321-001`).
- **`stop` no longer deletes**: Session dir persists. All files retained for debugging.
- **state.json**: `run_id` → `session_id`.
- **New files**: `rounds.json` (round history), `meta.json` written to session dir.
- **Backward compat**: `poll`/`stop` accept both old `runs/` and new `sessions/` paths. Legacy removed in v13.

### v13: Runner-centric architecture (JSON-only, no backward compat)
- **All commands output JSON** (except `version`, `init`, `render`): `start`, `resume`, `poll`, `stop`, `finalize`, `status` return structured JSON on stdout.
- **Text protocol removed**: `POLL:status:elapsed:...` text format is gone. `poll` returns `{ status, round, elapsed_seconds, review, activities }` JSON.
- **New commands**: `finalize` (writes `meta.json`), `status` (read-only query), `render` (prompt template engine).
- **Runner manages all state**: Claude Code NEVER writes directly to session dir. All writes go through runner commands.
- **Round tracking auto-managed**: Runner creates/updates `rounds.json` automatically in `start`, `resume`, `poll`, `stop`.
- **Output parsing built-in**: Runner parses Codex markdown output into structured JSON (ISSUE blocks, VERDICT, etc.) — returned in `poll` response.
- **Prompt template engine** (`render`): Runner reads `references/prompts.md`, resolves `{PLACEHOLDER}` from stdin JSON, auto-injects `{OUTPUT_FORMAT}` and `{CLAUDE_ANALYSIS_FORMAT}`.
- **`init` creates subdirectories**: `prompts/` and `outputs/` created at init time for round-level archival.
- **`start`/`resume` read prompt from stdin**: Prompt piped via stdin, runner writes `prompt.txt` + archives to `prompts/round-NNN.txt`.
- **`resume` archives prior artifacts**: Previous `output.jsonl`, partial `review.md`, and the cached terminal result `final.txt` are copied into round-specific files under `outputs/` before the new round clears active artifacts.
- **`finalize` replaces manual meta.json**: Aggregates timing from `rounds.json`, accepts verdict override via stdin JSON.
- **`status` is read-only**: Reports session state without side effects.
- **`stop` outputs JSON**: `{ status: "stopped", session_dir }` instead of silent exit.
- **SKILL.md simplified**: ~40-60% less boilerplate. No file I/O instructions for session files. Workflow references updated to use JSON poll parsing.
- **Installer updated**: Now injects `{{SKILLS_DIR}}` placeholder alongside `{{RUNNER_PATH}}` for `render --skills-dir`.
- **No backward compat with v12**: Text protocol, `CODEX_STARTED:` output, manual `prompt.txt` writing, manual `rounds.json` management — all removed.
- **manifest.json**: version `7.0.0` (major breaking)

## Verification

1. `node bin/codex-skill.js` — installer chạy thành công
2. `node skill-packs/codex-review/scripts/codex-runner.js version` — in version `13`
3. `ls ~/.claude/skills/codex-review/` — chứa `scripts/`
4. SKILL.md chứa absolute path, không search loop
5. Invoke `/loop-plan`, `/loop-implement`, `/codex-plan-review`, `/codex-impl-review`, `/codex-think-about`, `/codex-commit-review`, `/codex-pr-review` trong Claude Code

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **codex_skill**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/codex_skill/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/codex_skill/context` | Codebase overview, check index freshness |
| `gitnexus://repo/codex_skill/clusters` | All functional areas |
| `gitnexus://repo/codex_skill/processes` | All execution flows |
| `gitnexus://repo/codex_skill/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
