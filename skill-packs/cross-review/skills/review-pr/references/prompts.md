# Prompt Templates

> The runner prepends every rendered template with an **ABSOLUTE USER AUTHORITY** instruction and loads the compiled 3-layer `review-pr` system prompt (Layer 1 core reviewer methodology, Layer 2 always-on recon and spike tactics, and Layer 3 `review-pr` rubric).

## Placeholder Injection Guide

| Placeholder | Source | Required | Default |
|-------------|--------|----------|---------|
| `{PR_TITLE}` | `gh pr view --json title`, or the branch name | No | "Not provided" |
| `{PR_DESCRIPTION}` | `gh pr view --json body`, plus linked issues | No | "Not provided" |
| `{BASE_BRANCH}` | The base it merges into, e.g. `origin/main` | Yes | — |
| `{HEAD_REF}` | The PR head SHA (`headRefOid`, or `git rev-parse <branch>`) | Yes | — |
| `{USER_REQUEST}` | What the user wants from this review | No | "Review this PR for correctness and merge readiness" |
| `{SESSION_CONTEXT}` | Review discussion and decisions, worktree path, where real samples of the data live | No | "Not specified" |
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
Execute an independent Round 1 Peer Pull-Request Review (`review-pr`) under your active system rubric. Another reviewer is evaluating this PR independently; your findings will be cross-checked and reconciled on evidence.

## PR
- Title: {PR_TITLE}
- Base: {BASE_BRANCH}
- Head: {HEAD_REF}

## Description
{PR_DESCRIPTION}

## Review Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## How to Inspect
- Inspect `git diff {BASE_BRANCH}...{HEAD_REF}`, `git log --oneline {BASE_BRANCH}..{HEAD_REF}`, `git show {HEAD_REF}:<path>`, and `git merge-tree --write-tree {BASE_BRANCH} {HEAD_REF}`.
- Run tests or builds only in the detached worktree named in `Session Context`, if any; never mutate or check out anything in the user's working tree.

## Review Focus
1. **Delivers what it claims**: Compare PR description and linked issues against the actual diff.
2. **Defects & performance**: Audit changed code and callers across all 6 system taxonomies.
3. **Project rules & merge readiness**: Quote any violated repository instruction rule (`file:line`) and check merge cleanliness against `{BASE_BRANCH}`.
4. **Blocking discipline**: Set `Blocking: yes` only for defects that must stop the merge; output each finding as `ISSUE-{N}` and end with `### VERDICT`.

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

## Review Request
{USER_REQUEST}

## Session Context
{SESSION_CONTEXT}

## Instructions
1. Inspect with `git diff {BASE_BRANCH}...{HEAD_REF}`, `git log --oneline {BASE_BRANCH}..{HEAD_REF}`, `git show <sha>`, `git show {HEAD_REF}:<path>`, and `git merge-tree --write-tree {BASE_BRANCH} {HEAD_REF}`; run tests only in the worktree, if any.
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
1. Verify each disagreement and new finding directly in the code (`git diff {BASE_BRANCH}...{HEAD_REF}`, `git show {HEAD_REF}:<path>`), not from memory.
2. Do not agree automatically. Keep your position when the other side brought no new evidence, and say why; change it only for evidence you had not weighed, and name it.
3. Return the full current list of findings you stand behind as `ISSUE-{N}` blocks (keeping your existing IDs and assigning the next free numbers to accepted peer findings), list withdrawn/rejected items under `### Withdrawn or Rejected`, and end with `### VERDICT` (`CONSENSUS`, `CONTINUE`, or `STALEMATE`).

## Required Output Format
{OUTPUT_FORMAT}
```
