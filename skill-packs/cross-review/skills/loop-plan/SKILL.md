---
name: loop-plan
description: Create an execution-ready, code-grounded phased implementation plan before coding. Only for large work - several features, many files or components, or work spanning sessions that needs resumable phase boundaries. Not for small fixes or single-feature changes; do those directly.
---

# Loop Plan

Create a plan that a fresh session, with only the repository and this file, can execute without guessing: nothing relies on this conversation, and each project-specific term is explained where first used. This skill plans only; it does not implement application code. Spikes live only under `.cross-review/spikes/<plan-name>/`.

Use it for large work: several features, many files or components, or work that spans sessions. For a small fix or a single-feature change, a phased plan and its reviews cost more time than they save: tell the user, and suggest doing it directly with tests (and `{{CLIENT_SKILL}}review-impl` if they want a review). Plan it only if the user still asks.

## Discovery and intent

1. Read applicable {{CLIENT_INSTRUCTIONS}}/repository instructions, inspect `git status`, recent history, relevant files, symbols, callers, commands, and existing tests before drafting.
2. Separate the user's target from reports, assumptions, completed work, and out-of-scope ideas. Preserve the user's expected behavior as the source of truth.
3. For each proposed change, cite the repository pattern (path/symbol) and the current established standard for the problem (a current source). When the repository pattern is itself the tangled part, present two options, patch within it or move to the standard, as a user decision. Otherwise choose the smallest project-consistent design, reusing existing helpers by name (a new helper states why they do not fit); do not add speculative abstractions or compatibility behavior.
4. Spike every technical assumption you have not seen work here (library API, platform behavior, external capacity, performance) in `.cross-review/spikes/<plan-name>/`, and record it in `Feasibility evidence`.
5. Resolve assumptions at plan time, by spike or by asking the user. The plan handed to implementation must not contain hard stops that depend on something nobody can verify; record what remains as an assumption with a default and a fallback. Hard stops are only for data loss, security, or irreversible actions.
6. Resolve ordinary engineering choices autonomously. Ask only when a material product, API, schema, dependency, compatibility, or operational decision cannot be inferred safely.

## Limits

Only when the plan sets or depends on a limit:
- Correctness validation (rejecting bad input) is not a capacity limit; keep them apart.
- Each capacity limit states the protected resource, the failure it prevents, why that number (a real ceiling, a measurement, or well above the largest normal load), and the soft handling when reached (continue in parts, backpressure, signalled degradation). Never truncate or drop silently.
- External capacity (context size, rate limits, body size, quotas) comes from a current source or a measurement, with source and date.

## Plan contract

Write a descriptively named `<kebab-case-summary>-plan.md` in the repository unless the user specifies another descriptive path; the name identifies the work (for example `migrate-auth-tokens-plan.md`), never a generic `plan.md`.

Use this exact top-level order:

```markdown
# <title>
## Plan schema
loop-plan/v1
## Target
## Scope
## Invariants
## Fixed decisions
## Baseline
## Design and project patterns
## Feasibility evidence
## Capacity
## Global Gates
## Review checkpoints
## Plan Review
## Phase 1: <name>
...
## Completion Criteria
## Progress Log
```

- `Fixed decisions`: choices implementation must not change on its own (technology, dependency, interface, limit), each with its reason.
- `Baseline`: completed work, and the real duration of each gate command.
- `Feasibility evidence`: assumption | spike or source | result | date.
- `Capacity`: the limits described under Limits, or `N/A`.
- `Review checkpoints`: which phases end with `{{CLIENT_SKILL}}review-impl` and why (after phases that build a contract, schema, migration, state, or money flow), plus one final checkpoint on the cumulative diff. Name a model per checkpoint when the user wants one.
- `Completion Criteria`: the whole-plan outcome, including at least one end-to-end scenario on the real entry point (CLI, server, UI, installer) with its exact command and expected output.
- `Progress Log`: written during implementation: one line per finished phase, dated `Decision:` lines for approved plan changes, and `Discovery:` lines for surprises that shaped the work, each with evidence.

Repeat the complete phase block for every phase, in dependency order:

```markdown
## Phase N: <name>
### Goal
### Current behavior and gap
### Evidence
### Pattern
### Dependencies
### Files and symbols
### Behavioral contract
### Documentation
### Tests first
### Anti-shortcut coverage
### Implementation obligations
### Acceptance criteria
- [ ] AC-N: <binary observable criterion> — proven by <test, real run, or inspection>
### Focused verification
`<exact narrow command per AC>`
### Phase gates
`<light command(s) for the affected area>`
### Review
Checkpoint: `{{CLIENT_SKILL}}review-impl` | None (covered by the checkpoint after Phase M)
### Commit
`<proposed commit message>`
```

Every phase must describe code evidence, the observable contract, production obligations separately from tests, failure/boundary/state cases where relevant, for a migration, destructive, or state-changing step whether rerunning it is safe and its retry or rollback path, an oracle that rejects the plausible naive implementation, exact commands and expected outcomes, and a single cohesive commit boundary. Test ladder: a narrow command per AC, light phase gates, and the full suite only in `Global Gates`.

## Quality and review

- Document dependencies, ownership boundaries, invariants, and explicit exclusions. Record completed baseline work so `{{CLIENT_SKILL}}loop-implement` does not repeat it.
- Before handoff, check: every AC is binary, with a narrow command and a test or a run against the real system (inspection only where neither can show it); every risky assumption has `Feasibility evidence` or a user decision; the end-to-end scenario exists.
- `Plan Review` stays `pending` until `{{CLIENT_SKILL}}review-plan` returns APPROVE or the user approves; then write `APPROVE (review-plan <session id>, <date>)` or `APPROVE (user, <date>)`.

## Talking with the user

Stop briefly three times; the goal is that the user understands, not that they read a lot:
1. After discovery: restate the target, what is out of scope, and the assumptions; invite correction.
2. After spikes, before writing phases: the main design decisions, especially patch versus standard and breaking changes.
3. Handoff: the implementation story in plain words, the review checkpoints, remaining risks, the exact plan path, phase count, and review status. Ask whether to run `{{CLIENT_SKILL}}review-plan` or whether the user approves directly, and invite correction before `{{CLIENT_SKILL}}loop-implement` starts.

Present each decision on its own, in the user's language, explaining any term you must use:
1. Context: what this part of the system does today, in 1–3 sentences.
2. Problem: what happens if it is left as is, with a concrete example the user can see.
3. Options: for each, what changes, what it costs (time, scope, breaking), its risk, and whether it can be reversed.
4. Recommendation and why, tied to evidence (spike, source, data), with its benefit, its harm if any, and its concrete impact.
5. If agreed, what happens next: scope, files or areas changed, what stays the same.

Silence or a generic "ok" approves nothing that was not presented. Do not modify production code.
