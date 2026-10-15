---
name: review-think
description: Peer debate with an external reviewer model (Codex CLI by default) on any technical question. Both think independently, challenge each other, converge to consensus or explicit disagreement.
---

# Think About

## Purpose
Peer reasoning, not code review: you and the reviewer analyze a technical question independently, challenge each other, and converge to consensus or an explicit disagreement. Both sides may research, read code, run commands, and try things out to check a claim.

## When to Use
- Decisions and tradeoffs: architecture, technology choice, design, approach.
- Investigations: why something fails, how a system behaves, whether a design holds up, what a change would break.
- Any reasoning you want challenged before acting on it.

Not for reviewing a written plan (`review-plan`), uncommitted changes, commits, or a branch (`review-impl`), or a PR (`review-pr`). When the request is one of those, say so and use that skill unless the user wants a debate.

## Sharpen the question first
Turn the request into a question with a clear decision or target, the context it depends on (stack, constraints, what was tried), and what a useful answer looks like. Infer missing context from the conversation and, when needed, the repository; list ambiguous signals instead of picking one. Do not ask the user to confirm the rewrite; ask only when the target cannot be inferred at all. Show `Sharpened question: "…"` in the user's language as you start. That text becomes `QUESTION`.

## Inputs
- Round 1 placeholders: `QUESTION`, `PROJECT_CONTEXT`, `RELEVANT_FILES`, `CONSTRAINTS`.
- Reply placeholders: `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_PERSPECTIVES`, `CONTINUE_OR_CONSENSUS_OR_STALEMATE`.
- Skill `review-think`, no mode. The reviewer runs with full access (web, commands, scratch files outside the project); it must not change project files.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill:
- Write your independent analysis to `<session_dir>/analysis.md` before your first `review_wait`; the debate compares against that file.
- Your analysis may use web search, documentation tools, code reading, and experiments. Compare your `Position` with the reviewer's `review.position`, then `insights`, `considerations`, `recommendations` and `sources` (fallback `review.raw_markdown`), classifying genuine agreement, genuine disagreement, insights only you or only the reviewer raised, and same direction with different depth; cross-check sources and evidence.
- **Exit rule:** consensus once no significant disagreement remains; stalemate when the same disagreements repeat for two rounds. A point one side gave up without new evidence or argument is not consensus; restate it as a disagreement.

## Completion
Lead with the answer: your recommendation for the user's situation, confidence, and why. Then consensus points, remaining disagreements (point | you | reviewer), positions either side changed and the evidence that changed them, open questions, and consolidated sources. On stalemate, recommend which side to favor and ask the user. Write the same report to `<session_dir>/summary.md`.

## Rules
- You and the reviewer are analytical peers; the user's operational decisions control the debate.
- The reviewer must not modify project files. Claims carry their evidence: a URL, `file:line`, or a command and its result; separate facts from opinions.
