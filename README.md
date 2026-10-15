<h1 align="center"><b>Codex Review Skill</b></h1>

<p align="center">
  <img src="https://i.postimg.cc/vZY5Y5gC/Codex-skill.png" alt="Codex Skill" />
</p>

Single-command installer for the **codex-review** skill pack for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Seven skills:
- `/loop-plan` — write a phased, code-grounded implementation plan before coding
- `/loop-implement` — execute an approved loop plan phase by phase with TDD, reviews, and commits
- `/codex-plan-review` — debate implementation plans before coding
- `/codex-impl-review` — review uncommitted or branch changes before commit/merge
- `/codex-think-about` — peer reasoning/debate on technical topics
- `/codex-commit-review` — review committed code quality before push
- `/codex-pr-review` — review PRs (branch diff, commit hygiene, description)

`/codex-parallel-review`, `/codex-codebase-review`, and `/codex-security-review` were removed. Reinstalling deletes previously installed copies.

## Requirements

- Node.js >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`) in PATH
- OpenAI API key configured for Codex

## Install

```bash
npx github:lploc94/codex_skill
```

### What it does
1. Installs skills directly into `~/.claude/skills/` (one directory per skill)
2. Copies the shared `codex-runner.js` to `~/.claude/skills/codex-review/scripts/`
3. Injects the absolute runner path into each SKILL.md template
4. Validates templates and references before finalizing
5. Atomic swap per directory with rollback on failure

### Verify
```bash
node ~/.claude/skills/codex-review/scripts/codex-runner.js version
```

### Reinstall / Update
```bash
npx github:lploc94/codex_skill
```

### Auto-review guidance (optional)
```bash
npx github:lploc94/codex_skill --auto
```
Injects review guidance into `~/.claude/CLAUDE.md` so Claude Code proactively suggests the right review skill based on context (e.g., `/loop-plan` before a multi-step change, `/codex-impl-review` before commits). Idempotent — safe to re-run.

## Usage

After install, start Claude Code and run:

- `/loop-plan` — write a `loop-plan/v1` plan; review it with `/codex-plan-review`
- `/loop-implement` — execute the approved plan; each phase is reviewed (for example with `/codex-impl-review`)
- `/codex-plan-review` — debate implementation plans before coding
- `/codex-impl-review` — review uncommitted or branch changes before commit/merge
- `/codex-think-about` — peer reasoning/debate on technical topics
- `/codex-commit-review` — review committed code quality before push
- `/codex-pr-review` — review PRs (branch diff, commit hygiene, description)

### Choose a model (optional)

You can specify a model when requesting a review. The runner accepts `--model <name>` on both `start` and `resume` and forwards the name unchanged to Codex CLI. Omit the flag to keep Codex CLI's default model selection.

```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --model "model-name"
# For a subsequent round, with its new prompt:
printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --model "model-name"
```

Replace `model-name` with your chosen model. Pass it on each `resume`, including recovery, to explicitly keep that model; the runner does not store the model override in session state. See the [runner protocol](skill-packs/codex-review/shared/protocol.md#optional-model-selection) for details.

## License

MIT
