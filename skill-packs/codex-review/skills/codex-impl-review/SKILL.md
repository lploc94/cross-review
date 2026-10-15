---
name: codex-impl-review
description: Review uncommitted code changes or branch diff against the plan/target — verify correctness, catch unacceptable deviations and bugs (logic/security/memory/runtime). No new features or over-engineering beyond the plan. You apply valid fixes, rebut invalid points, and iterate until consensus or stalemate.
---

# Codex Implementation Review

## Purpose
Verify the implementation matches the approved plan or target before commit or merge: what is missing, what deviates and whether that breaks the target, and real defects. Design and technology were settled in the plan; this review does not reopen them.

## When to Use
After writing code, before committing, and at a plan's review checkpoints.

## Inputs
- **Mode**: `working-tree` (staged or unstaged changes exist) or `branch` (diff against a base; working tree clean). Detect with `git status --short` and `git rev-list @{u}..HEAD`; validate a base with `git rev-parse --verify`. The diff must be non-empty.
- Round 1 placeholders: `USER_REQUEST` (original request plus the user's latest decisions; name the approved plan and phase when there is one), `SESSION_CONTEXT` (constraints, assumptions, tech stack, acceptance criteria, review scope), `BASE_BRANCH` (branch mode).
- Reply placeholders: `SESSION_CONTEXT`, `FIXED_ITEMS`, `DISPUTED_ITEMS`, `BASE_BRANCH` (branch mode).
- Skill `codex-impl-review`. Effort: under 10 files `medium`, 10–50 `high`, more `xhigh`, unless the user or plan says otherwise.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill: fix accepted issues in code, add a regression test where the defect is testable, and rerun the affected verification. Branch mode: commit the fixes before replying. A `plan-gap` finding from Codex follows the plan-gap path above.

## Completion
APPROVE: done. Stalemate: present the deadlocked issues and ask the user. Report rounds, verdict, issues found/fixed/disputed, user decisions, fixed defects by severity, and remaining risks.

## Rules
- If in plan mode, exit plan mode first; this skill edits code.
- The Codex reviewer only reviews and never edits files; you make the changes. Every accepted issue becomes a concrete code change.
- Never hide review-originated scope expansion inside a bug fix, test adjustment, helper refactor, dependency change, or rebuttal.
