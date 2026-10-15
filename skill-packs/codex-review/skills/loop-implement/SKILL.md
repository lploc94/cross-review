---
name: loop-implement
description: Execute an approved loop-plan/v1 plan end to end with docs-first TDD, verification, checkpoint reviews, and commits. Use only when an approved plan exists.
---

# Loop Implement

Execute the approved `loop-plan/v1` plan from the next incomplete phase through completion. The plan, the user's latest explicit decisions, repository instructions, and verified current state define scope. Do not redesign the target, silently add features, or stop between phases without a real blocker.

## Admission

1. Locate the user-specified descriptively named `*-plan.md`, or a unique repository plan with `Plan schema: loop-plan/v1` and an incomplete phase. Do not rely on a generic `plan.md`; if only that exists, ask the user to rename it. With no plan, direct the user to `{{CLIENT_SKILL}}loop-plan`.
2. `Plan Review` must read `APPROVE` with its source: `codex-plan-review <session id>` or `user <date>`. `pending`, `REVISE`, or an approval without a source is not approval; offer `{{CLIENT_SKILL}}codex-plan-review`. If the plan was materially edited after approval, other than progress lines and dated user-approved changes, ask.
3. Read {{CLIENT_INSTRUCTIONS}}/repository instructions; inspect `git status`, diffs, and recent commits. Preserve unrelated user changes; never reset or revert them. Start at the first incomplete phase whose dependencies are complete.

## Per-phase loop

For each phase, in order:

1. Re-read the phase. Revalidate only the paths and symbols the code is about to touch.
2. Update owning documentation first when the phase requires it. Write or strengthen the tests, see them fail, and note the red result in one line. Tests vary inputs/state and reject hardcoded or fixture-only implementations.
3. Implement the complete production obligations through the real integration path (errors, state transitions, persistence, concurrency, invariants the phase names), minimal and project-consistent. Plan limits come with their stated soft handling.
4. Run each AC's narrow command, then the phase gates. Smoke-test only where the plan asks.
5. Inspect the staged diff once: phase-owned files only, no secrets, no leftovers of renamed or removed names.
6. Commit once with the planned message, together with the phase's progress line in the plan: result, AC evidence, and any deviation from the plan. Never amend, force, skip hooks, or create an empty commit.
7. If the plan lists this phase as a review checkpoint, run `{{CLIENT_SKILL}}codex-impl-review` with the model the plan names, if any. The review skill governs how findings are handled. Then report the phase and move on.

Gate discipline:
- A gate that cannot run is a problem to solve (install, build, start what the plan names), not something to note and skip.
- A failure that also occurs without your changes is a baseline failure: record it in the progress line and continue. Only new failures block.
- An AC that is not fully met is reported `not done` with the reason, never as done.

Plan changes:
- Do not add technology, dependencies, limits, or mechanisms the plan does not contain.
- When implementation exposes a real problem in the plan, propose a change as one decision: context, the problem with a concrete example, options (what changes, cost, risk, reversible or not), your recommendation with evidence, its benefit, harm and impact, and what happens next if agreed. If the user agrees, record it in the plan with the date; do not rerun plan review.

## Finalization

1. Run every `Global Gates` command once, exactly as written, on final `HEAD`.
2. Reuse each phase's AC evidence; check only what spans phases: invariants, ownership boundaries, exclusions.
3. Self-audit integration over the cumulative diff and commit history: cross-phase interfaces and state boundaries.
4. Run the plan's final review checkpoint with `{{CLIENT_SKILL}}codex-impl-review` on the cumulative diff.
5. Fix defects from steps 3–4 with a narrow regression test first, then the affected phase gates. Each fix still meets the plan's criteria and changes only what the defect needs; check what depends on the changed code and other places with the same pattern, since fixes are the main source of new bugs; rerun the full suite only once the fixes are in. Ask before any material scope the audit uncovers; do not hide it in a repair commit.
6. Update `Completion Criteria` in the final commit. Verify the worktree is clean apart from recorded unrelated changes.

## Stop conditions and reporting

Stop only for a real user decision, missing required credentials or infrastructure, irreconcilable requirements, or an irreversible action the plan does not authorize. A review stalemate is a user decision. Preserve evidence and ask one question at a time, in the decision format above.

Report phase commits, exact verification and gate results (with baseline failures), review outcomes, user-approved plan changes, ACs `not done`, and residual risks. Never claim approval or completion without recorded evidence.
