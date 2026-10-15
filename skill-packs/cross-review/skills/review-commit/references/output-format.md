# Output Format Contract

Use this exact shape:

```markdown
### ISSUE-{N}: {Short title}
- Category: bug | edge-case | security | performance | maintainability | commit-message
- Severity: low | medium | high | critical
- Commit: {SHA and subject — required for last mode, "staged" for staged mode}
- Location: {file:line-range}
- Problem: {clear statement}
- Evidence: {specific code snippet or diff reference}
- Why it matters: {impact on correctness, security, performance, or maintainability}
- Suggested fix: {description of how to fix — NOT a patch}

### Overall Assessment
- Code quality: poor | fair | good | excellent
- Security posture: no concerns | minor concerns | significant concerns
- Test coverage impression: adequate | gaps identified | insufficient
- Maintainability: poor | fair | good | excellent

### VERDICT
- Status: CONSENSUS | CONTINUE | STALEMATE
- Reason: {short reason}
```

If no issues remain, return only `Overall Assessment` and `VERDICT` with `Status: CONSENSUS`.
