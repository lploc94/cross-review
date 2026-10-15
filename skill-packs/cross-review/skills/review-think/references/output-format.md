# Per-Round Reviewer Output Contract

Use this exact shape:

This schema is for each reviewer round output. The final user-facing synthesis uses a different format (see SKILL.md §9).

```markdown
### Key Insights
- [insight] — Source: [URL or "analysis"]
- ...

### Considerations
- [consideration] — Source: [URL or "analysis"]
- ...

### Recommendations
- ...

### Sources
| # | URL | Description |
|---|-----|-------------|
| 1 | https://... | Official docs for X |
| 2 | https://... | Benchmark comparison |

### Open Questions
- ...

### Confidence Level
- low | medium | high

### Suggested Status (advisory)
- CONTINUE | CONSENSUS | STALEMATE
```
