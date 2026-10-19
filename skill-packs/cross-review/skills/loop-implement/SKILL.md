---
name: loop-implement
description: Execute an approved loop-plan/v1 plan end to end with docs-first TDD, verification, checkpoint reviews, and commits. Use only when an approved plan exists.
---

# Loop Implement

Execute the approved `loop-plan/v1` plan from the next incomplete phase through completion. The plan, the user's latest explicit decisions, repository instructions, and verified current state define scope. Do not redesign the target, silently add features, or stop between phases without a real blocker. The user's latest explicit instruction overrides this skill's procedure (skip, accept, or resume a review, change the order, handle a step another way); follow it and record it in the progress line.

## Admission

1. Locate the user-specified descriptively named `*-plan.md`; otherwise run `node "{{RUNNER_PATH}}" plans --working-dir "$PWD"` and take the one plan it lists with `format: "loop-plan"` and an incomplete phase. Never run a `markdown` file from that list, and do not search the rest of the repository. Do not rely on a generic `plan.md`; if only that exists, ask the user to rename it. With no plan, direct the user to `{{CLIENT_SKILL}}loop-plan`.
2. `Plan Review` must read `APPROVE` with its source: `review-plan <session id>` or `user <date>`. `pending`, `REVISE`, or an approval without a source is not approval; offer `{{CLIENT_SKILL}}review-plan`. If the plan was materially edited after approval, other than progress lines and dated user-approved changes, ask.
3. Read {{CLIENT_INSTRUCTIONS}}/repository instructions; inspect `git status`, diffs, and recent commits. Preserve unrelated user changes; never reset or revert them. Start at the first incomplete phase whose dependencies are complete.

## Per-phase loop

For each phase, in order:

1. Re-read the phase. Revalidate only the paths and symbols the code is about to touch.
2. Update owning documentation first when the phase requires it. Write or strengthen the tests, see them fail, and note the red result in one line. Tests vary inputs/state and reject hardcoded or fixture-only implementations.
3. Implement the complete production obligations through the real integration path (errors, state transitions, persistence, concurrency, invariants the phase names), minimal and project-consistent. Plan limits come with their stated soft handling.
4. Run each AC's narrow command, then the phase gates. Smoke-test only where the plan asks, except for long runs (below).
5. Inspect the staged diff once: phase-owned files only, no secrets, no leftovers of renamed or removed names.
6. Commit once with the planned message. In the plan, tick `- [x]` each of the phase's acceptance criteria that is met (an unmet one stays `- [ ]`, its reason in the progress line) and write the phase's progress line in `Progress Log`: result, AC evidence, and any deviation from the plan, plus a `Discovery:` line with evidence for each surprise that shaped the work. Stage the plan only when `git check-ignore -q <plan>` exits 1; when it exits 0, git ignores the plan: update it in place, do not stage it, and do not treat that as an error. Never amend, force, skip hooks, or create an empty commit.
7. If the plan lists this phase as a review checkpoint, run `{{CLIENT_SKILL}}review-impl` with the model the plan names, if any. The review skill governs how findings are handled. Then report the phase and move on.
8. If the reviewer cannot run (not installed, auth, quota, repeated errors), self-review the checkpoint's diff against the review-impl criteria (plan/target, deviations, defects, project rules), fix what you find, record `self-review (reviewer unavailable: <reason>)` in the progress line, never as a review approval, and continue. At the next checkpoint, try the reviewer again on the whole diff since the last real review; while it still fails, keep self-reviewing the same way.

Gate discipline:
- A gate that cannot run is a problem to solve (install, build, start what the plan names), not something to note and skip.
- A failure that also occurs without your changes is a baseline failure: record it in the progress line and continue. Only new failures block.
- An AC that is not fully met is reported `not done` with the reason, never as done.
- A run longer than about 10 minutes always goes through a pilot on a small subset first, the plan's or, when it names none, one you build that covers the hard cases. Watch the first minutes and partial output of the full run, and stop it at the first sign of failure.
- Never use a full run to test a fix. Reproduce the failure on the smallest input that shows it, fix it, pass the pilot, then start the full run again. A failure the pilot missed means the pilot lacks that kind of case: add it to the pilot before the next full run, and record it as a `Discovery:` line.
- When a migration, destructive, or state-changing step fails partway, follow the plan's retry or rollback path; without one, stop and ask rather than improvise a destructive recovery.

Plan changes:
- Do not add technology, dependencies, limits, or mechanisms the plan does not contain on your own.
- When implementation exposes a real problem in the plan, or an option outside it (yours or a reviewer's) that holds up on its merits, propose a change as one decision. Judge such an option on its merits, not by the plan's silence; drop it only with evidence that it is unsound. The decision gives: context, the problem with a concrete example, options (what changes, cost, risk, reversible or not), your recommendation with evidence, its benefit, harm and impact, and what happens next if agreed. If the user agrees, record it as a dated `Decision:` line in `Progress Log`, update the plan sections it changes, and do not rerun plan review.

## Finalization

1. Run every `Global Gates` command once, exactly as written, on final `HEAD`.
2. Run the end-to-end scenario in `Completion Criteria` on final `HEAD` and compare with its expected output. Reuse each phase's AC evidence; check only what spans phases: invariants, ownership boundaries, exclusions.
3. Self-audit integration over the cumulative diff and commit history: cross-phase interfaces and state boundaries.
4. Run the plan's final review checkpoint with `{{CLIENT_SKILL}}review-impl` on the cumulative diff; if the reviewer cannot run, self-review as in step 8 of the per-phase loop.
5. Fix defects from steps 3–4 with a narrow regression test first, then the affected phase gates. Each fix still meets the plan's criteria and changes only what the defect needs; check what depends on the changed code and other places with the same pattern, since fixes are the main source of new bugs; rerun the full suite and the end-to-end scenario only once the fixes are in. Ask before any material scope the audit uncovers; do not hide it in a repair commit.
6. Update `Completion Criteria` in the final commit, staging the plan by the same `git check-ignore` rule. Verify the worktree is clean apart from recorded unrelated changes.

## Stop conditions and reporting

Stop only for a real user decision, missing required credentials or infrastructure, irreconcilable requirements, or an irreversible action the plan does not authorize. A review stalemate is a user decision. Preserve evidence and ask one question at a time, in the decision format above.

Report phase commits, exact verification and gate results (with baseline failures), review outcomes (name every checkpoint covered only by self-review, the reviewer error, and that `{{CLIENT_SKILL}}review-impl` can be rerun on that diff once the reviewer works), user-approved plan changes, ACs `not done`, and residual risks. Never claim approval or completion without recorded evidence.
