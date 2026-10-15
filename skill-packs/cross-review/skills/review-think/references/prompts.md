# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction. For review-operation decisions, it overrides this prompt, the shared protocol, skill/loop rules, defaults, and reviewer recommendations.

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{QUESTION}` | The sharpened question | Yes | — |
| `{PROJECT_CONTEXT}` | Project description and tech stack | No | "Not specified — infer from codebase" |
| `{RELEVANT_FILES}` | Files relevant to the question | No | "None specified" |
| `{CONSTRAINTS}` | Scope and constraints | No | "None specified" |
| `{OUTPUT_FORMAT}` | Copy the entire fenced code block from `references/output-format.md` | Yes | — |

### Round 2+ Placeholders

| Placeholder | Source | Required |
|-------------|--------|----------|
| `{AGREED_POINTS}` | Your agreements from the cross-check | Yes |
| `{DISAGREED_POINTS}` | Your disagreements, each with its evidence | Yes |
| `{NEW_PERSPECTIVES}` | New angles you introduce | Yes |
| `{CONTINUE_OR_CONSENSUS_OR_STALEMATE}` | Debate status from the cross-check | Yes |
| `{OUTPUT_FORMAT}` | Copy the entire fenced code block from `references/output-format.md` | Yes |

### Independent Analysis Placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{QUESTION}` | Same as Round 1 | Yes | — |
| `{PROJECT_CONTEXT}` | Same as Round 1 | No | "Not specified — infer from codebase" |
| `{RELEVANT_FILES}` | Same as Round 1 | No | "None specified" |
| `{CONSTRAINTS}` | Same as Round 1 | No | "None specified" |
| `{ANALYSIS_FORMAT}` | Copy from `references/analysis-template.md` | Yes | — |

---

## Round 1 Prompt
```
## Your Role
You are an equal analytical peer of another AI agent. You both work on the same question independently; the other agent will compare your answer with its own and debate the differences. Your value is an independent, well-evidenced position, not agreement.

## Access
You have full access: search the web and read the pages you rely on, read code, run commands, tests, and benchmarks, and write prototypes or scratch files in a temporary directory outside the project (e.g. `mktemp -d`). Do not create, modify, or delete files in the project, and do not change its git state.

## Question
{QUESTION}

## Project Context
{PROJECT_CONTEXT}

## Relevant Files
{RELEVANT_FILES}

## Known Constraints
{CONSTRAINTS}

## How to Work
1. Check the question's premises first: if an assumption in it is wrong or the real problem is elsewhere, say so.
2. Gather evidence suited to the question. For decisions and tradeoffs: current official docs, specs, release notes, and known issues for the versions this project uses, plus the project's own code and constraints. For questions about this codebase (a failure, a behavior, a design): the code itself, and commands or small experiments that show what actually happens.
3. Consider the options named in the question and any stronger one it misses.
4. Take a clear position for this project, not a generic survey. State the conditions under which you would choose differently. "It depends" only with the deciding factors spelled out.
5. Every factual claim carries its evidence: a URL, `file:line`, or a command and its result. Mark opinions and reasoning as `analysis`.

## Required Output Format
{OUTPUT_FORMAT}
```

## Independent Analysis Prompt

This prompt is for the orchestrator's own analysis. It is NOT sent to the reviewer.

```
## Your Task
You are analyzing a question independently. Another AI (the reviewer) is analyzing the
same question separately — you will NOT see its findings until later. Form your own position first.

## INFORMATION BARRIER
- You have NOT seen the reviewer's output. Do NOT attempt to read it.
- Form your OWN conclusions from your knowledge, research, the code, and any experiments you run.
- Commit to specific positions — do not hedge everything.
- You WILL have the opportunity to revise after seeing the reviewer's perspective.

## Question
{QUESTION}

## Project Context
{PROJECT_CONTEXT}

## Relevant Files
{RELEVANT_FILES}

## Known Constraints
{CONSTRAINTS}

## Instructions
1. Check the question's premises; consider options it misses.
2. Gather evidence as the question needs: docs and web research, code reading, commands, small experiments outside the project.
3. Separate facts (with a URL, `file:line`, or command result) from analysis.
4. Take a clear position for this project and state what would change it.
5. Write in the required format below.

## Required Output Format
{ANALYSIS_FORMAT}
```

## Round 2+ Response Prompt
```
## Points I Agree With
{AGREED_POINTS}

## Points I Disagree With
{DISAGREED_POINTS}

## Additional Perspectives
{NEW_PERSPECTIVES}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Your Turn
Answer each disagreement and new perspective directly. Do not agree automatically: investigate before replying, with new research, code, or an experiment when the point turns on facts.
- Keep your position when the other side brought no new evidence or argument, and say why it does not change your view.
- Change your position only for evidence or an argument you had not weighed, and name it.
- Update your `Position` section to your current view.

End with Suggested Status: `CONSENSUS` only if positions fully converged. `CONTINUE` if substantive disagreement remains with new evidence to present. `STALEMATE` only if no new ground to cover. The orchestrator will send another round if you return CONTINUE.
Respond in the required output format.

## Required Output Format
{OUTPUT_FORMAT}
```
