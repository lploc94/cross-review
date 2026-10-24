# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction and loads the compiled 3-layer `review-impl` system prompt (Layer 1 core reviewer methodology, Layer 2 always-on recon and spike tactics, and Layer 3 `review-impl` rubric).

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{USER_REQUEST}` | User's original task/PR description | No | "Review these changes for correctness against their target" |
| `{SESSION_CONTEXT}` | What the reviewer cannot find in the plan, the diff, or the repository: the user's decisions and constraints from the conversation, what was already verified | No | "None beyond the request" |
| `{OUTPUT_FORMAT}` | Copy the entire fenced code block from `references/output-format.md` (the single block after "Use this exact shape") | Yes | — |
| `{BASE_BRANCH}` | Base commit of the reviewed range (branch mode only): a branch, `@{u}`, `HEAD~N`, or a SHA | Conditional | — |
| `{FIXED_ITEMS}` | Lines listing accepted+fixed issues (`ISSUE-N: title — fixed in file:line`) | No | "No issues fixed this round" |
| `{DISPUTED_ITEMS}` | Lines listing disputed issues (`ISSUE-N: title — reason`) or "None — all issues addressed" | No | "None — all issues addressed" |

---

## Working Tree Review Prompt (Round 1)
```
## Your Role
Execute a Round 1 Working-Tree Implementation Review (`review-impl`) under your active system rubric. Verify that the uncommitted changes match the approved plan / original target with full vertical operational depth and zero defects.

## How to Inspect Changes
- Inspect uncommitted working-tree changes (`git status --porcelain=v1 -uall`, `git diff`, `git diff --cached`, and any untracked files) directly from the repository.
- Read surrounding code, callers (`rg -n`), and applicable project rules (`CLAUDE.md`, `AGENTS.md`).

## User's Original Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Review Focus
1. **Correctness & vertical operational depth vs. plan/target**: Verify every requirement and lifecycle path (`init`, `update`, `error/cancel/timeout`, `delete`).
2. **Deviations from plan**: Classify acceptable adaptations vs. unacceptable deviations (`plan-gap` when the plan itself causes a defect or misses a clearly superior evidence-backed option).
3. **Defects & performance bottlenecks**: Audit across all 6 system taxonomies; run a minimal isolated spike in `mktemp -d` when needed (only for uncovered deltas—never duplicate existing spikes/tests).
4. **Project rules**: Quote any violated repository instruction rule and its `file:line`.
5. **Output**: Report all findings as `ISSUE-{N}` (keep IDs stable across rounds) and end with a `### VERDICT` block (`APPROVE` or `REVISE`).

## Required Output Format
{OUTPUT_FORMAT}
```

## Branch Review Prompt (Round 1)
```
## Your Role
Execute a Round 1 Branch Implementation Review (`review-impl`) under your active system rubric. Verify that the committed branch changes against `{BASE_BRANCH}` match the approved plan / original target with full vertical operational depth, zero defects, and clean merge readiness.

## How to Inspect Changes
- Read the branch diff (`git diff {BASE_BRANCH}...HEAD`) and commit log (`git log {BASE_BRANCH}..HEAD`).
- Check merge readiness (`git merge-tree --write-tree {BASE_BRANCH} HEAD`) and compatibility with changes on `{BASE_BRANCH}` since the branch point.
- Read surrounding code, callers (`rg -n`), and applicable project rules (`CLAUDE.md`, `AGENTS.md`).

## Base
{BASE_BRANCH}

## User's Original Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Review Focus
1. **Correctness & vertical operational depth vs. plan/target**: Verify every requirement and lifecycle path.
2. **Deviations from plan**: Classify acceptable adaptations vs. unacceptable deviations (`plan-gap` when warranted by concrete evidence).
3. **Defects & performance bottlenecks**: Audit across all 6 system taxonomies; run a minimal isolated spike in `mktemp -d` only for uncovered deltas.
4. **Project rules & merge readiness**: Quote any violated repository rule (`file:line`) and verify `git merge-tree --write-tree {BASE_BRANCH} HEAD`.
5. **Output**: Report all findings as `ISSUE-{N}` (keep IDs stable across rounds) and end with a `### VERDICT` block (`APPROVE` or `REVISE`).

## Required Output Format
{OUTPUT_FORMAT}
```

## Rebuttal Prompt — Working-tree mode (Round 2+)

```
## Session Context
{SESSION_CONTEXT}

## Issues Fixed
{FIXED_ITEMS}

## Issues Disputed
{DISPUTED_ITEMS}

## Instructions
1. Re-read the current working-tree diff on disk — do NOT rely on memory of the previous round.
2. Verify whether each item in `Issues Fixed` is genuinely resolved (judge the outcome, not whether your exact suggested fix was used) and check for fix-induced regressions across callers.
3. Evaluate `Issues Disputed` against code evidence and authoritative user decisions in `Session Context`.
4. Keep `ISSUE-{N}` IDs strictly stable; assign `max(existing_IDs) + 1` to any new finding.
5. End with `### VERDICT`: `APPROVE` only if zero open issues remain; `REVISE` if any issue remains open or a new defect was introduced.

## Required Output Format
{OUTPUT_FORMAT}
```

## Rebuttal Prompt — Branch mode (Round 2+)

```
## How to Inspect Changes
- Re-read the branch diff (`git diff {BASE_BRANCH}...HEAD`) and commit log (`git log {BASE_BRANCH}..HEAD`) on disk.
- Fixes have been committed to the branch since the previous round.

## Session Context
{SESSION_CONTEXT}

## Issues Fixed
{FIXED_ITEMS}

## Issues Disputed
{DISPUTED_ITEMS}

## Instructions
1. Re-read the branch diff against `{BASE_BRANCH}` on disk — do NOT rely on memory of the previous round.
2. Verify whether each item in `Issues Fixed` is genuinely resolved in the committed code and check for fix-induced regressions.
3. Evaluate `Issues Disputed` against code evidence and authoritative user decisions in `Session Context`.
4. Keep `ISSUE-{N}` IDs strictly stable; assign `max(existing_IDs) + 1` to any new finding.
5. End with `### VERDICT`: `APPROVE` only if zero open issues remain; `REVISE` if any issue remains open or a new defect was introduced.

## Required Output Format
{OUTPUT_FORMAT}
```
