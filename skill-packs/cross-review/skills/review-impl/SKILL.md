---
name: review-impl
description: Review uncommitted changes, unpushed or recent commits, or a branch diff against the plan/target with an external reviewer model (Codex CLI by default; Claude Code or Antigravity on request) — verify correctness, catch unacceptable deviations and bugs (logic/security/memory/runtime). No new features or over-engineering beyond the plan. You apply valid fixes, rebut invalid points, and iterate until consensus or stalemate.
---

# Implementation Review

## Purpose
Verify the implementation matches the approved plan or target before commit or merge: what is missing, what deviates and whether that breaks the target, and real defects. Design and technology were settled in the plan; this review does not reopen them.

## When to Use
After writing code: before committing, after committing and before pushing, before merging a branch, and at a plan's review checkpoints.

## Inputs
- **Mode**: `working-tree` (staged or unstaged changes exist) or `branch` (commits against a base; working tree clean). Detect with `git status --short` and `git rev-list @{u}..HEAD`. The diff must be non-empty.
- **Base** (`BASE_BRANCH`, branch mode): the commit before the commits under review. Unpushed commits: `@{u}`. The last N commits: `HEAD~N`, with N no larger than `git rev-list --count HEAD` minus one; fix commits move `HEAD~N`, so resolve it once with `git rev-parse HEAD~N` and pass that SHA in every round. A branch or your own PR before merge: the target branch, with the PR title and description in `USER_REQUEST`. Validate it with `git rev-parse --verify <base>^{commit}`. A range that would include the repository's first commit has no base; tell the user the review would cover the whole project and ask how to proceed.
- Round 1 placeholders: `USER_REQUEST` (original request plus the user's latest decisions; name the approved plan and phase when there is one), `SESSION_CONTEXT` (only what the reviewer cannot read in the plan, the diff, or the repository: decisions and constraints from the conversation, what was already verified; where real samples live when the work parses, limits or guards input), `BASE_BRANCH` (branch mode).
- Reply placeholders: `SESSION_CONTEXT`, `FIXED_ITEMS`, `DISPUTED_ITEMS`, `BASE_BRANCH` (branch mode).
- Skill `review-impl`.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill: fix accepted issues in code, add a regression test where the defect is testable, and rerun the affected verification. Branch mode: commit the fixes as new commits before replying; never amend, rebase, or force-push reviewed commits unless the user asks. A `plan-gap` finding from the reviewer follows the plan-gap path above.

## Completion
APPROVE: done. Stalemate: present the deadlocked issues and ask the user. Report rounds, verdict, issues found/fixed/disputed, user decisions, fixed defects by severity, and remaining risks.

## Rules
- If in plan mode, exit plan mode first; this skill edits code.
- The reviewer only reviews and never edits files; you make the changes. Every accepted issue becomes a concrete code change.
- Never hide review-originated scope expansion inside a bug fix, test adjustment, helper refactor, dependency change, or rebuttal.
