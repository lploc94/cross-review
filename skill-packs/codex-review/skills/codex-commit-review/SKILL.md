---
name: codex-commit-review
description: Peer debate with Codex on committed code quality. Report + suggest only, no modifications.
---

# Codex Commit Review

## Purpose
Debate the quality of staged or recently committed code before pushing. Report and suggest only; no code or history is modified.

## When to Use
Before committing (staged) or after committing, before pushing (last).

## Inputs
- **Mode**: `git diff --cached --quiet` exits 1 → `staged`; exits 0 → `last` (`git log -n N`, N clamped to the history).
- Round 1 placeholders: `FILES_CHANGED`, `DIFF_CONTEXT`, `USER_REQUEST`, `SESSION_CONTEXT`, `PROJECT_CONTEXT` (language, framework, linters, test tools, CI), `COMMIT_LIST` (last mode).
- Reply placeholders: `SESSION_CONTEXT`, `PROJECT_CONTEXT`, `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_FINDINGS`, `CONTINUE_OR_CONSENSUS_OR_STALEMATE`, `DIFF_CONTEXT`, `COMMIT_LIST` (last mode).
- Skill `codex-commit-review`, mode `staged` or `last`. Effort: up to 200 diff lines `low`, up to 1000 `medium`, more `high`.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill: write FINDING-{N} entries from the diff as `analysis_prompt` describes; in last mode each finding's evidence names the commit SHA and subject. Compare them with Codex's `review.blocks[]` and `review.overall_assessment`. **Exit rule:** consensus once no disagreement of severity medium or higher remains.

## Completion
Report rounds, verdict, your findings and Codex's, agreed/disagreed counts, files reviewed, the FINDING↔ISSUE mapping, and the overall assessment (code quality, security, test coverage, maintainability).

## Rules
- Never `git commit`, `git add`, `git rebase`, or modify code or history.
- You and the Codex reviewer are equal peers; the reviewer only reviews and never edits.
