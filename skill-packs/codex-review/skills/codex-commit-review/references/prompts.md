# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction. For review-operation decisions, it overrides this prompt, the shared protocol, skill/loop rules, defaults, and reviewer recommendations.

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{DIFF_CONTEXT}` | Diff command (staged: `git diff --cached`; last: `git diff HEAD~N..HEAD`) | Yes | — |
| `{FILES_CHANGED}` | List of files changed (staged: `git diff --cached --name-only`; last: `git diff HEAD~N..HEAD --name-only`) | Yes | — |
| `{USER_REQUEST}` | User's task/request description | No | "Review committed code quality" |
| `{SESSION_CONTEXT}` | Structured context block (see schema below) | No | "Not specified" |
| `{PROJECT_CONTEXT}` | Discovered project context from Step 3 (linters, test frameworks, language, CI) | No | "None discovered — use general best practices" |
| `{OUTPUT_FORMAT}` | Copy entire fenced code block from `references/output-format.md` | Yes | — |
| `{CLAUDE_ANALYSIS_FORMAT}` | Copy entire fenced code block from `references/claude-analysis-template.md` | Yes (Claude analysis only) | — |

### Last-mode additional placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{COMMIT_LIST}` | Formatted list: `<SHA> <subject>` per commit | Yes (last mode) | — |

### Round 2+ additional placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{AGREED_POINTS}` | Findings both Claude and Codex agree on (merged descriptions) | Yes | — |
| `{DISAGREED_POINTS}` | Findings where Claude and Codex disagree (both positions) | Yes | — |
| `{NEW_FINDINGS}` | Claude-only or Codex-only findings not yet discussed | Yes | — |
| `{CONTINUE_OR_CONSENSUS_OR_STALEMATE}` | Current debate status with reasoning | Yes | — |

### SESSION_CONTEXT Schema

When user provides context or Claude can infer it, format as:

```
Tech stack: {languages, frameworks, key libraries}
Review scope: {staged | last N commits}
Project context: {e.g. "monorepo with shared packages", "microservice handling payments"}
Constraints: {e.g. "performance-critical path", "public API surface"}
Assumptions: {e.g. "this is a hotfix for production issue"}
```

---

## Staged Review Prompt (Round 1)
```
## Your Role
You are Codex acting as an equal peer reviewer of code changes. Another reviewer (Claude) is independently analyzing the same changes — you will debate afterward.

## Task
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Files Changed
{FILES_CHANGED}

## How to Inspect Changes
Run `{DIFF_CONTEXT}` to read the staged diff. Review the actual code changes for quality issues.

## Project Context
{PROJECT_CONTEXT}

## Instructions
1. Focus on code quality: bugs, edge cases, security vulnerabilities, performance issues, maintainability problems.
2. Read the staged diff thoroughly. Check every changed file.
3. For each issue found, specify the exact file and line range.
4. Commit message quality is secondary — only flag if egregiously bad.
5. Provide a suggested fix description (NOT a patch) for each issue.
6. Use EXACT output format below.
7. You may run commands to verify claims (tests, builds, `curl`, `npm view`, `git fetch`). Do not modify, stage, or commit project files; put any scratch files in a fresh `mktemp -d` directory outside the repository.

## Required Output Format
{OUTPUT_FORMAT}
```

## Last Review Prompt (Round 1)
```
## Your Role
You are Codex acting as an equal peer reviewer of code changes. Another reviewer (Claude) is independently analyzing the same changes — you will debate afterward.

## Task
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Commits to Review
{COMMIT_LIST}

## Files Changed
{FILES_CHANGED}

## How to Inspect Changes
- For each commit, run `git show <SHA>` to see its individual diff.
- Also run `{DIFF_CONTEXT}` for aggregate diff context.
- Review the actual code changes for quality issues.

## Project Context
{PROJECT_CONTEXT}

## Instructions
1. Focus on code quality: bugs, edge cases, security vulnerabilities, performance issues, maintainability problems.
2. Inspect EACH commit's diff individually — do not rely on aggregate diff alone.
3. For each issue found, specify the exact file and line range.
4. Commit message quality is secondary — only flag if egregiously bad.
5. In Evidence field, always reference the specific commit SHA and subject.
6. Provide a suggested fix description (NOT a patch) for each issue.
7. Use EXACT output format below.
8. You may run commands to verify claims (tests, builds, `curl`, `npm view`, `git fetch`). Do not modify, stage, or commit project files; put any scratch files in a fresh `mktemp -d` directory outside the repository.

## Required Output Format
{OUTPUT_FORMAT}
```

## Claude Independent Analysis Prompt — Staged mode
```
## Your Task
You are reviewing code changes independently. Codex is reviewing the same changes separately — you will NOT see their findings until later.

## INFORMATION BARRIER
- Do NOT read $SESSION_DIR/review.md or any Codex output.
- Form your OWN conclusions based on the diff and code.
- Commit to specific positions.

## Files Changed
{FILES_CHANGED}

## How to Inspect Changes
Run `{DIFF_CONTEXT}` to read the staged diff. Review the actual code changes for quality issues.

## Project Context
{PROJECT_CONTEXT}

## Instructions
1. Focus on code quality: bugs, edge cases, security vulnerabilities, performance issues, maintainability problems.
2. Read the diff thoroughly. Check every changed file.
3. For each finding, specify the exact file and line range.
4. Commit message quality is secondary — only flag if egregiously bad.
5. Provide a suggested fix description (NOT a patch) for each finding.
6. Write in the required format below.

## Required Output Format
{CLAUDE_ANALYSIS_FORMAT}
```

## Claude Independent Analysis Prompt — Last mode
```
## Your Task
You are reviewing code changes independently. Codex is reviewing the same changes separately — you will NOT see their findings until later.

## INFORMATION BARRIER
- Do NOT read $SESSION_DIR/review.md or any Codex output.
- Form your OWN conclusions based on the diff and code.
- Commit to specific positions.

## Commits to Review
{COMMIT_LIST}

## Files Changed
{FILES_CHANGED}

## How to Inspect Changes
- For each commit, run `git show <SHA>` to see its individual diff.
- Also run `{DIFF_CONTEXT}` for aggregate diff context.
- Review the actual code changes for quality issues.

## Project Context
{PROJECT_CONTEXT}

## Instructions
1. Focus on code quality: bugs, edge cases, security vulnerabilities, performance issues, maintainability problems.
2. Inspect EACH commit's diff individually — do not rely on aggregate diff alone.
3. For each finding, specify the exact file and line range.
4. Commit message quality is secondary — only flag if egregiously bad.
5. In Evidence field, always reference the specific commit SHA and subject.
6. Provide a suggested fix description (NOT a patch) for each finding.
7. Write in the required format below.

## Required Output Format
{CLAUDE_ANALYSIS_FORMAT}
```

## Response Prompt — Staged mode (Round 2+)
```
## Session Context
{SESSION_CONTEXT}

## Project Context
{PROJECT_CONTEXT}

## Points We Agree On
{AGREED_POINTS}

## Points We Disagree On
{DISAGREED_POINTS}

## New Findings
{NEW_FINDINGS}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Instructions
1. Re-read the staged diff: run `{DIFF_CONTEXT}`.
2. Address disagreements with evidence from the code.
3. Provide suggested fixes for agreed issues — NOT patches.
4. Keep ISSUE-{N} numbering stable. New findings use the next available number.
5. Use EXACT output format. You MUST include a VERDICT block.
6. Respond with RESPONSE-{N} blocks. End with VERDICT: `CONSENSUS` only if all disagreements resolved. `CONTINUE` if any point still disputed. `STALEMATE` only if you have no new evidence to add. Claude will send another round if you return CONTINUE.

## Required Output Format
{OUTPUT_FORMAT}
```

## Response Prompt — Last mode (Round 2+)
```
## Session Context
{SESSION_CONTEXT}

## Project Context
{PROJECT_CONTEXT}

## Commits in Scope
{COMMIT_LIST}

## Points We Agree On
{AGREED_POINTS}

## Points We Disagree On
{DISAGREED_POINTS}

## New Findings
{NEW_FINDINGS}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Instructions
1. Re-read each commit's diff: run `git show <SHA>` for each commit in the review. Also run `{DIFF_CONTEXT}` for aggregate context.
2. Address disagreements with evidence from the code.
3. In Evidence, always reference specific commit SHA and subject.
4. Provide suggested fixes for agreed issues — NOT patches.
5. Keep ISSUE-{N} numbering stable. New findings use the next available number.
6. Use EXACT output format. You MUST include a VERDICT block.
7. Respond with RESPONSE-{N} blocks. End with VERDICT: `CONSENSUS` only if all disagreements resolved. `CONTINUE` if any point still disputed. `STALEMATE` only if you have no new evidence to add. Claude will send another round if you return CONTINUE.

## Required Output Format
{OUTPUT_FORMAT}
```
