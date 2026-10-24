# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction and loads the compiled 3-layer `review-plan` system prompt (Layer 1 core reviewer methodology, Layer 2 always-on recon and spike tactics, and Layer 3 `review-plan` rubric).

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{PLAN_PATH}` | Absolute path to plan file | Yes | — |
| `{USER_REQUEST}` | User's original task description | No | "Review this plan for quality and completeness" |
| `{SESSION_CONTEXT}` | What the reviewer cannot find in the plan or the repository: the user's decisions and constraints from the conversation | No | "None beyond the request and the plan" |
| `{OUTPUT_FORMAT}` | Copy the entire fenced code block from `references/output-format.md` (the single block after "Use this exact shape") | Yes | — |

---

## Plan Review Prompt (Round 1)

```
## Your Role
Execute a Round 1 Implementation-Plan Review (`review-plan`) under your active system rubric. Maximize the plan's probability of achieving its stated target cleanly, safely, and completely.

## Plan Location
Read the plan file directly at: {PLAN_PATH}

## User's Original Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Review Focus
1. **Grounding & Reality Check**: Verify every file path, symbol, line reference, command, and behavioral claim in `{PLAN_PATH}` against the actual repository. Audit existing spikes/tests first—do NOT re-spike claims already proven by an existing spike in the repo or plan.
2. **Achievability & Vertical Operational Depth**: Ensure phases cover the complete operational lifecycle without unrequested horizontal scope creep or dogmatic compatibility shims for 0-user/greenfield dev work.
3. **Plan Type Contract**: If the plan declares `loop-plan/v1`, verify its full structural and behavioral contract (`Feasibility evidence`, `Invariants`, `Capacity`, binary `AC-N` with narrow commands, `Completion Criteria`, and `Review checkpoints`).
4. **Output**: Do NOT modify project files. Report all findings as `ISSUE-{N}` (keep IDs stable across rounds) and end with a `### VERDICT` block (`APPROVE` or `REVISE`).

## Required Output Format
{OUTPUT_FORMAT}
```

## Rebuttal Prompt (Round 2+)

```
## Updated Plan
The plan has been edited based on your previous findings.
Read the updated plan file directly at: {PLAN_PATH}

## Session Context
{SESSION_CONTEXT}

## Issues Accepted & Fixed
{FIXED_ITEMS}

## Issues Disputed
{DISPUTED_ITEMS}

## Instructions
1. Re-read `{PLAN_PATH}` on disk — do NOT rely on memory of the previous version.
2. Verify that each item in `Issues Accepted & Fixed` is genuinely resolved and that the edits did not introduce contradictions, broken phase ordering, or stale references across the rest of the plan.
3. Evaluate `Issues Disputed` against repository evidence and authoritative user decisions in `Session Context`.
4. Keep `ISSUE-{N}` IDs strictly stable; assign `max(existing_IDs) + 1` to any new finding that blocks reaching the target.
5. End with `### VERDICT`: `APPROVE` only if zero open issues remain; `REVISE` if any issue remains open or a new blocking flaw was introduced.

## Required Output Format
{OUTPUT_FORMAT}
```
