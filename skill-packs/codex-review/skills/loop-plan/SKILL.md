---
name: loop-plan
description: Create an execution-ready, code-grounded phased implementation plan before coding. Use when a request needs discovery, explicit acceptance criteria, tests, and resumable phase boundaries.
---

# Loop Plan

Create a plan that another session can execute without guessing requirements. This skill plans only; it does not implement application code.

## Discovery and intent

1. Read applicable `CLAUDE.md`/`AGENTS.md`/repository instructions, inspect `git status`, recent history, relevant files, symbols, callers, commands, and existing tests before drafting.
2. Separate the user's target from reports, assumptions, completed work, and out-of-scope ideas. Preserve the user's expected behavior as the source of truth.
3. Find an established repository pattern for each proposed change and cite its path/symbol. Choose the smallest project-consistent design; do not add speculative abstractions or compatibility behavior.
4. Resolve ordinary engineering choices autonomously. Ask only when a material product, API, schema, dependency, compatibility, or operational decision cannot be inferred safely.

## Plan contract

Write a descriptively named `<kebab-case-summary>-plan.md` in the repository unless the user specifies another descriptive path. The filename must identify the work (for example, `implement-login-plan.md`, `migrate-auth-tokens-plan.md`, or `add-search-filters-plan.md`); never create a generic `plan.md`.

Use this exact top-level order:

```markdown
# <title>
## Plan schema
loop-plan/v1
## Target
## Scope
## Invariants
## Baseline
## Design and project patterns
## Global Gates
## Plan Review
## Phase 1: <name>
...
## Completion Criteria
## Progress Log
```

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
- [ ] AC-N: <binary observable criterion> — proven by <test or inspection>
### Focused verification
`<exact command>`
### Phase gates
`<exact command(s)>`
### Review
Implementation review is required; verdict must be APPROVE.
### Commit
`<proposed commit message>`
```

Every phase must describe code evidence, the observable contract, production obligations separately from tests, failure/boundary/state cases where relevant, an oracle that rejects the plausible naive implementation, exact commands and expected outcomes, and a single cohesive commit boundary.

## Quality and review

- Acceptance criteria are binary and map to tests or concrete inspection evidence.
- Include repository regression gates, not only focused tests.
- Document dependencies, ownership boundaries, invariants, and explicit exclusions.
- Record completed baseline work so `loop-implement` does not repeat it.
- After drafting, perform an intent-fidelity review: verify the plan still produces the user's requested outcome and has no accidental scope expansion.
- Perform a plan self-review for stale paths, missing integration, weak or overfit tests, phase sizing, and resumability. Set `Plan Review` to `APPROVE` only after this review is complete; otherwise leave it `pending` and do not authorize implementation.

## Handoff

End with a concise expectation check: summarize the implementation story, key design decision, material assumptions, exact descriptive plan path, phase count, and review status. Invite correction before `/loop-implement` starts. Do not modify production code.
