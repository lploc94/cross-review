<h1 align="center"><b>Codex Review Skill</b></h1>

<p align="center">
  <img src="https://i.postimg.cc/vZY5Y5gC/Codex-skill.png" alt="Codex Skill" />
</p>

Single-command installer for the **codex-review** skill pack for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex).

Seven skills (Claude Code: `/name`, Codex: `$name`):
- `loop-plan` — write a phased, code-grounded implementation plan before coding
- `loop-implement` — execute an approved loop plan phase by phase with TDD, checkpoint reviews, and commits
- `codex-plan-review` — debate implementation plans before coding
- `codex-impl-review` — review uncommitted or branch changes before commit/merge
- `codex-think-about` — peer reasoning/debate on technical topics
- `codex-commit-review` — review committed code quality before push
- `codex-pr-review` — review PRs (branch diff, commit hygiene, description)

`codex-parallel-review`, `codex-codebase-review`, and `codex-security-review` were removed. Reinstalling deletes previously installed copies.

## Requirements

- Node.js >= 22 and npm
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI and/or [Codex CLI](https://github.com/openai/codex)
- `codex` in PATH, configured with an OpenAI account or API key (the reviewer always runs through Codex)

## Install

```bash
npx github:lploc94/codex_skill
```

### What it does
1. Installs the skills for Claude Code into `~/.claude/skills/` and for Codex into `~/.agents/skills/`
2. Installs the shared runtime (runner, MCP server, and its dependencies from the lock file) into `~/.claude/skills/codex-review/`
3. Renders each SKILL.md with the shared review protocol and the absolute runner path
4. Registers the `codex-review` MCP server with Claude Code (user scope) and Codex
5. Swaps directories atomically with rollback on failure; removes this pack's old copies from `~/.codex/skills`

### Verify
```bash
node ~/.claude/skills/codex-review/scripts/codex-runner.js version   # 14
claude mcp get codex-review
codex mcp get codex-review
```

### Reinstall / Update
```bash
npx github:lploc94/codex_skill
```
Re-running is safe: the MCP registration is replaced, not duplicated.

### Auto-review guidance (optional)
```bash
npx github:lploc94/codex_skill --auto
```
Injects review guidance into `~/.claude/CLAUDE.md` so Claude Code proactively suggests the right review skill based on context (e.g., `/loop-plan` before a multi-step change, `/codex-impl-review` before commits). Idempotent — safe to re-run.

## Usage

- `loop-plan` writes a `loop-plan/v1` plan with review checkpoints; it is approved by `codex-plan-review` or by you.
- `loop-implement` executes the approved plan and runs `codex-impl-review` at the plan's checkpoints.
- The review skills use the MCP tools `review_begin`, `review_wait`, `review_reply`, `review_end`. Without MCP they run the same verbs through the CLI: `node ~/.claude/skills/codex-review/scripts/codex-runner.js begin|wait|reply|end`.

The Codex reviewer runs with full access so it can run tests and network commands (`curl`, `npm view`, `git fetch`) to check its findings; its prompts forbid changing project files.

### Choose a model (optional)

Name a model when you ask for a review (or in a plan's review checkpoint). The skill passes it to `review_begin`; the runner stores it and reuses it for every later round. Without one, Codex uses its default model.

## License

MIT
