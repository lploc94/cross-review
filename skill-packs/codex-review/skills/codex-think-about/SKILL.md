---
name: codex-think-about
description: Peer debate between Claude Code and Codex on any technical question. Both think independently, challenge each other, converge to consensus or explicit disagreement.
---

# Codex Think About

## Purpose
Peer reasoning, not code review: Claude and Codex analyze a technical question independently, challenge each other, and converge to consensus or an explicit disagreement.

## When to Use
Before implementing: architecture choices, technology comparisons, tradeoffs.

## Sharpen the question first
Check the question for **specificity** (a clear decision or options), **context** (stack, team, constraints stated or inferable) and **debatability** (two-sided, not a factual lookup).
- All three met: use it as is if a rewrite would only be cosmetic; otherwise rewrite it.
- Missing parts inferable: inspect once (top-level listing, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `docker-compose.yml`, `.env.example`), list ambiguous signals instead of picking one, and rewrite.
- Too vague: ask at most two clarifying questions, one at a time, then rewrite.

Show the rewrite in the user's language as `Sharpened question: "…"` plus `Inferred context: …`, and ask to proceed. On "no", ask what to change once, revise, and on a second "no" continue with the best rewrite. The confirmed text becomes `QUESTION`.

## Inputs
- Round 1 placeholders: `QUESTION`, `PROJECT_CONTEXT`, `RELEVANT_FILES`, `CONSTRAINTS`.
- Reply placeholders: `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_PERSPECTIVES`, `CONTINUE_OR_CONSENSUS_OR_STALEMATE`.
- Skill `codex-think-about`, no mode. Effort `high` by default. Codex runs with network access for web research; it must not change files.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill: your analysis may use web search and documentation tools. Compare with Codex's `review.insights`, `considerations`, `recommendations` and `sources` (fallback `review.raw_markdown`), classifying genuine agreement, genuine disagreement, Claude-only and Codex-only insights, and same direction with different depth; cross-check sources. **Exit rule:** consensus once no significant disagreement remains; stalemate when the same disagreements repeat for two rounds.

**File modification guard.** Before each round record `git status --porcelain --untracked-files=all --ignored` (outside git: `find` + `stat` of the files), and compare after it. If Codex added, deleted or modified anything, stop immediately: list every changed file, tell the user Codex broke the no-modification rule, do not revert, call `review_end` without an outcome, and wait for the user.

## Completion
Report consensus points, remaining disagreements (point | Claude | Codex), recommendations, consolidated sources, open questions, and confidence. On stalemate, recommend which side to favor and ask the user.

## Rules
- Claude and Codex are analytical peers; the user's operational decisions control the debate.
- Codex must not modify project files and must cite sources for web claims. Separate researched facts (with sources) from opinions.
