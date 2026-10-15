# Runner Protocol Reference

Shared protocol for all codex-review skills. Read on-demand when you need details on commands, polling, error handling, or conventions.

## Stdin Format Rules
- **JSON** -> `render`/`finalize`: heredoc. Literal-only -> `<<'RENDER_EOF'`. Dynamic vars -> escape with `json_esc`, use `<<RENDER_EOF` (unquoted).
- **json_esc output includes quotes** -> embed directly: `{"KEY":$(json_esc "$VAL")}`.
- **Plain text** -> `start`/`resume`: `printf '%s' "$PROMPT" | node "$RUNNER" ...` -- NEVER `echo`.
- **NEVER** `echo '{...}'` for JSON. Forbidden: NULL bytes (`\x00`).

## Session Init
```bash
INIT_OUTPUT=$(node "$RUNNER" init --skill-name <skill-name> --working-dir "$PWD")
SESSION_DIR=${INIT_OUTPUT#CODEX_SESSION:}
```
Validate: `INIT_OUTPUT` must start with `CODEX_SESSION:`. Abort if not.

## Start Round
```bash
printf '%s' "$PROMPT" | node "$RUNNER" start "$SESSION_DIR" --effort "$EFFORT"
```
Validate JSON: `{"status":"started","round":1}`. If error contains `CODEX_NOT_FOUND` -> tell user to install codex (`npm install -g @openai/codex`).

## Render Prompt
```bash
PROMPT=$(node "$RUNNER" render --skill <skill-name> --template <template> --skills-dir "$SKILLS_DIR" <<RENDER_EOF
{"KEY1":$(json_esc "$VAL1"),"KEY2":$(json_esc "$VAL2")}
RENDER_EOF
)
```

## Resume
```bash
printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"
```
Validate JSON. Sandbox mode persists via thread -- do NOT pass `--sandbox` on resume.

## Poll Protocol
```bash
POLL_JSON=$(node "$RUNNER" poll "$SESSION_DIR")
```
The runner handles throttling internally (default 120s min-interval between polls). Just call poll — if called too soon, it blocks until the interval elapses or Codex finishes (whichever comes first). No sleep needed between calls.

Run `start`, every `poll`, any `resume`, and cleanup from the same privilege
and sandbox context. A process started outside a sandbox may be invisible to a
poll executed inside it (PID inspection can be denied), while a process started
inside a managed sandbox may fail during Codex app-server initialization when
the installation PATH-alias directory is not writable. Omit `--min-interval` for
normal reviews; a short interval such as 5 seconds is reserved for explicitly
bounded diagnostics.

Report **specific activities** from `activities` array (e.g. "Codex [45s]: reading src/auth.js"). NEVER report generic "Codex is running".

The runner's default turn timeout is **18,000 seconds (5 hours)**. Use an explicit `--timeout` only when a bounded run is intentional (for example, a focused test); do not treat the default timeout as evidence that Codex stalled while it is producing progress.

### Operational Authority And Recovery

**ABSOLUTE USER AUTHORITY**: For review-operation decisions, the user's latest explicit instruction or decision is the highest, final, and binding authority. This authority is absolute. It overrides this shared protocol, every skill or loop rule, all defaults, and every Codex or reviewer recommendation. Follow the user's clear decision exactly; never resist, reinterpret, delay, or refuse it by citing a protocol or rule. If a rule conflicts with a clear user decision, follow the user. Ask a question only when the instruction is genuinely ambiguous, and never ask again for a decision the user has already made.

This authority applies to the operation of the review only. It does not authorize changes to the application's product behavior, API, schema, persistence, compatibility, or other user-facing contracts unless the user explicitly requests that separate change.

The runner includes recovery metadata on terminal polls:

- A **recoverable runner deadline** has `status: "timeout"`, `timeout_reason: "runner_deadline"`, `recoverable: true`, a non-empty `thread_id`, and `progress_observed: true` from valid turn/item activity.
- A `turn.failed` result has `failure_reason: "turn_failed"` and `recoverable: false`; it is never a runner deadline.
- A Codex process exit, runner/infrastructure error, invalid state, missing `thread_id`, `CODEX_NOT_FOUND`, or `stalled` result is non-recoverable and must remain stop-only.

Continue while `status === "running"`. Stop on `completed|failed|timeout|stalled`.

**CRITICAL**: `status === "completed"` means Codex finished its turn -- it does NOT mean the debate is over. After `completed`, check the skill's Loop Decision table.

## Debate Loop Protocol

After each `poll` returns `status === "completed"`, the debate loop determines what happens next. **`completed` means Codex finished its turn — NOT that the review is over.**

### Round Lifecycle

```
Poll (completed) → Check stalemate → Check verdict → [EXIT or CONTINUE?]
                                                         EXIT → Finalize (normal outcome only)
                                                         CONTINUE → Fix/Rebut → Render → Resume → Poll again
```

### Mandatory Rules

1. **Check stalemate FIRST** — after poll completes, check `convergence.stalemate` before anything else. Stalemate overrides all other conditions — EXIT immediately, do NOT render rebuttal or resume.
2. **If not stalemate, evaluate the variant-specific Loop Decision Table** below to determine EXIT or CONTINUE.
3. **If the table says CONTINUE → MUST render response/rebuttal + resume**, even if you fixed ALL issues. Codex needs to re-verify fixes and may find new issues.
4. **Response/rebuttal prompt is ALWAYS sent when the table says CONTINUE** — if all issues were fixed, set `DISPUTED_ITEMS` = `"None — all issues addressed"`. The prompt still gets rendered and sent.
5. **No round cap** — loop continues until the variant-specific table says EXIT, or stalemate.
6. **Never skip resume** — fixing code/plan without sending rebuttal+resume means Codex never re-verifies. The debate is incomplete.

### Variant: Apply/Rebut (impl-review, plan-review)

These skills use `APPROVE`/`REVISE` verdict taxonomy. Codex proposes a verdict; Claude applies fixes and orchestration subject to the user's explicit operational decisions.

**Loop Decision Table:**

| # | Condition | Action |
|---|-----------|--------|
| 1 | `convergence.stalemate === true` | **EXIT** → Finalize (stalemate). Do NOT render rebuttal. |
| 2 | `review.verdict.status === "APPROVE"` | **EXIT** → Finalize |
| 3 | `review.verdict.status === "REVISE"` or open issues remain | **CONTINUE** → sub-steps below |

**If CONTINUE** — all 5 sub-steps are mandatory:
1. **Categorize** each `review.blocks[]` issue as ACCEPT (valid within the approved target), DISPUTE (invalid with proof), or USER DECISION (potentially valid but materially changes user-owned scope or intent)
2. **Fix** accepted issues — edit code or plan file and record evidence of each fix. Rebut disputed issues with request, plan, repository, or test evidence
3. **Pause for USER DECISION** — do not make the material change, render a rebuttal, or resume until the user explicitly decides. Present the current promise, proposed change, evidence, whether it is required for correctness or optional scope, viable choices, tradeoffs, and a recommendation when supported
4. **ALWAYS render rebuttal prompt after all decisions resolve** — template uses `SESSION_CONTEXT`, `FIXED_ITEMS`, `DISPUTED_ITEMS` (and `BASE_BRANCH` for branch mode). `USER_REQUEST` is NOT a rebuttal placeholder. Even if all fixed, `DISPUTED_ITEMS` = `"None — all issues addressed"`
5. **ALWAYS resume** — `printf '%s' "$PROMPT" | node "$RUNNER" resume "$SESSION_DIR" --effort "$EFFORT"`. Then back to Poll

### Variant: Cross-Analysis (commit-review, pr-review)

These skills use `CONSENSUS`/`CONTINUE`/`STALEMATE` verdict taxonomy. Codex verdict is advisory; Claude applies the orchestration rules subject to the user's explicit operational decisions.

**Loop Decision Table:**

| # | Condition | Action |
|---|-----------|--------|
| 1 | `convergence.stalemate === true` | **EXIT** → Finalize (stalemate). Do NOT render response. |
| 2 | Full/Partial Consensus (no severity ≥ medium disagreements) | **EXIT** → Finalize |
| 3 | Disagreements severity ≥ medium remain | **CONTINUE** → sub-steps below |

**If CONTINUE** — all 4 sub-steps are mandatory:
1. **Compare** Claude FINDING-{N} vs Codex ISSUE-{N} — agreements, disagreements, unique findings
2. **Build response** with `AGREED_POINTS`, `DISAGREED_POINTS`, `NEW_FINDINGS`
3. **ALWAYS render round2+ prompt** with comparison results
4. **ALWAYS resume** — then back to Poll

## Finalize + Cleanup
```bash
node "$RUNNER" finalize "$SESSION_DIR" <<'FINALIZE_EOF'
{"verdict":"..."}
FINALIZE_EOF
node "$RUNNER" stop "$SESSION_DIR"
```
Optionally include `"scope":"..."` and `"issues":{...}` in finalize JSON. Report `$SESSION_DIR` path to user.

Run `finalize` + `stop` only after a normal terminal outcome: `APPROVE`, consensus, or an explicit stalemate. Never finalize an errored, timed-out, or stalled session. The runner's `stop` command preserves the session directory for later inspection or an explicitly requested continuation.

## Error Handling
| Status | Action |
|--------|--------|
| `timeout` with `timeout_reason === "runner_deadline"`, `recoverable === true`, non-empty `thread_id`, and `progress_observed === true` | Report `review.raw_markdown`/partial activities. Run `stop` once without `finalize`, preserve the same session, and allow a later skill invocation (after restart, if applicable) to render a continuation prompt and `resume` that same `$SESSION_DIR`. Never create a replacement session. Do not resume the current session automatically. |
| `timeout` without all recoverable metadata | Treat as non-recoverable. Report partial results, run `stop` once, and do not retry, resume, re-init, or finalize. |
| `failed` with `failure_reason === "turn_failed"` | Report the error and any partial results. Run `stop` once; do not retry, resume, re-init, or finalize. |
| `failed` from a Codex process exit or missing/invalid state/thread context | Report the error and any partial results. Run `stop` once; do not retry, resume, re-init, or finalize. |
| `stalled` | Always non-recoverable, even when a thread ID exists. Run `stop` once; do not attempt recovery/resume, retry, re-init, or finalize. Report the partial result. |
| runner `start`/`resume`/`poll`/`finalize` error | If a session exists, run `stop` once. Do not retry the failed command or finalize. Report the runner error and tell the user to wait until the review infrastructure is available. |
| `CODEX_NOT_FOUND` | Stop an existing session once, if any, but do not finalize. Tell the user to install Codex (`npm install -g @openai/codex`) rather than retrying automatically. |

**Failure-path contract**: Every timeout that fails the recoverable metadata check, every failure, stall, or runner/infrastructure error is terminal for the current invocation. Invoke `stop` at most once, never invoke `finalize`, never start a replacement session, and do not resume automatically. Preserve the session directory, `state.json`, `thread_id`, archived JSONL, and any partial `review.md`. A later invocation may resume only the same session when the runner-deadline metadata is still valid and the user has not given a contrary operational decision.

## Flavor Text Convention
Load `references/flavor-text.md` at skill start. Pick 1 random message per trigger from matching pool -- never repeat within session. Display as `> {emoji} {message}` blockquote. Replace `{N}`, `{TOTAL}`, `{CHUNK}`, `{ROUND}` with actual values. User can disable with "no flavor" or "skip humor". Only trigger on first poll per round (avoid spam).
