# Output Format Contract

Use this exact shape:

```markdown
### ISSUE-{N}: {Short title}
- Category: bug | security | regression | edge-case | performance | maintainability | project-rule | naive-heuristic | arbitrary-bound | over-restrictive-guard | false-assurance | pr-description | merge
- Severity: low | medium | high | critical
- Blocking: yes | no — yes when the PR should not merge until it is fixed
- File: {file:line-range, or "PR-level"}
- Problem: {clear statement}
- Evidence: {code reference, command and result, or PR text}
- Why it matters: {impact on users, correctness, security, or the codebase}
- Suggested fix: {one fix, or a few genuinely different options each with its tradeoff; advisory — the author may fix it another way}

### Decision Ledger
| Decision point | Source | Counter-examples tried (miss side / block side) | Result |
|---|---|---|---|
| {`file:line`} | {where its shape or number comes from} | {what was tried} | {grounded and holds / fails: ISSUE-N} |

### Overall Assessment
- Delivers what it claims: yes | partly | no
- Merge recommendation: approve | request changes
- Summary: {two or three sentences}

### VERDICT
- Status: CONSENSUS | CONTINUE | STALEMATE
- Reason: {short reason}
```

If no issues remain, return only `Decision Ledger`, `Overall Assessment` and `VERDICT`. With no decision point in the PR, the ledger is the single line `None in this change`.
