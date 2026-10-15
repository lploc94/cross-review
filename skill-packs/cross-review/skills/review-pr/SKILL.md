---
name: review-pr
description: Review someone else's pull request or branch with an external reviewer model (Codex CLI by default) as a peer: both review independently, debate the differences, and produce one consolidated review with a merge recommendation. No code changes.
---

# PR Review

## Purpose
Review a pull request you did not write: does it do what it claims, is it correct and safe, does it follow the project's rules, and is it ready to merge. You and the reviewer review independently, then reconcile into one review. Nothing in the project is edited or committed.

## When to Use
A PR or branch written by someone else (a teammate, a contributor, another agent session). For your own work, including your own PR before merge, use `review-impl` in branch mode: it fixes what it finds.

## Inputs
- **The PR.** GitHub: `gh pr view <n> --json number,url,title,body,baseRefName,headRefOid,commits,files` and `gh pr view <n> --comments` (decisions already made in review). Fetch the head without checking it out: `git fetch origin <baseRefName> pull/<n>/head`. A plain branch: its name, and the base it merges into.
- `BASE_BRANCH`: the base it merges into (e.g. `origin/main`). `HEAD_REF`: the PR head as a SHA (`headRefOid`, or `git rev-parse <branch>`), so every round reviews the same version even if the author pushes meanwhile. Validate both with `git rev-parse --verify <ref>^{commit}`.
- **Running the code.** When the review needs tests or a build, create a detached worktree outside the repository (`git worktree add --detach "$(mktemp -d)/pr" <HEAD_REF>`), name it in `SESSION_CONTEXT`, and remove it with `git worktree remove` when the review ends.
- Round 1 placeholders: `PR_TITLE`, `PR_DESCRIPTION` (body, plus linked issues), `BASE_BRANCH`, `HEAD_REF`, `USER_REQUEST` (what the user wants from this review), `SESSION_CONTEXT` (review discussion and decisions, worktree path).
- Reply placeholders: `SESSION_CONTEXT`, `BASE_BRANCH`, `HEAD_REF`, `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_FINDINGS`, `CONTINUE_OR_CONSENSUS_OR_STALEMATE`.
- Skill `review-pr`, no mode.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill:
- Write your FINDING-{N} entries as `analysis_prompt` describes to `<session_dir>/analysis.md` before your first `review_wait`.
- Compare them with the reviewer's `review.blocks[]`: map each FINDING to the ISSUE about the same problem, then list agreements, disagreements (whether it is real, its severity, whether it blocks), and points only one side raised. Verify a disputed point in the code before you argue it.
- **Exit rule:** consensus once both sides agree on every blocking finding; stalemate when the same disagreement repeats for two rounds.

## Completion
Lead with the merge recommendation: **request changes** if any agreed finding blocks merge, otherwise **approve** (with the non-blocking findings as comments); on a stalemate over a blocking point, present both sides and let the user decide. Then the blocking findings, the non-blocking ones, disagreements (point | you | reviewer), and what was not checked (tests not run, files skimmed). Draft the review as the user would post it: a summary plus one comment per finding at its `file:line`, in the PR's language. Write the report to `<session_dir>/summary.md`. Post to the PR (`gh pr review`, `gh api` for line comments) only when the user asks.

## Rules
- Never edit the project, commit, push, or check out the PR in the user's working tree.
- You and the reviewer are equal peers; the reviewer only reviews and never edits.
