# Per-Round Reviewer Output Contract

Use this exact shape:

This schema is for each reviewer round output. The final user-facing report uses a different format (see SKILL.md Completion).

```markdown
### Position
- [your recommendation or conclusion for this project, in one or two sentences, and what would change it]

### Key Insights
- [insight] — Source: [URL, file:line, command result, or "analysis"]
- ...

### Considerations
- [trade-off or risk] — Source: [URL, file:line, command result, or "analysis"]
- ...

### Recommendations
- ...

### Sources
| # | Source | Description |
|---|--------|-------------|
| 1 | https://... | Official docs for X |
| 2 | src/x.js:42 | Where Y is decided |

### Open Questions
- ...

### Confidence Level
- low | medium | high

### Suggested Status (advisory)
- CONTINUE | CONSENSUS | STALEMATE
```
