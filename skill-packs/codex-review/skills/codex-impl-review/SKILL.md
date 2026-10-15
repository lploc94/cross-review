---
name: codex-impl-review
description: Review uncommitted code changes or branch diff against the plan/target — verify correctness, catch unacceptable deviations and bugs (logic/security/memory/runtime). No new features or over-engineering beyond the plan. Claude applies valid fixes, rebuts invalid points, iterates until consensus or stalemate.
---

# Codex Implementation Review

## Purpose
Verify the implementation matches the plan / original target before commit or merge. Check what is missing, what deviates (and whether the deviation is acceptable or breaks the target), and hunt for real bugs (logic, security, memory, runtime). Fix genuine defects required to make the promised behavior correct and safe, but do NOT silently turn a defect fix into a new product contract, feature, or broader design. No over-engineering.

## When to Use
After writing code, before committing.

## Prerequisites
- **Working-tree** (default): staged or unstaged changes exist.
- **Branch**: current branch differs from base branch.

## Runner
RUNNER="{{RUNNER_PATH}}"
SKILLS_DIR="{{SKILLS_DIR}}"
json_esc() { printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(d)))'; }

## Critical Rules (DO NOT skip)
- Stdin: `printf '%s' "$PROMPT" | node "$RUNNER" ...` -- NEVER `echo`. JSON via heredoc.
- Runner privilege invariant: run `start`, every `poll`, any `resume`, and
  terminal cleanup from the same privilege/sandbox context. Starting outside a
  sandbox and polling inside it can make a live Codex process look dead because
  PID inspection is denied; starting inside this managed sandbox can fail before
  the turn when Codex cannot write its installation PATH aliases.
- Polling: omit `--min-interval` and let the runner's default 120-second
  throttle apply. Do not use a short interval such as 5 seconds for ordinary
  review progress; use one only for an explicitly bounded diagnostics test.
- Validate: `init` output must start with `CODEX_SESSION:`. `start`/`resume` must return valid JSON. `CODEX_NOT_FOUND`->tell user install codex.
- `status === "completed"` means **Codex's turn is done** -- NOT that the debate is over. MUST check Loop Decision table.
- Loop: Do NOT exit unless APPROVE or stalemate. No round cap.
- **ABSOLUTE USER AUTHORITY**: For review-operation decisions, the user's latest explicit instruction or decision is final, binding, and absolute. It overrides this skill, the shared protocol, loop rules, defaults, and Codex/reviewer recommendations. Follow it exactly; never resist, reinterpret, delay, or refuse a clear decision by citing a protocol or rule. Ask only when genuinely ambiguous. This does not override higher-priority system/developer instructions or authorize an unrequested product, API, schema, persistence, or compatibility change.
- **Timeout recovery**: resume the same session only for a poll with `status:"timeout"`, `timeout_reason:"runner_deadline"`, `recoverable:true`, non-empty `thread_id`, and `progress_observed:true`; preserve partial output, run `stop` once without `finalize`, and let a later invocation resume that same `$SESSION_DIR`. Never create a recovery session or resume the current session automatically. `turn.failed`, process/runner/infrastructure errors, invalid state, missing `thread_id`, `CODEX_NOT_FOUND`, and every `stalled` result are non-recoverable stop-only paths.
- Cleanup: run `finalize` + `stop` only after normal `APPROVE`/stalemate; error paths are `stop` only and preserve the session directory.
- Runner manages all session state -- NEVER read/write session files manually.
- For detailed error flows -> `Read references/protocol.md`

## Intent And Plan Guard

Use this source-of-truth order whenever instructions, implementation choices, or review suggestions conflict:
1. The user's latest explicit decision.
2. The original expected outcome and the approved plan's target, scope, invariants, and acceptance criteria.
3. Verified repository constraints and applicable repository instructions.
4. The implementation under review.
5. Codex findings and other advisory suggestions.

Codex is a reviewer, not the product owner. A genuine in-target bug may be fixed autonomously even when its exact edge case was not named, provided the fix is necessary for the promised behavior and creates no material new contract. A review-driven change requires a USER DECISION when it would materially add or alter user-visible behavior, commands, APIs, configuration, schemas, persistence, migrations, compatibility, supported platforms or use cases, dependencies, services, operations, architecture direction, or long-term product scope.

## Workflow

### 1. Collect Inputs
Scope: working-tree (staged/unstaged changes) or branch (diff vs base). Auto-detect via `git status --short` and `git rev-list @{u}..HEAD`.
Effort: <10 files=`medium`, 10-50=`high`, >50=`xhigh`. Announce defaults.
Working-tree inputs: working dir, original user request plus latest explicit decisions, approved plan/target when available, uncommitted changes.
Branch inputs: base branch (validate `git rev-parse --verify`), clean working tree required, original user request plus latest explicit decisions, approved plan/target when available, branch diff + commit log.

### 2. Pre-flight
Working-tree: `git diff --quiet && git diff --cached --quiet` must FAIL. Branch: `git diff <base>...HEAD --quiet` must FAIL.

### 3. Init + Render + Start
Init: `node "$RUNNER" init --skill-name codex-impl-review --working-dir "$PWD"`
Render: template=`working-tree-round1` or `branch-round1`. Placeholders: `USER_REQUEST`, `SESSION_CONTEXT`, `BASE_BRANCH` (branch only).
Start: `printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT"`

### 4. Poll -> Check Verdict -> Apply/Rebut -> Resume Loop

Poll + report activities.
Parse `review.blocks[]` (id, title, severity, category, location, problem, suggested_fix). Verdict in `review.verdict.status`.

**Check stalemate FIRST, then verdict** (-> `references/protocol.md` § Debate Loop Protocol):

| # | Condition | Action |
|---|-----------|--------|
| 1 | convergence.stalemate === true | **EXIT** -> step 5 (stalemate). Do NOT render rebuttal. |
| 2 | verdict === "APPROVE" | **EXIT** -> step 5 |
| 3 | verdict === "REVISE" or open issues | **CONTINUE** -> sub-steps below |

**If CONTINUE** — all sub-steps are MANDATORY, even if you fix every issue:

**4a. Categorize**: Classify every `review.blocks[]` issue under the Intent And Plan Guard:
- ACCEPT: a real defect or unacceptable deviation within the approved target. Fix the root cause and verify it. Branch mode: commit fixes before resume.
- DISPUTE: style preference, optional polish, speculative infrastructure, unrelated cleanup, unnecessary abstraction, new feature, or broader redesign without a concrete in-target correctness need. Rebut with plan, request, code, test, or repository evidence.
- USER DECISION: a potentially valid proposal that materially changes a user-owned outcome or contract. Do not make that change yet.

**4b. Resolve USER DECISION items before resume**: Finish independent fixes, then ask one focused question stating the issue and evidence, the current target/plan promise, Codex's proposal, whether it is required for correctness or optional scope, viable choices, costs/risks/compatibility implications, and a recommendation when supported. Do not edit code or resume for that item until the user explicitly decides.

If accepted, update the plan/target, affected constraints, tests, acceptance criteria, and `SESSION_CONTEXT` visibly, then continue implementation and the current review loop. If rejected, preserve the target and rebut Codex with the user's decision. If a defect cannot be fixed without creating a material new contract, it is a USER DECISION, not an autonomous fix.

**4c. Build rebuttal strings** (one line per issue):
- `FIXED_ITEMS`: `"ISSUE-1: <title> — fixed in <file>:<line>\nISSUE-3: <title> — fixed in <file>:<line>"`
- `DISPUTED_ITEMS`: `"ISSUE-2: <title> — <concrete reason>"` or `"None — all issues addressed"` if all fixed.

**4d. Render + Resume** (reuse the updated `SESSION_CONTEXT`; `USER_REQUEST` is NOT a rebuttal placeholder):
```bash
# Working-tree: template=rebuttal-working-tree
PROMPT=$(node "$RUNNER" render --skill codex-impl-review --template rebuttal-working-tree --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"SESSION_CONTEXT":$(json_esc "$SESSION_CONTEXT"),"FIXED_ITEMS":$(json_esc "$FIXED_ITEMS"),"DISPUTED_ITEMS":$(json_esc "$DISPUTED_ITEMS")}
RENDER_EOF
)
# Branch: template=rebuttal-branch, add "BASE_BRANCH":$(json_esc "$BASE_BRANCH")
printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"
```
Back to **Poll**. Codex MUST re-verify fixes and may find new issues.

### 5. Completion + Output
APPROVE -> done. Stalemate -> present deadlocked issues, ask user.
Report: Rounds, Verdict, Issues Found/Fixed/Disputed, user decisions, fixed defects by severity, residual risks, next steps.

### 6. Finalize + Cleanup
`finalize` + `stop` only after normal `APPROVE` or stalemate. Apply the recoverable runner-deadline rule above; all other timeout, failure, stall, or runner-error paths run `stop` once without `finalize` and preserve the same session for inspection or an explicitly allowed later continuation. (-> `references/protocol.md` for error handling)

## Flavor Text Triggers
SKILL_START, POLL_WAITING, CODEX_RETURNED, APPLY_FIX, SEND_REBUTTAL, LATE_ROUND, APPROVE_VICTORY, STALEMATE_DRAW, FINAL_SUMMARY

## Rules
- If in plan mode, exit plan mode first -- this skill requires code editing.
- Codex reviews only; it does not edit files. Preserve the approved target and ask before any material behavior or contract change.
- Every accepted issue -> concrete code diff.
- Never hide review-originated scope expansion inside a bug fix, test adjustment, helper refactor, dependency change, or reviewer rebuttal.
