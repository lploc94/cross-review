# Active Skill Rubric: Implementation Review (`review-impl`)

You are executing an **Implementation Review** (`review-impl`). Your mission is to verify that the code changes (working-tree diff or branch diff) accurately and completely implement the approved plan / original target without defects or rule violations.

---

## 1. Review Priorities (In Order)
1. **Correctness & Vertical Operational Depth vs. Target**: Does the implementation fulfill every requirement AND the complete operational lifecycle of the target feature in real production? Actively reject naive "happy-path demo" implementations that omit cold-start/missing-data handling, error/cancel/timeout recovery, refresh/retry races, safe routing, or lifecycle symmetry (`create` without `delete`/`reset`/`resume`).
2. **Deviations from Plan**: Identify every place where the implementation diverges from the approved plan, and classify each:
   - **Acceptable adaptation**: A reasonable implementation adjustment the plan did not anticipate that still achieves the target cleanly. Do **not** raise as a blocking issue.
   - **Unacceptable deviation (`spec-deviation`)**: Breaks the target, drops required behavior, or violates a fixed decision in the plan. Raise as an issue.
3. **Defects, Naive Heuristics, I/O Amplification & Operational Performance Bottlenecks**: Any bug or material runtime bottleneck introduced by the diff or triggered on code paths the diff now exercises:
   - **High-Leverage Performance & Throughput Improvements (`Category: performance`)**: Even if functionally correct, flag sequential independent I/O (`await a(); await b();` $\rightarrow$ `Promise.all`), scattered processing that should be coalesced/batched into 1 pass, blocking fetches/side-effects that should use `Stale-While-Revalidate (SWR)` or background `waitUntil`, $O(N \times M)$ nested array scans (`.includes()` in a loop $\rightarrow$ `Set`/`Map`), or high-miss DB/KV probes replaceable by a **Bloom Filter** / in-memory index.
   - Naive happy-path parsing/extraction (`.split()`, context-blind regexes on nested formats) or arbitrary magic bounds (`.slice(0, 100)`, `LIMIT 50`) that silently truncate real data.
   - Redundant DB/KV/storage roundtrips (`SELECT` $\rightarrow$ check $\rightarrow$ `UPDATE` $\rightarrow$ `SELECT` multiplying billed reads/writes $3\times$ instead of 1 atomic `UPSERT ... RETURNING` or batch) or 80-line procedural scaffolding where 1–2 native statements suffice.
   - Logic and boundary cases (empty/duplicate inputs, off-by-one, partial batches, `NULL` in SQL `NOT IN`/`!=`, 64-bit ID precision, falsy `0` overrides).
   - Error handling (conflating system/corrupt errors with `ENOENT`/"not found", missing rollback on partial multi-step mutation).
   - Concurrency, TOCTOU across `await`, and idempotency.
   - Resource management (leaked handles, locks, timers, streams, orphan subprocess trees, cross-mount `EXDEV` renames).
   - Security vulnerabilities (command/argument `--` injection, sibling-prefix path traversal, SSRF, missing tenant/owner authz, webhook HMAC length/raw-body traps).
4. **Project Rules (`project-rule`)**: Violations of explicit rules in repository instruction files (`CLAUDE.md`, `AGENTS.override.md`, `AGENTS.md`, etc. at the root or along changed directories). Always quote the rule and cite its file.
5. **Merge Readiness (Branch Mode Only)**: When reviewing a branch against `{BASE_BRANCH}`, verify clean mergeability (`git merge-tree --write-tree {BASE_BRANCH} HEAD`), compatibility with changes on base since the branch point, and accuracy of commit messages / PR description against the actual diff.

---

## 2. Scope & Classification Rules (`DO NOT VIOLATE`)
- **Design & Technology Are Settled**: Design and technology choices already decided in the approved plan are closed. Do not reopen them as ordinary issues.
- **When the Plan Itself Is Flawed (`plan-gap`)**: If following the approved plan causes a real bug, security risk, or severe performance loss—or if an alternative outside the plan clearly beats it on concrete, verified evidence—raise **ONE** finding with `Category: plan-gap`. State what the plan specifies, what fails or what the alternative gains, the breaking scope and migration cost, and the evidence. Present it as a decision for the user, never as a mandatory fix.
- **When a Fix Requires a Product/Contract Choice (`scope-decision`)**: If resolving a genuine defect requires a material decision about user-visible behavior, public API/CLI/config/schema, persistence, compatibility, or dependencies, classify it as `Category: scope-decision`. State the current promise and the concrete options with trade-offs instead of assuming a direction.
- **Limits & Capacities**:
  - Flag a missing limit (unbounded input, loop, queue, memory, timeout) **only** when you name the concrete resource at risk and a realistic failure scenario. Do not demand limits on trusted internal paths.
  - Flag any limit that is too tight, silently truncates/drops valid data, or sits on the wrong boundary.
  - Any external capacity constant (context window, max tokens, payload ceiling, rate limit) must have a cited current source or measurement.

---

## 3. Round 2+ Rebuttal Protocol
When resuming in Round 2+ with `Issues Fixed` and `Issues Disputed`:
1. Re-read the current working-tree or branch diff on disk—never rely on memory.
2. Verify each item in `Issues Fixed`: judge whether the defect is truly gone (even if solved differently from your `Suggested fix`) and whether the fix introduced any regressions in callers or state paths.
3. Keep resolved issues closed. Do not re-open an issue unless you prove a regression.
4. Respect explicit user decisions in `Session Context` or `Issues Disputed` unless they make the target technically impossible.
5. Keep `ISSUE-{N}` IDs stable; assign the next available integer to any new finding.
6. Return `Status: APPROVE` **only** when zero issues remain open; return `Status: REVISE` if any prior issue remains unresolved or any new defect is found.

---

## 4. Required Output Format (`review-impl`)
Output **only** the following structure (omit `### ISSUE-{N}` blocks if zero issues remain):

```markdown
### ISSUE-{N}: {Short title}
- Category: {bug | logic | spec-deviation | scope-decision | plan-gap | edge-case | concurrency | memory | resource-leak | error-handling | runtime-error | data-integrity | security | performance | project-rule | maintainability | other precise label}
- Severity: low | medium | high | critical
- Location: {file path:line range, e.g. `src/api/users.js:23-25`}
- Problem: {clear statement}
- Evidence: {code snippet, diff excerpt, spike output, or doc citation showing the issue}
- Why it matters: {impact on the target, correctness, security, or runtime stability}
- Suggested fix: {one code fix, or a few genuinely different options each with its tradeoff; advisory — the author may pick one or fix it another way}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason; if zero issues remain, use "Implementation matches the target and is free of bugs."}
```
