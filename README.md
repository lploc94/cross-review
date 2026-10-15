<h1 align="center"><b>Cross Review</b></h1>

Cross-model review skills for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex): the agent you work with orchestrates, and a second model reviews its plans, code and reasoning. The reviewer today is the Codex CLI; the runner selects reviewers through one adapter per CLI (`scripts/lib/reviewers/`), so others can be added.

Seven skills (Claude Code: `/name`, Codex: `$name`):
- `loop-plan` — write a phased, code-grounded implementation plan for large, multi-feature work
- `loop-implement` — execute an approved loop plan phase by phase with TDD, checkpoint reviews, and commits
- `review-plan` — debate implementation plans before coding
- `review-impl` — review uncommitted changes, unpushed commits, or a branch before commit/push/merge
- `review-think` — peer reasoning/debate on technical topics
- `review-pr` — review someone else's PR as a peer (correctness, description, merge readiness); your own PR goes through `review-impl`

This project was called **codex-review** (`lploc94/codex_skill`, skills `codex-plan-review`, `codex-impl-review`, `codex-think-about`, `codex-commit-review`, `codex-pr-review`). Installing removes that pack's skills, runtime and MCP server registration. Finish any review that is still running before you update: sessions started under the old names cannot be resumed.

## Requirements

- Node.js >= 22 and npm
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI and/or [Codex CLI](https://github.com/openai/codex)
- `codex` in PATH, configured with an OpenAI account or API key (the default reviewer)

## Install

```bash
npx github:lploc94/cross-review
```

### What it does
1. Installs the skills for Claude Code into `~/.claude/skills/` and for Codex into `~/.agents/skills/`
2. Installs the shared runtime (runner, MCP server, and its dependencies from the lock file) into `~/.claude/skills/cross-review/`
3. Renders each SKILL.md with the shared review protocol and the absolute runner path
4. Registers the `cross-review` MCP server with Claude Code (user scope) and Codex
5. Swaps directories atomically with rollback on failure; removes the old `codex-review` pack and this pack's copies in `~/.codex/skills`

### Verify
```bash
node ~/.claude/skills/cross-review/scripts/review-runner.js version   # 15
claude mcp get cross-review
codex mcp get cross-review
```

### Reinstall / Update
```bash
npx github:lploc94/cross-review
```
Re-running is safe: the MCP registration is replaced, not duplicated.

### Automatic reviews (optional)
```bash
npx github:lploc94/cross-review --auto
```
Adds a block to `~/.claude/CLAUDE.md` that has Claude Code use the `review-plan` skill after it finishes any plan and the `review-impl` skill after it finishes any implementation, without asking first. This applies to every plan and implementation, not only `loop-plan` and `loop-implement`. It skips trivial changes, reviews a loop skill already ran, and reviews you asked it to skip. The other skills are never run automatically. Idempotent — safe to re-run. Every install, with or without `--auto`, refreshes a block that is already there, including one written by the old codex-review pack.

## Usage

- `loop-plan` writes a `loop-plan/v1` plan with review checkpoints; it is approved by `review-plan` or by you.
- `loop-implement` executes the approved plan and runs `review-impl` at the plan's checkpoints.
- The review skills use the MCP tools `review_begin`, `review_wait`, `review_reply`, `review_end`. Without MCP, or in a mode that refuses the tools, they run the same verbs through the CLI: `node ~/.claude/skills/cross-review/scripts/review-runner.js begin|wait|reply|end`.
- Review sessions live in `<repo>/.cross-review/`, which ignores itself in git.

The reviewer runs with full access so it can run tests and network commands (`curl`, `npm view`, `git fetch`) to check its findings; its prompts forbid changing project files.

### Choose a model (optional)

Name a model when you ask for a review (or in a plan's review checkpoint). The skill passes it to `review_begin`; the runner stores it and reuses it for every later round. Without one, the reviewer CLI uses its default model.

## License

MIT
