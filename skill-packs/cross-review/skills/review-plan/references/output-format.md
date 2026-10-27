# Output Format Contract

> **ISSUE-{N} IDs must remain stable across rounds.** Do not renumber issues. New findings in later rounds use the next available number.

> **Note**: Categories below are plan-specific (correctness, architecture, sequencing, risk, scope). For code review categories (bug, security, performance, etc.), see review-impl.

Use this exact shape (copy the entire block below as `{OUTPUT_FORMAT}`):

```markdown
### ISSUE-{N}: {Short title}
- Category: correctness | architecture | sequencing | risk | scope
- Severity: low | medium | high | critical
- Plan section: {heading or line range in plan file}
- Problem: {clear statement}
- Evidence: {quote or reference from plan that shows the issue}
- Why it matters: {impact}
- Suggested fix: {one plan-level fix, or a few genuinely different options each with its tradeoff; advisory — the author may pick one or fix it another way}

### Decision Ledger
| Decision point | Source | Counter-examples tried (miss side / block side) | Result |
|---|---|---|---|
| {plan section} | {where its shape or number comes from} | {what was tried} | {grounded and holds / fails: ISSUE-N} |

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason}
```

**Decision points**: every regex, parser, guard, bound, default, timeout, retry and test oracle the plan specifies gets one ledger row; an ungrounded one is an ISSUE with `Category: correctness` and a title that starts with the decision point. With none, the ledger is the single line `None in this change`.

**Zero-issue rule**: If no issues remain, omit all ISSUE blocks and return the Decision Ledger and the VERDICT block with `Status: APPROVE` and `Reason: Plan is complete, well-structured, and addresses all acceptance criteria.`
