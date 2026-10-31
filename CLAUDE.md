# CLAUDE.md

This repository provides a single-command installer (`npx @tlelabs/cross-review`, npm package `@tlelabs/cross-review`) that installs the `cross-review` skill pack for Claude Code (`~/.claude/skills/`), Codex (`~/.agents/skills/`), and Antigravity (`~/.gemini/config/plugins/cross-review/`), and registers its MCP server with all three clients.

## Project Overview

`cross-review` provides six skills: four review skills, where a second model (the reviewer: Codex CLI by default, or Claude Code or Antigravity) reviews the orchestrator's work under a compiled 3-layer Principal Reviewer system prompt, and two plain planning/execution skills (Claude Code & Antigravity: `/name`, Codex: `$name`):
- `loop-plan` — write a phased, code-grounded implementation plan (`loop-plan/v1`) into `<workspace>/.cross-review/plans/`
- `loop-implement` — execute an approved loop plan phase by phase with TDD, checkpoint reviews, and commits
- `review-plan` — debate plans before implementation
- `review-impl` — review uncommitted changes, unpushed commits, or a branch before commit/push/merge
- `review-think` — peer reasoning/debate on technical topics
- `review-pr` — review someone else's PR as a peer (correctness, description, merge readiness); your own PR goes through `review-impl`

The project was called `codex-review` (repo `lploc94/codex_skill`, skills `codex-*-review`, `codex-think-about`); the installer removes that pack's skills, runtime and MCP registration.

## Distribution Model

- Single command install: `npx @tlelabs/cross-review` (npm); `npx github:lploc94/cross-review` installs the default branch
- One version number: `package.json` `version` equals `skill-packs/cross-review/manifest.json` `version` (a test checks it); `files` leaves out `skill-packs/cross-review/node_modules`
- Installs to `~/.claude/skills/` (skills + shared runtime in `cross-review/`), `~/.agents/skills/` (Codex copies), and `~/.gemini/config/plugins/cross-review/` (Antigravity plugin: `plugin.json`, 6 skills, 4 reviewer agents `cross-reviewer-review-{impl,plan,pr,think}.md`, enabled in `~/.gemini/config/config.json`)
- Runtime dependencies (`@modelcontextprotocol/sdk`, `zod`) are installed with `npm ci --omit=dev` from the committed lock file into `~/.claude/skills/cross-review/node_modules`
- Removes this pack's old copies from Codex's deprecated `$CODEX_HOME/skills`; foreign skills there are left in place

## Requirements

- Node.js >= 22 and npm
- Claude Code CLI, Codex CLI, and/or Antigravity CLI (`agy`)
- At least one reviewer CLI in PATH: `codex` (the default reviewer), `claude` or `agy` (Antigravity)
- Windows: the reviewer CLIs as an `.exe` or an npm `.cmd` shim; the `cross-review` command runs in PowerShell 7, cmd and Git Bash

## Development Commands

```bash
npm ci --prefix skill-packs/cross-review                          # MCP SDK for tests and the MCP server
node skill-packs/cross-review/scripts/build-prompts.js             # compile the 3-layer reviewer system prompts
node test-default-timeout.js && node test-stall-recovery.js && node test-timeout-resume.js && node --test "tests/*.test.js"
H=$(mktemp -d) && HOME="$H" USERPROFILE="$H" CODEX_HOME="$H/.codex" node bin/cross-review.js && node tests/install-check.mjs "$H" && rm -rf "$H"
node skill-packs/cross-review/scripts/review-runner.js version     # runner version
node tests/dashboard-ui.mjs                                         # dashboard in headless Chrome (CHROME=<path>)
node docs/screenshots.mjs                                           # README pictures (docs/images/) from the invented fixture, in OFL fonts (video/fonts.mjs)
node demo/build.mjs <dir>                                           # landing page's dashboard demo: real UI + recorded invented data (demo/story.mjs)
node video/build.mjs                                                # landing page's promo video (video/out/; needs ffmpeg and Chrome)
node skill-packs/cross-review/scripts/review-runner.js dashboard --root <temp fixture dir>   # dashboard by hand
```

Never test the installer against the real HOME; use a temporary `HOME` and `CODEX_HOME` (on Windows also `USERPROFILE`, which `os.homedir()` reads, and `npm_config_prefix`, where the command goes). Tests that start a review or the dashboard also set a temporary `HOME` (and `USERPROFILE`), so they never read or write the real `~/.cross-review/` (settings, avatars, `dashboard.json`). Run the dashboard in tests and screenshots with `--root` on a temp fixture dir; fixtures and screenshots use invented data only.

## Architecture

### Installer

`bin/cross-review.js` with `bin/lib/render-skill.js`:
1. Runtime guard: Node.js >= 22; `--auto` adds/refreshes a block in `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` that runs `review-plan`/`review-impl` automatically after any plan/implementation; `-full` only prints a notice
2. Stage the shared runtime (runner, `lib/`, `mcp-server.js`, `build-prompts.js`, `prompts/`, `package.json`, lock), recompile `prompts/compiled/*.compiled.md`, and run `npm ci --omit=dev` in it
3. Render every SKILL.md template for `claude`, `codex`, and `agy`. Review skills get `{{PROTOCOL_CORE}}`, `{{PROTOCOL_VARIANT}}` (from `shared/protocol/`) and `{{RUNNER_PATH}}`; loop skills get `{{CLIENT_*}}` values per client (`claude`, `codex`, `agy`) and `{{RUNNER_PATH}}` (for the `plans` command). Stage the Antigravity plugin (`plugin.json`, `skills/`, and `agents/cross-reviewer-review-{impl,plan,pr,think}.md`). Any leftover `{{` fails the install
4. Verify the runner (`node review-runner.js version`)
5. Atomic swap across all three roots (`~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/plugins`) with full rollback; enable `cross-review` in `~/.gemini/config/config.json`; delete the old `codex-review` pack (runtime and skills, ownership checked) and this pack's copies in `$CODEX_HOME/skills`
6. Remove the old `codex-review` MCP registration when it points at that pack's runtime, then register MCP server `cross-review` (Claude: `claude mcp remove` + `add -s user`, `REVIEW_WAIT_DEFAULT_S=270`; Codex: `codex mcp add`, `REVIEW_WAIT_DEFAULT_S=270` and `tool_timeout_sec = 300`; Antigravity: `~/.gemini/config/mcp_config.json` with `REVIEW_WAIT_DEFAULT_S=270`). Skipped with a warning when `npm ci` failed. CLI calls never use a shell: `lib/command.js` `resolveSpawn` runs an npm `.cmd` shim on Windows as node + script or as its `.exe`, and only a batch file that is not a shim (`npm.cmd`) through `cmd.exe /d /s /c`
7. Write the `cross-review` command, each file atomically with a marker line. POSIX: `~/.local/bin/cross-review` (`#!/bin/sh` + marker + `exec <node> <installed runner> "$@"`). Windows: `cross-review.cmd`, `cross-review.ps1` and `cross-review` (sh, for Git Bash) in `npm prefix -g` (`%APPDATA%\npm`, which npm keeps on PATH), each judged on its own; the `.cmd` names paths in the profile through `%USERPROFILE%`, since cmd.exe reads batch files in the console code page, not UTF-8. A file there without the marker, or a link, is left in place with a note; a command folder missing from `PATH` is reported. Failures only warn

### Skill Pack Layout

```text
skill-packs/cross-review/
├── manifest.json
├── package.json, package-lock.json   ← runtime dependencies (MCP server only)
├── prompts/
│   ├── production-reviewer-base.md   ← Layer 1: core reviewer methodology, 6 system taxonomies, Anti-Dogma
│   ├── reviewer-system.md            ← Layer 1 + Layer 2 standalone prompt (Layer 2: always-on recon and spike tactics)
│   ├── skills/                       ← Layer 3: review-{impl,plan,pr,think}.system.md rubrics
│   └── compiled/                     ← compiled 3-layer prompts: review-{impl,plan,pr,think}.compiled.md
├── shared/protocol/                  ← core.md, apply-rebut.md, cross-analysis.md (inlined at install)
├── scripts/
│   ├── review-runner.js               ← runner CLI (stdlib only)
│   ├── mcp-server.js                 ← MCP stdio server: review_begin/wait/reply/end
│   ├── build-prompts.js              ← compiles 3-layer reviewer prompts (stdlib only)
│   └── lib/                          ← parse.js, review-core.js (the four verbs), config.js (review and plan settings), plans.js (plans and the `plans` command), command.js (find and start a CLI without a shell), reviewers/ (one adapter per reviewer CLI)
│       └── dashboard/                ← server.js (node:http, SSE), scan.js, model.js, follow.js, avatars.js, discovery.js, ui/ (static page, no build)
└── skills/
    ├── review-plan/, review-impl/, review-think/, review-pr/
    │   ├── SKILL.md                  ← template
    │   └── references/               ← prompts.md, output-format.md, analysis templates
    └── loop-plan/, loop-implement/
        ├── SKILL.md                  ← three-client template (claude, codex, agy)
        └── agents/openai.yaml        ← Codex UI metadata
```

### Installed Output

```text
~/.claude/skills/
├── cross-review/        ← runtime: scripts/, prompts/, node_modules/, package.json (shared by all clients)
├── review-*/            ← SKILL.md (rendered) + references/
└── loop-plan/, loop-implement/
~/.agents/skills/
├── review-*/            ← SKILL.md only; points at the shared runtime
└── loop-plan/, loop-implement/   ← SKILL.md + agents/openai.yaml
~/.gemini/config/
├── config.json          ← plugins["cross-review"].enabled = true
├── mcp_config.json      ← mcpServers["cross-review"]
└── plugins/cross-review/
    ├── plugin.json
    ├── skills/          ← 6 rendered SKILL.md files (review-*, loop-plan, loop-implement)
    └── agents/          ← 4 reviewer agents: cross-reviewer-review-{impl,plan,pr,think}.md
~/.local/bin/cross-review  ← runs the installed runner: `cross-review dashboard`, `cross-review version`, …
%APPDATA%\npm\cross-review.cmd, cross-review.ps1, cross-review   ← the same on Windows (npm's global folder)
```

### Core Execution Flow

1. A review skill calls `review_begin` (MCP) or `review-runner.js begin` (CLI fallback) with the skill, mode, optional reviewer, model and effort, and a markdown input of placeholder values. Values not given come from the review settings (see Review settings)
2. `begin` renders round 1 from `references/prompts.md`, resolves the compiled 3-layer system prompt (`prompts/compiled/<skill>.compiled.md`), starts the reviewer detached (Codex: `codex exec --json --sandbox danger-full-access --config model_instructions_file=... --config web_search="live"` plus bloat-disable flags; Claude Code: `claude -p --output-format stream-json --verbose --disallowedTools ReportFindings --system-prompt-file ... --disable-slash-commands --dangerously-skip-permissions`; agy: `agy --input-format stream-json --output-format stream-json --agent cross-reviewer-<skill> --disable-slash-commands --dangerously-skip-permissions --print=`), and returns `session_dir` (peer skills also get `analysis_prompt`)
3. `wait` polls until the round ends and returns `next`: `running`, `respond`, `cross_check`, `done`, `ask_user`, or `stopped`
4. The orchestrator fixes/rebuts (`respond`, plan/impl) or compares its own analysis (`cross_check`, peer skills), then calls `reply`; the runner renders the right reply template and resumes the same reviewer thread with the stored reviewer, model, effort and sandbox
5. `end` finalizes (`meta.json`), stops, and records `ended_at` and `end_outcome` (`finalized` | `stopped`) in `state.json`; a later `reply` clears them. Session state lives in `.cross-review/sessions/<skill>-<yyyymmdd>-<NNN>/`; the runner writes `.cross-review/.gitignore` (`*`)

Besides the prompts and outputs, a session keeps what the dashboard needs to retell it: `inputs/round-NNN.md` (each round's input as received), `outputs/times-round-NNN.jsonl` (`[complete lines, epoch s]` rows stamping the reviewer's event log), `state.caller` (`{name, title?, version?}` from the MCP client's `clientInfo`; the CLI records none), and `state.settings_sources` (where reviewer, model, effort and `open_dashboard` came from).

### Review settings

`lib/config.js` reads `~/.cross-review/config.json` (global) and `<working_dir>/.cross-review/config.json` (workspace): `{reviewer?, open_dashboard?, check_updates?, track_plans?, open_plans?, reviewers?: {codex?|claude?|agy?: {model?, effort?, skills?: {<skill>: {model?, effort?}}}}}`; unknown keys and reviewer names are errors, and an effort outside a reviewer's fixed levels (Claude Code) is one. Top-level `model`, `effort` and `skills` are the older form of `reviewers.codex`: `readConfig` and `writeConfig` move them there (`normalizeConfig`; a field already in `reviewers.codex` wins), so a file is rewritten in the new form only when something saves it. The reviewer resolves first: requested (`review_begin`/`--reviewer`) · workspace · global · `codex`. Its model and effort then resolve key by key through `reviewers.<that reviewer>`, first match wins: requested (`--model`/`--effort`) · `workspace:<skill>` · `workspace` · `global:<skill>` · `global` · default (the reviewer's own model, effort `high`); another reviewer's entries are never read. Before anything starts, the adapter's `checkSelection` refuses a model or effort the reviewer cannot run (`INVALID_SELECTION`). `open_dashboard` reads workspace then global, default `false`. A broken file fails `begin` with `CONFIG_INVALID` before any session is created. Two plan settings sit in the same files, global and workspace only (`resolvePlanSettings`; workspace, then global, default `false`): `track_plans` (Plans in git) and `open_plans` (Follow plans). With `open_dashboard: true`, `begin` opens the session in the dashboard (`lib/dashboard/follow.js`: reuse the running one from `~/.cross-review/dashboard.json`, else start one with `--idle-exit 1800`) and returns `dashboard_url` or `dashboard_error`; it never fails because of it.

### Plans

`lib/plans.js` owns plans: `loop-plan` writes `<workspace>/.cross-review/plans/<name>-plan.md`, and the runner's `plans` command creates that folder, keeps `.cross-review/.gitignore` in step with `track_plans` (`*` or `*` + `!plans/` + `!plans/**`; a hand-edited file is left alone and reported as `custom`), and prints each plan's summary. A `.md` file with `## Plan schema` `loop-plan/v1` is a plan (`format: "loop-plan"`: phases, criteria ticked `- [x]` by `loop-implement`, Plan Review, Progress Log); any other `.md` file there is `format: "markdown"`, shown as a plain document. Whether git keeps a plan comes from `git check-ignore` (never the setting); a root `.gitignore` rule that still ignores new plans is reported as `blocked_by` with a `warning`. A phase's commit SHA is the one commit in the last 2000 whose subject is the phase's planned message. `loop-implement` stages the plan only when `git check-ignore -q` exits 1. `--finished <file>` with `open_plans` on opens the plan's Plan tab through `lib/dashboard/follow.js`.

### Dashboard

`review-runner.js dashboard` (or `cross-review dashboard`, or `npx @tlelabs/cross-review dashboard`) serves a local page on `127.0.0.1` (random port 20000–30000, per-run token in cookie or Bearer, Host check, Origin check on writes). It scans `--root` (default cwd) and 3 levels below for `.cross-review/sessions/` or `.cross-review/plans/` and only reads sessions and plans (git commands it runs are read-only); it writes `~/.cross-review/dashboard.json` (port, token, pid), the settings files, `.cross-review/.gitignore` when Plans in git is saved, avatars in `~/.cross-review/avatars/`, the model lists in `~/.cross-review/models.json` (Codex) and `models-agy.json` (agy), and the last update check in `~/.cross-review/update.json`. Its one network request is the update check (`lib/dashboard/update.js`: `https://registry.npmjs.org/@tlelabs/cross-review/latest`): at start when the global `check_updates` is true and the last answer is over 3 days old or failed, every 6 hours while it runs with `check_updates` on, and on Check now (`POST /api/update/check`); `/api/update` reports it (an open page asks again hourly) and the footer's Update link and a line under the version show a newer version. Sessions are grouped from their files and the clock, never by writing a status (`sessionStatus` in `lib/dashboard/model.js`): a running round is In progress; the agent's turn is In progress for `ACTIVE_WINDOW_S` (3600 s, then History as `no reply`), with a warning after `WARN_AFTER_S` (1200 s); a stopped round with a reviewer thread is In progress (`stopped, resumable`) for the same hour, then History as `stopped`; a resumed round is running again, so the session comes back. Routes are hash routes (`#/`, `#/s/<ws>/<session>[/ISSUE-N]`, `#/plans`, `#/p/<ws>/<file>[/plan]`, `#/settings[/<ws>]`); updates arrive over SSE (`/api/stream?view=list|session`). Each reviewer's model list comes from its adapter (Codex: `codex debug models`, then `--bundled`, else none; agy: `agy models` grouped into families with their effort levels; Claude Code: its fixed aliases, plus any full name under Other…), all asked at start: the list the last run saved answers `/api/settings` at once (`reviewers.<name>.modelsRefreshing: true`), `/api/models?reviewer=<name>` waits for the new one, and a failed ask keeps the saved list; only a first run with none waits. Settings writes model and effort only under `reviewers.<name>`; **Model and effort for** picks which reviewer the form edits (default: the one used at that level). The UI follows `mockups/dashboard.html`: system fonts only, Lucide icons (ISC, `ui/LICENSE-lucide.txt`), the owl mascot (`ui/avatars/reviewer.png`) as logo and tab icon, no brand logos (the footer links to GitHub in plain text).

### Key Design Decisions

- **One core, two shells**: `lib/review-core.js` implements `begin/wait/reply/end` on top of the low-level runner commands (called as a child process); the CLI verbs and the MCP server share it
- **Runner is stdlib only**; only the MCP server needs the SDK
- **Reviewer adapters**: everything specific to a reviewer CLI (command line for new and resumed turns, sandbox names, event-log parsing, process identity, model list, CLI status) lives in `scripts/lib/reviewers/<name>.js` (`codex`, `claude`, `agy`; contract in `reviewers/index.js`); optional exports: `encodePrompt` (stdin for a CLI that does not read plain text: agy takes one NDJSON user message), `efforts` (fixed levels, or null when they depend on the model), `checkSelection` (refuse a model/effort before `begin`/`reply` launch anything), `allowCustomModel`. The runner owns spawning (through `lib/command.js`, so an npm `.cmd` shim works on Windows), watchdogs, polling and state; `matchesCmdline` reads the program quote-aware and skips a node host (`"C:\Program Files\…\claude.exe"`, `node …\codex.js`). Sessions store `reviewer`; state without it means `codex`. agy's effort belongs to the model family: `agy models` lists `<family>-<level>` variants, run as `--model <family> --effort <level>`
- **No nested reviews**: the runner starts every reviewer with `CROSS_REVIEW_REVIEWER=<name>`, and `begin` inside that environment (CLI or MCP) fails with `NESTED_REVIEW`, so a reviewer that has the skills installed (Claude Code) cannot start a review of its own
- **Reviewer access**: review skills run the reviewer with its full-access sandbox (Codex: `danger-full-access`; Claude Code and agy: `--dangerously-skip-permissions`) so it can run tests, builds and network commands to verify claims; prompts forbid changing project files. The low-level `start` keeps its `read-only` default
- **Self-contained SKILL.md**: protocol text is inlined at install; no `references/protocol.md`, no flavor text
- **Built-in output parsers**: ISSUE (PR reviews add Overall Assessment), RESPONSE (older PR rounds) and think-about formats; the verdict is parsed independently of the format, including verdict-only output
- **Review timeout**: default 18,000 s (5 h); a timeout is resumable only when `poll` reports `timeout_reason: "runner_deadline"`, `recoverable: true`, a `thread_id`, and `progress_observed: true`
- **ABSOLUTE USER AUTHORITY**: for review-operation decisions the user's latest explicit instruction is final. It does not authorize unrequested product, API, schema, persistence, or compatibility changes
- **PID-reuse protection**: `verifyReviewer()` and `verifyWatchdog()` check the process cmdline before killing
- **Atomic install** with staging, rename and rollback

### review-runner.js Commands (v15)

| Command | Input | Output |
|---------|-------|--------|
| `begin --skill S [--mode M] --input <file\|-> [--working-dir D] [--model] [--effort] [--timeout] [--reviewer] [--skills-dir]` | Markdown placeholder values | JSON: `{ session_dir, round, status, analysis_prompt? }` |
| `wait <session_dir> [--max-wait <s>]` | (none) | JSON: poll result plus `next`, `next_reason` |
| `reply <session_dir> --input <file\|-> [--model] [--effort]` | Markdown placeholder values | JSON: `{ status, session_dir, round, thread_id }` |
| `end <session_dir> [--outcome consensus\|stalemate]` | (none) | JSON: `{ status: "ended", finalized, verdict }` |
| `version` | (none) | Plain text: `15` |
| `dashboard [--root D] [--port N] [--no-open] [--idle-exit S]` | (none) | Serves the dashboard; prints its link |
| `plans --working-dir D [--finished F]` | (none) | JSON: `{ dir, track_plans, gitignore, git, warning?, plans, dashboard_url?, dashboard_error? }` |
| `init --skill-name X --working-dir Y [--reviewer R]` | (none) | Plain text: `SESSION:/path` |
| `start <session_dir> [--model] [--effort] [--timeout] [--sandbox]` | Prompt on stdin | JSON: `{ status, session_dir, round }` |
| `resume <session_dir> [--model] [--effort] [--timeout]` | Prompt on stdin | JSON: `{ status, session_dir, round, thread_id }` |
| `poll <session_dir>` | (none) | JSON: `{ status, round, elapsed_seconds, review, activities, recovery metadata when terminal }` |
| `stop <session_dir>` | (none) | JSON: `{ status: "stopped", session_dir }` |
| `finalize <session_dir>` | Override JSON on stdin | JSON: `{ status: "finalized", meta }` |
| `status <session_dir>` | (none) | JSON: `{ status, session_id, rounds, ... }` |
| `render --skill X --template Y --skills-dir Z` | Placeholder JSON on stdin | Plain text: rendered prompt |

`start` and `resume --model` store the model in `state.json`; later rounds reuse the stored model, effort and sandbox.

### review-runner.js Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Runner deadline timeout (default 18000s / 5h); recoverability is determined by poll metadata |
| 3 | Turn failed |
| 4 | Stalled (no output for ~3 minutes) |
| 5 | Reviewer CLI not found in PATH (`REVIEWER_NOT_FOUND`) |

## Design Principles

- `SKILL.md` is self-contained: everything the orchestrator must follow is in it after rendering; prompt templates the runner renders stay in `references/`.
- Add a rule to a skill only with evidence that it changes behavior; process decisions the user made go in directly.
- Single shared runtime at skill-pack level, used by both clients.
- `skill-packs/` is the single source of truth for templates, runtime and prompts.

## Breaking Changes

### pack 11.1.0: Decision-Point Gate and Decision Ledger
- **Reviewer** (`production-reviewer-base.md` Section 6 items 9 and 10, the four rubrics, `output-format.md`): every regex, parser, detector, guard, allow/deny list, default, fallback, timeout, retry and numeric bound the work adds or changes needs a grounded source (real samples from the repository or environment, a cited specification, or an exhaustive/property-based test over a stated domain) and a two-sided spike (what it misses, what legitimate input it blocks or truncates). Ungrounded is at least `medium` and blocks approval (`REVISE`; for `review-pr` a blocking `ISSUE` and `Merge recommendation: request changes` with the peer status unchanged; `review-think` challenges the claim and keeps its status); a guard that blocks legitimate input or a bound that cuts valid data is `high`; a test that passes with the fix disabled is `high` (`false-assurance`; the reviewer checks it in a snapshot of the reviewed state). New categories: `naive-heuristic`, `arbitrary-bound`, `over-restrictive-guard`, `false-assurance`. `review-impl`, `review-plan` and `review-pr` outputs carry a `### Decision Ledger` table before the verdict (before `### Overall Assessment` for a PR); the ledger is advisory text the parser ignores, and it does not change the verdict rules.
- **Skills**: `loop-plan` (`Limits and decision points`: Source, Both-sided check, Failure handling), `loop-implement` (tests from the plan's grounded inputs, both-direction run of each decision point), the shared rebuttal protocol (a decision-point finding is disputed only with a rerun on grounded inputs), and `SESSION_CONTEXT` naming where real samples live. Line caps of 112 and 59 unchanged.
- **Going back to 11.0.0**: `npx @tlelabs/cross-review@11.0.0`.
- `package.json` and `manifest.json` 11.1.0.

### pack 11.0.0: 3-layer reviewer system prompts and Antigravity client install
- **3-Layer Reviewer System Prompts**: Every review skill (`review-impl`, `review-plan`, `review-pr`, `review-think`) compiles a 3-layer system prompt (`prompts/compiled/<skill>.compiled.md`) from Layer 1 (`prompts/production-reviewer-base.md`: Principal Reviewer methodology, 6 system taxonomies, Anti-Dogma lifecycle calibration, Audit-Existing-Spikes-First rule), Layer 2 (always-on recon and batched falsification-spike tactics, generated by `scripts/build-prompts.js`), and Layer 3 (`prompts/skills/<skill>.system.md`).
- **Reviewer System Prompt Override**: `review-runner.js` passes `systemPromptFile` and `skillName` into each adapter's `buildCommand`: Claude Code adds `--system-prompt-file <compiled> --disable-slash-commands`; Codex adds `--config model_instructions_file="<compiled>" --config web_search="live"` plus flags disabling interactive instructions/plugins/apps/multi-agent; Antigravity (`agy`) adds `--agent cross-reviewer-<skill> --disable-slash-commands` (provisioning global fallback agents in `~/.gemini/config/agents/` when not yet installed). Direct `buildCommand` calls without `systemPromptFile` retain their exact prior arguments.
- **Antigravity (`agy`) Client Install**: `bin/cross-review.js` and `bin/lib/render-skill.js` (`CLIENTS.agy`) atomically stage and install the `cross-review` plugin into `~/.gemini/config/plugins/cross-review/` (`plugin.json`, 6 skills, 4 reviewer agents), enable it in `~/.gemini/config/config.json`, register the MCP server in `~/.gemini/config/mcp_config.json`, and support `--auto` in `~/.gemini/GEMINI.md` alongside `~/.claude/CLAUDE.md`.
- **Going back to 10.5.1**: `npx @tlelabs/cross-review@10.5.1`, and if you want to remove the Antigravity plugin/MCP registration, delete `~/.gemini/config/plugins/cross-review` and remove `cross-review` from `~/.gemini/config/config.json` and `~/.gemini/config/mcp_config.json`.
- `package.json` and `manifest.json` 11.0.0.

### pack 10.5.1: Claude Code reviewer without ReportFindings
- **Reviewer**: Claude Code turns run with `--disallowedTools ReportFindings`. That tool hands findings to the host UI, so a reviewer that used it left a turn whose findings and verdict never reached the event log (`next: ask_user`, no verdict); it did so in 12 of 168 benchmark reviews.
- `package.json` and `manifest.json` 10.5.1.

### pack 10.5.0: Windows
- **Command**: the installer writes `cross-review.cmd`, `cross-review.ps1` and `cross-review` (sh, for Git Bash) into npm's global folder (`npm prefix -g`, usually `%APPDATA%\npm`, already on PATH), so `cross-review dashboard` works in PowerShell 7, cmd and Git Bash. Windows PowerShell 5.1 blocks `.ps1` files under its default execution policy: run `cross-review.cmd` there, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. A file of the same name without the installer's marker is left alone.
- **Reviewers on Windows**: codex, claude and agy start from an `.exe` or an npm `.cmd` shim without a shell (`lib/command.js`); the runner recognises them by their program name even under a quoted `C:\Program Files\…` path or a node host, so `stop` can kill them.
- **Installer**: no shell for CLI calls on any system (no more `DEP0190`; a node path with spaces is passed to `claude mcp add` as one argument).
- **Checkouts**: `.gitattributes` keeps LF in Windows checkouts.
- **Going back to 10.4.0**: `npx @tlelabs/cross-review@10.4.0`, then delete `cross-review.cmd`, `cross-review.ps1` and `cross-review` from `npm prefix -g` by hand; 10.4.0 does not know them.
- `package.json` and `manifest.json` 10.5.0.

### pack 10.4.0: Claude Code and Antigravity reviewers
- **Reviewers**: `reviewer` may be `codex` (default), `claude` (Claude Code) or `agy` (Antigravity), on `review_begin`/`--reviewer` or in the settings files. Review skills say so in their descriptions, and the protocol rule is now "Pass `reviewer`, `model` or `effort` only when the user names one or the plan's review checkpoint does; otherwise omit them, without asking the user which reviewer to use".
- **Settings per reviewer**: model and effort live under `reviewers.<name>` (with `skills.<skill>` inside). Top-level `model`, `effort` and `skills` are read as `reviewers.codex`; the dashboard and `writeConfig` save them there. A file nothing has saved since 10.4.0 keeps the old form and works as before.
- **Checks before start**: an effort Claude Code does not have, or one an agy model family lacks, or a model agy does not list, fails `begin`/`reply` with `INVALID_SELECTION`; `begin` inside a reviewer fails with `NESTED_REVIEW`.
- **Dashboard**: `/api/settings` returns `reviewers.<name>` (`label`, `models`, `modelsFetchedAt`, `modelsRefreshing`, `defaultModel`, `cli`, `efforts`, `allowCustomModel`), `reviewerNames` and `defaultReviewer` instead of top-level `models`/`codexDefault`/`reviewer`; `/api/models` takes `?reviewer=`; a save accepts only `reviewers.<name>.…` model and effort paths (the old ones get 400). agy's list is kept in `~/.cross-review/models-agy.json`.
- **Installer**: warns only when none of `codex`, `claude`, `agy` is in PATH; without `codex` it notes that Codex is the default.
- **Going back to 10.3.x**: in each `config.json` that 10.4.0 saved, move `reviewers.codex.model`, `.effort` and `.skills` to the top level, delete `reviewers`, and delete `reviewer` when it is `"claude"` or `"agy"` (or set it to `"codex"`); then `npx @tlelabs/cross-review@10.3.2`. Sessions run by Claude Code or agy stay readable on disk but 10.3.x cannot resume or show them correctly.
- `package.json` and `manifest.json` 10.4.0.

### pack 10.3.1: one hour in In progress
- **Dashboard**: a review waiting for the agent, or stopped with a reviewer thread, leaves In progress after one hour instead of 24 (`ACTIVE_WINDOW_S` 3600) and is listed in History as `no reply` or `stopped`; a resumed review comes back. Nothing is written to the session.

### pack 10.3.0: npm package `@tlelabs/cross-review`
- **Install** with `npx @tlelabs/cross-review` (update: `@latest`); `npx github:lploc94/cross-review` still works. The installer and Settings print the npm command.
- **One version**: `package.json` goes from `5.0.0` to the manifest's version, `10.3.0`.
- **Update check** reads the latest version on npm instead of the manifest on GitHub's `main`; its errors say npm. Installs of 10.2.0 keep reading GitHub, which stays in step.

### pack 10.2.0: plans in `.cross-review/plans/`
- **Plans move**: `loop-plan` writes new plans to `<workspace>/.cross-review/plans/` (it runs `plans --working-dir` first); `loop-implement` finds them there with the same command and never runs a plain markdown file. Plans already elsewhere stay where they are and are not shown on the dashboard; give their path to `loop-implement` to keep using them.
- **Not committed by default**: the folder is git-ignored like the rest of `.cross-review/`; `loop-implement` stages the plan only when git does not ignore it, and ticks the criteria it meets (`- [x]`) in each phase commit. `track_plans: true` (Plans in git) adds the exception.
- **Settings** `track_plans` and `open_plans`; **new command** `plans`; the dashboard scans folders that have only `.cross-review/plans/`; `manifest.json` 10.2.0.

### v15 / pack 10.1.0: dashboard and review settings
- **Settings**: `begin` reads `~/.cross-review/config.json` and `<working_dir>/.cross-review/config.json` for reviewer, model and effort when they are not passed; a broken file fails with `CONFIG_INVALID`. The protocol rule is now "Pass `model` or `effort` only when the user names one or the plan's review checkpoint does; otherwise omit them".
- **Session data**: `inputs/round-NNN.md`, `outputs/times-round-NNN.jsonl`, `state.caller`, `state.ended_at`/`end_outcome`, `state.settings_sources`; `review_begin` may return `dashboard_url` or `dashboard_error`.
- **New command** `dashboard`; `manifest.json` 10.1.0.

### v15: cross-review
- **Renamed**: project, runtime dir and MCP server `codex-review` → `cross-review`; skills `codex-plan-review`, `codex-impl-review`, `codex-commit-review`, `codex-pr-review`, `codex-think-about` → `review-plan`, `review-impl`, `review-commit`, `review-pr`, `review-think`; runner `codex-runner.js` → `review-runner.js`; session dir `.codex-review/` → `.cross-review/`; installer `bin/codex-skill.js` → `bin/cross-review.js`; `--auto` markers `codex-auto-review-*` → `cross-review-*` (old blocks are replaced).
- **Reviewer adapter**: `--reviewer` on `begin`/`init`, `reviewer` on `review_begin`, stored in `state.json` and `meta.json`.
- **Renamed codes**: `init` prints `SESSION:` (was `CODEX_SESSION:`); `CODEX_NOT_FOUND` → `REVIEWER_NOT_FOUND`; failure reason `codex_process_exit` → `reviewer_process_exit`; `next_reason` `codex_running` → `reviewer_running`; analysis templates `claude-*` → `analysis*`, `{CLAUDE_ANALYSIS_FORMAT}` → `{ANALYSIS_FORMAT}`.
- Sessions started before v15 cannot be resumed.
- **Removed `review-commit`**: `review-impl` branch mode reviews unpushed or recent commits (base `@{u}` or `HEAD~N`) and your own PR, with fixes; the installer deletes installed `review-commit` copies that point at this pack's runner. `review-pr` now reviews other people's PRs (`HEAD_REF` placeholder; `COMMIT_COUNT` and `COMMIT_LIST` removed; round 2+ returns ISSUE blocks). `ACCEPTANCE_CRITERIA` (review-plan) and `REVIEW_SCOPE` (review-impl) are gone; `SESSION_CONTEXT` is free text for what the reviewer cannot read itself. review-think no longer snapshots the tree around each round. `manifest.json` 10.0.0.

### v14: Review verbs, MCP server, two clients
- **New verbs** `begin`, `wait`, `reply`, `end` and MCP tools `review_begin/wait/reply/end`; skills no longer drive `init/render/start/poll/resume/finalize` themselves (the low-level commands are unchanged).
- **Verdict parsing**: verdict-only output is parsed as `format: "review"` with no blocks; `finalize` uses only the last round's verdict and fails when it has none.
- **Formats removed**: `codebase-cross` (CROSS blocks) and `security-review`; RESPONSE-only output is now `format: "response"` (was `codebase-validation`).
- **Reviewer sandbox**: the verbs start and resume Codex with `danger-full-access`; `resume` now passes the stored sandbox (`-c sandbox_mode=...`).
- **Installer**: installs Codex copies to `~/.agents/skills`, removes this pack's copies from `$CODEX_HOME/skills`, installs the MCP SDK and registers the MCP server with Claude Code and Codex. `shared/flavor-text.md`, `shared/protocol.md` and per-skill `references/protocol.md` are gone.

### v10–v13
- v13: runner-centric architecture; JSON-only output; `finalize`, `status`, `render`; runner manages all session state; `manifest.json` 7.0.0.
- v12: unified session directories `.codex-review/sessions/{skill}-{yyyymmdd}-{NNN}/`; `init` and `resume`.
- v11: `--format` removed; `review.md` is the only output.
- v10: `review.txt` renamed to `review.md`.

## Verification

1. Development Commands above: both gates exit 0
2. `node skill-packs/cross-review/scripts/review-runner.js version` prints `15`
3. Invoke a review skill from a temporary install in Claude Code (`/review-impl`) and Codex (`$review-impl`)

## Releasing

`.github/workflows/ci.yml` runs the tests and a temp-HOME install check on `ubuntu-latest` and `windows-latest` (tests in Git Bash; the Windows install check in pwsh with a temp `HOME`, `USERPROFILE`, `CODEX_HOME` and `npm_config_prefix`), each on Node 22 (the lowest `engines` allows) and 24 for every push to `main` and every pull request; the README shows its badge with the npm version, release, Node and license badges (shields.io, no logos).

`.github/workflows/release.yml` publishes `@tlelabs/cross-review` to npm when a `v<version>` tag is pushed: it checks that the tag, `package.json` and `manifest.json` carry the same version, runs the tests and a temp-HOME install check, packs, publishes with npm trusted publishing (OIDC, provenance; no token) unless that version is already on npm, and creates a GitHub release with the tarball.

1. Bump `version` in `package.json` and `skill-packs/cross-review/manifest.json` together; add a Breaking Changes entry when behavior changes.
2. Commit and push `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`, and watch the Release workflow.

First-time setup (done once): `npm login`; create the package with a placeholder: in a temp copy (`git archive HEAD | tar -x -C "$T"`), set `version` to `0.0.0-bootstrap.0`, `npm pack`, `npm publish <tgz> --access public --tag bootstrap`. On npmjs.com → `@tlelabs/cross-review` → Settings → Trusted Publisher → GitHub Actions: user `lploc94`, repository `cross-review`, workflow `release.yml`, allow `npm publish`. Push the first real tag within 2 days (npm expires a trusted publisher that no OIDC publish has used). Then `npm unpublish @tlelabs/cross-review@0.0.0-bootstrap.0` (allowed within 72 hours; later, `npm deprecate` it) and `npm dist-tag rm @tlelabs/cross-review bootstrap`.

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
