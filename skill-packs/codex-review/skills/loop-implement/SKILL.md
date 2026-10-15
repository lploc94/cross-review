---
name: loop-implement
description: Execute an approved loop-plan/v1 plan end to end with docs-first TDD, verification, phase reviews, and commits. Use only when an approved plan exists.
---

# Loop Implement

Execute the approved `loop-plan/v1` plan from the next incomplete phase through completion. The plan, the user's latest explicit decisions, repository instructions, and verified current state define scope. Do not redesign the target, silently add features, or stop between phases without a real blocker.

## Admission and preflight

1. Locate the user-specified descriptively named `*-plan.md` file, or a unique repository plan with `Plan schema: loop-plan/v1`, `Plan Review: APPROVE`, and an incomplete phase. Do not create or rely on a generic `plan.md`; if only that filename exists, ask the user to rename it to a work-specific name before proceeding. If no approved plan exists, stop and direct the user to `/loop-plan`.
2. Validate headings, phase fields, dependency order, baseline, progress log, and that approval is current. Never execute `pending`, `REVISE`, stale, or materially edited plans.
3. Read repository instructions. Inspect `git status`, staged/unstaged diffs, recent commits, and the baseline. Preserve unrelated user changes; never reset or revert them.
4. Keep exactly one phase `in_progress`, starting at the first incomplete phase whose dependencies are complete.

## Per-phase loop

For each phase, in order:

1. Re-read its goal, evidence, contract, invariants, exclusions, obligations, acceptance criteria, commands, and commit message. Revalidate paths and symbols against the current tree.
2. Mark the phase `in_progress` in the plan.
3. Follow documentation-first workflow: update the owning design/reference/runbook before code when the phase requires documentation.
4. Add or strengthen contract/regression tests before production code. Run the narrowest exact command and record meaningful red evidence when feasible. Tests must vary inputs/state and reject hardcoded or fixture-only implementations.
5. Implement the complete production obligations through the real integration path, including errors, state transitions, persistence, concurrency, and invariants named by the phase. Keep changes minimal and project-consistent.
6. Run focused verification, every phase gate, and a realistic smoke/integration path where feasible. Inspect exit codes, stderr, generated state, cleanup, and the complete diff.
7. Review the phase implementation against the approved plan. Treat review findings as follows:
   - Fix real in-scope defects, missing obligations, unsafe edge cases, or weak anti-shortcut coverage.
   - Dispute style preferences, speculative future-proofing, unrelated cleanup, and scope expansion with repository evidence.
   - Ask the user before adding a new user-visible contract, schema, dependency, compatibility guarantee, architecture, or operational burden.
   Re-run affected verification after accepted fixes. Do not mark a phase complete on unresolved review findings.
8. Check every phase acceptance criterion with concrete evidence, update the progress row, stage only phase-owned files plus plan bookkeeping, inspect the staged diff for secrets, and commit once using the planned message. Never amend, force, skip hooks, or create an empty commit.
9. Report the phase result and move immediately to the next eligible phase.

## Finalization

After all phases:

1. Re-read the plan and map every acceptance criterion, invariant, ownership boundary, and exclusion to evidence.
2. Run every `Global Gates` command exactly as written on final `HEAD`.
3. Perform a bounded integration self-audit over cumulative diff/stat and commit history, checking cross-phase interfaces and state boundaries. If it finds a concrete defect, add a focused regression test, repair the affected phase, rerun its review and all global gates, and commit normally.
4. Ask before any material scope discovered by the audit. Do not hide it in a repair commit.
5. Update completion criteria and final progress bookkeeping, using a separate plan-finalization commit if needed. Verify the worktree is clean apart from recorded unrelated changes.

## Stop conditions and reporting

Stop only for a material user/product decision, missing required credentials or infrastructure, irreconcilable requirements, a genuine review stalemate, repeated failures with no new evidence, unsafe overlap with unrelated edits, or an irreversible action not authorized by the plan. Leave the current phase `in_progress`, preserve evidence, and ask one focused question.

Report phase commits, exact verification/gate results, review outcomes, user-approved scope changes, residual risks, and any external qualification. Never claim approval or completion without the recorded evidence.
