# Output Format Contract

> **ISSUE-{N} IDs must remain stable across rounds.** Do not renumber issues. New findings in later rounds use the next available number.

> **Note**: `Category` is open-ended — use the value that best names the defect. Common values: `bug`, `logic`, `spec-deviation`, `scope-decision`, `edge-case`, `concurrency`, `memory`, `resource-leak`, `error-handling`, `runtime-error`, `data-integrity`, `security`, `performance`, `maintainability`. If none fit, use the most precise short label for the defect class you found. Use `spec-deviation` for places the implementation diverges from the plan/target. Use `scope-decision` when a valid defect cannot be resolved without a material user-owned contract or scope decision. Use `plan-gap` when the approved plan itself causes a bug, a performance loss, or a real risk, or when an option outside the plan clearly beats it on evidence. Reserve `maintainability` for cases where a real bug or stated acceptance criterion is at stake — do NOT use it for style/preference or over-engineering suggestions. For plan review categories (correctness, architecture, sequencing, risk, scope), see review-plan.

Use this exact shape (copy the entire block below as `{OUTPUT_FORMAT}`):

```markdown
### ISSUE-{N}: {Short title}
- Category: {bug | logic | spec-deviation | scope-decision | plan-gap | edge-case | concurrency | memory | resource-leak | error-handling | runtime-error | data-integrity | security | performance | maintainability | other precise label}
- Severity: low | medium | high | critical
- Location: {file path:line range, e.g. `src/api/users.js:23-25`}
- Problem: {clear statement}
- Evidence: {code snippet or diff excerpt showing the issue}
- Why it matters: {impact on the target, correctness, security, or runtime stability}
- Suggested fix: {concrete code change}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason}
```

**spec-deviation guidance**: When raising a `spec-deviation`, state in "Why it matters" whether the deviation makes the target wrong/unachievable (raise it) versus an acceptable adaptation (only note it — prefer not raising acceptable deviations as blocking issues).

**Zero-issue rule**: If no issues remain, omit all ISSUE blocks and return only the VERDICT block with `Status: APPROVE` and `Reason: Implementation matches the target and is free of bugs.`
