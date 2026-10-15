## Running the review
The runner keeps all session state; you supply content and follow `next`.

- **Tools.** Use the MCP tools `review_begin`, `review_wait`, `review_reply`, `review_end` (server `codex-review`). Without them, or when the client refuses a call (for example in a restricted mode), run the same verbs through the CLI: `node "{{RUNNER_PATH}}" begin|wait|reply|end ...` with the input in a file or on stdin (`--input -`); each prints JSON. Run every verb of one session from the same sandbox context: a process started outside a sandbox can look dead to a `wait` run inside one.
- **Input.** One markdown string with the template's placeholder values: `NAME: value` lines first (optionally between `---` lines), then one `## NAME` section per multi-line value. Omitted optional placeholders fall back to the template's defaults.
- **Start:** `review_begin {skill, mode?, input, working_dir, model?, effort?}` (CLI: `begin --skill <skill> [--mode <mode>] --input <file|-> --working-dir "$PWD" [--model M] [--effort E]`). Effort defaults to `high`.
- **Model.** Pass `model` only when the user names one or the plan's review checkpoint does; otherwise omit it and Codex uses its default. The runner remembers model and effort for later rounds; pass them again only to change them.
- **Wait:** call `review_wait {session_dir}` (CLI: `wait <session_dir>`) until `next` is not `running`. Report the specific `activities` (e.g. "Codex: reading src/auth.js"), never just "running".
- **Act on `next`:**
  - `respond` / `cross_check`: handle the round as described below, then `review_reply {session_dir, input}` and wait again.
  - `done`: the review reached its end (approved or stalemate). Call `review_end`, then report.
  - `ask_user`: the round has no verdict. Read `review.raw_markdown`, tell the user what Codex said, and ask how to proceed.
  - `stopped`: an error, stall, or timeout ended the round. Call `review_end` once (it only stops), report `next_reason` and any partial `review`, and do not start a replacement session. For `recoverable_timeout`, tell the user the same session can continue later with `review_reply`.
- `status: completed` means Codex finished its turn, not that the review is over; only `next` decides.
- **User authority.** The user's latest explicit instruction about running this review (continue, stop, skip, model, effort) overrides this skill and Codex. It does not authorize product, API, schema, or compatibility changes the user did not ask for.
