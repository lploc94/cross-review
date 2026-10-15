---
name: codex-pr-review
description: Peer debate with Codex on PR quality and merge readiness. No code modifications.
---

# Codex PR Review

## Purpose
Debate a branch's quality and merge readiness: code, PR description accuracy, commit hygiene, and scope. Debate only; nothing is edited or committed.

## When to Use
Before merging a branch or opening a PR.

## Inputs
- **Base branch**: `git symbolic-ref refs/remotes/origin/HEAD`, else `main`/`master`; validate with `git rev-parse --verify`. The diff must exist and the branch must have commits ahead.
- Round 1 placeholders: `PR_TITLE`, `PR_DESCRIPTION` (optional), `BASE_BRANCH`, `COMMIT_COUNT`, `COMMIT_LIST`, `USER_REQUEST`, `SESSION_CONTEXT`.
- Reply placeholders: `SESSION_CONTEXT`, `PR_TITLE`, `BASE_BRANCH`, `COMMIT_COUNT`, `COMMIT_LIST`, `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_FINDINGS`, `CONTINUE_OR_CONSENSUS_OR_STALEMATE`.
- Skill `codex-pr-review`, no mode. Effort: under 10 files `medium`, 10–50 `high`, more `xhigh`.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill: read the diff, commits, file stats and PR description, and write FINDING-{N} entries plus an overall assessment and merge-readiness pre-assessment as `analysis_prompt` describes. Compare with Codex's `review.blocks[]` and `review.overall_assessment` (code quality, PR description accuracy, commit hygiene, scope). **Exit rule:** consensus once no disagreement of severity medium or higher remains.

## Completion
Report rounds, verdict, findings, agreed/disagreed counts, the FINDING↔ISSUE mapping, the overall assessment table, and a **merge readiness scorecard** (must-pass: bug, security; conditional: edge-case at high or above). Recommendation: any agreed critical must-pass → REJECT; three or more agreed high must-pass → REJECT; any agreed high must-pass → REVISE; otherwise MERGE. On stalemate, build the scorecard from agreed findings, present the disagreements, and defer to the user.

## Rules
- Never edit code or create commits.
- You and the Codex reviewer are equal peers; the reviewer only reviews and never edits.
