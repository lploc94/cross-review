# Independent Analysis Template

Use this exact format for your independent code quality analysis.

```markdown
### FINDING-{N}: {Short title}
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

### Strongest Positions
- {positions you are most confident about — defend these in debate}
```

If no findings, write only `Overall Assessment` and `Strongest Positions`.

## FINDING-{N} vs ISSUE-{N}

You use `FINDING-{N}` to distinguish your findings from the reviewer's `ISSUE-{N}` during cross-analysis and final report. This prevents ID collisions in the mapping table.

## Matching Protocol (FINDING to ISSUE)

When cross-analyzing in Step 4, map your FINDING-{N} to the reviewer's ISSUE-{N}:

1. **Semantic match**: Same Category + same code location referenced = match. Wording does not need to be identical — only the same underlying problem.
2. **1-to-many**: If 1 FINDING maps to multiple ISSUEs (or vice versa), note the mapping explicitly (e.g., `FINDING-1 <> ISSUE-2, ISSUE-3`).
3. **Split/merge**: If the reviewer splits 1 issue into 2, or merges 2 into 1, record the new mapping and keep IDs stable. Do not renumber.
4. **Unmatched**: A FINDING or ISSUE with no counterpart is classified as "You-only" or "Reviewer-only".
5. **Mapping table**: Maintain one mapping table across all rounds. Each round updates the table — do not recreate from scratch.

```markdown
| Your FINDING | Reviewer ISSUE | Classification | Status |
|--------------|----------------|----------------|--------|
| FINDING-1    | ISSUE-2        | Agreement      | Agreed |
| FINDING-2    | —              | You-only       | Pending |
| —            | ISSUE-1        | Reviewer-only  | Disputed |
```
