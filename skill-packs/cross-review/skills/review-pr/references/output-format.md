# Output Format Contract

Use this exact shape:

```markdown
### ISSUE-{N}: {Short title}
- Category: bug | edge-case | security | performance | maintainability | pr-description | commit-hygiene | scope
- Severity: low | medium | high | critical
- File: {file path and line range, or "PR-level" for non-code findings}
- Problem: {clear statement}
- Evidence: {specific diff hunk, code reference, or PR metadata reference}
- Why it matters: {impact on correctness, security, maintainability, or merge readiness}

### Overall Assessment
- Code quality: poor | fair | good | excellent
- PR description accuracy: accurate | partially accurate | inaccurate | missing
- Commit hygiene: clean | acceptable | messy
- Scope appropriateness: focused | acceptable | too broad | too narrow

### VERDICT
- Status: CONSENSUS | CONTINUE | STALEMATE
- Reason: {short reason}
```

If no issues remain, return only `Overall Assessment` and `VERDICT` with `Status: CONSENSUS`.
