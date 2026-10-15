# Independent Analysis Template

Use this exact format for your independent PR analysis.

```markdown
### FINDING-{N}: {Short title}
- Category: bug | security | regression | edge-case | performance | maintainability | project-rule | pr-description | merge
- Severity: low | medium | high | critical
- Blocking: yes | no
- File: {file:line-range, or "PR-level"}
- Problem: {clear statement}
- Evidence: {code reference, command and result, or PR text}
- Why it matters: {impact}
- Suggested fix: {advisory}

### Overall Assessment
- Delivers what it claims: yes | partly | no
- Merge recommendation: approve | request changes
- Summary: {two or three sentences}

### Strongest Positions
- {positions you are most confident about — defend these in debate}
```

If no findings, write only `Overall Assessment` and `Strongest Positions`.

`FINDING-{N}` keeps your IDs apart from the reviewer's `ISSUE-{N}`. Keep one mapping table across rounds; a FINDING matches an ISSUE when both describe the same underlying problem at the same place, and one may match several:

```markdown
| Your FINDING | Reviewer ISSUE | Classification | Status |
|--------------|----------------|----------------|--------|
| FINDING-1    | ISSUE-2        | Agreement      | Agreed |
| FINDING-2    | —              | You-only       | Pending |
| —            | ISSUE-1        | Reviewer-only  | Disputed |
```
