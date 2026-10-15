# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction. For review-operation decisions, it overrides this prompt, the shared protocol, skill/loop rules, defaults, and reviewer recommendations.

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{PR_TITLE}` | `gh pr view --json title`, or the branch name | No | "Not provided" |
| `{PR_DESCRIPTION}` | `gh pr view --json body`, plus linked issues | No | "Not provided" |
| `{BASE_BRANCH}` | The base it merges into, e.g. `origin/main` | Yes | — |
| `{HEAD_REF}` | The PR head SHA (`headRefOid`, or `git rev-parse <branch>`) | Yes | — |
| `{COMMIT_LIST}` | `git log --oneline {BASE_BRANCH}..{HEAD_REF}` | Yes | — |
| `{USER_REQUEST}` | What the user wants from this review | No | "Review this PR for correctness and merge readiness" |
| `{SESSION_CONTEXT}` | Tech stack, review discussion and decisions, worktree path | No | "Not specified" |
| `{OUTPUT_FORMAT}` | Copy entire fenced code block from `references/output-format.md` | Yes | — |
| `{ANALYSIS_FORMAT}` | Copy entire fenced code block from `references/analysis-template.md` | Yes (independent analysis only) | — |

### Round 2+ additional placeholders

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{AGREED_POINTS}` | Findings both sides agree on | Yes | — |
| `{DISAGREED_POINTS}` | Findings the sides disagree on (real, severity, or blocking), both positions with evidence | Yes | — |
| `{NEW_FINDINGS}` | Findings raised by only one side, not yet discussed | Yes | — |
| `{CONTINUE_OR_CONSENSUS_OR_STALEMATE}` | Current debate status with reasoning | Yes | — |

---

## PR Review Prompt (Round 1)
```
## Your Role
You are a peer reviewer of a pull request someone else wrote. Another reviewer is reviewing it independently; you will reconcile afterwards. Your findings become review comments to the PR's author, so each must be real, specific, and worth the author's time.

## PR
- Title: {PR_TITLE}
- Base: {BASE_BRANCH}
- Head: {HEAD_REF}

## Description
{PR_DESCRIPTION}

## Commits
{COMMIT_LIST}

## Review Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## How to Inspect
- The change: `git diff {BASE_BRANCH}...{HEAD_REF}`; per commit: `git show <sha>`; a file as of the PR: `git show {HEAD_REF}:<path>`.
- Merge check: `git merge-tree --write-tree {BASE_BRANCH} {HEAD_REF}` (conflicts), and whether the change still fits what the base gained since the branch point.
- Run tests or builds only in the worktree named in Session Context, if any.

## What to Review (in priority order)
1. **Delivers what it claims**: the description and linked issues against the diff. Missing or incomplete parts, and claims the code does not back.
2. **Defects** of any class in the changed code: logic and boundary cases, error handling, concurrency and ordering, resources, data integrity and persistence, security, runtime errors, regressions in behavior callers rely on, and performance regressions that matter.
3. **Project rules**: the change breaks a rule in the repository's instruction files (CLAUDE.md, AGENTS.md, CONTRIBUTING, or similar at the root or in a changed file's directory or its parents). Quote the rule and its file.
4. **Merge**: conflicts with the base, or a break against what the base changed since.

## What Counts as an Issue
- This PR causes it: the changed code is wrong, or the change relies on existing code that breaks on the path it now uses. A problem in code the PR does not touch or rely on is out of scope.
- Before calling something wrong, check whether the description, the review discussion in Session Context, or the code itself (a comment, a test) shows it is intentional. An intentional choice is an issue only if it breaks what the PR claims or a project rule.
- Read the surrounding code and callers before raising; do not report what is correct or handled in context.
- Do not flag style or preference unless it breaks a quoted project rule. Report a missing limit only with the concrete resource at risk and a realistic way it fails.
- `Blocking: yes` only for what should stop the merge: a defect users or callers will hit, a security problem, data loss, a conflict, a broken project rule the project enforces, or a claim the PR does not deliver.

## Output Instructions
1. You may run commands to verify claims (tests, builds, `curl`, `npm view`, `git fetch`). Do not modify, stage, commit, or check out anything in the project; put scratch files in a fresh `mktemp -d` directory outside the repository.
2. Cover every changed file and the callers of changed functions before the verdict. Report every issue now.
3. Use the EXACT output format below. Keep ISSUE-{N} IDs stable in later rounds.

## Required Output Format
{OUTPUT_FORMAT}
```

## Independent Analysis Prompt
```
## Your Task
You are reviewing a pull request someone else wrote, independently. Another reviewer is reviewing it separately — you will NOT see their findings until later.

## INFORMATION BARRIER
- Do NOT read the session's review output or any reviewer output.
- Form your OWN conclusions from the diff, the code, and the PR text.
- Commit to specific positions.

## PR
- Title: {PR_TITLE}
- Base: {BASE_BRANCH}
- Head: {HEAD_REF}

## Description
{PR_DESCRIPTION}

## Commits
{COMMIT_LIST}

## Review Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Instructions
1. Inspect with `git diff {BASE_BRANCH}...{HEAD_REF}`, `git show <sha>`, `git show {HEAD_REF}:<path>`, and `git merge-tree --write-tree {BASE_BRANCH} {HEAD_REF}`; run tests only in the worktree, if any.
2. Review in this order: delivers what it claims, defects, project rules, merge.
3. Raise only what this PR causes, after checking whether it is intentional and reading callers; no style findings unless a quoted project rule; mark `Blocking: yes` only for what should stop the merge.
4. Write in the required format below.

## Required Output Format
{ANALYSIS_FORMAT}
```

## Response Prompt (Round 2+)
```
## Session Context
{SESSION_CONTEXT}

## PR
- Base: {BASE_BRANCH}
- Head: {HEAD_REF}

## Points We Agree On
{AGREED_POINTS}

## Points We Disagree On
{DISAGREED_POINTS}

## New Findings
{NEW_FINDINGS}

## Current Status
{CONTINUE_OR_CONSENSUS_OR_STALEMATE}

## Instructions
1. Check each disagreement and new finding in the code (`git diff {BASE_BRANCH}...{HEAD_REF}`, `git show {HEAD_REF}:<path>`), not from memory. Apply the round 1 rules on what counts as an issue and on blocking.
2. Do not agree automatically. Keep your position when the other side brought no new evidence, and say why; change it only for evidence you had not weighed, and name it.
3. Return the full current list of findings you stand behind as ISSUE blocks: yours with their IDs, and the other side's findings you now accept under the next free numbers. For each finding you withdraw or reject, add one line under `### Withdrawn or Rejected` with the reason.
4. End with VERDICT: `CONSENSUS` only if all disagreements are resolved, `CONTINUE` if a point is still disputed, `STALEMATE` only if you have no new evidence to add. The orchestrator sends another round if you return CONTINUE.

## Required Output Format
{OUTPUT_FORMAT}
```
