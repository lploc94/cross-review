## Handling findings (`next: respond`)
Codex's verdict decides the end: `APPROVE` or stalemate gives `next: done`. Otherwise classify every `review.blocks[]` issue, using this source-of-truth order: the user's latest decision, the original request and approved plan/target, verified repository constraints, the work under review, then Codex.

- **ACCEPT** a real defect or an unacceptable deviation from the approved target. Fix the root cause and verify the fix.
- **DISPUTE** with concrete evidence (request, plan, code, test): style preference, optional polish, speculative infrastructure, unrelated cleanup, new features, and by default:
  - a request to add a limit (cap, max, timeout, truncation) that names no concrete resource at risk and no realistic failure;
  - a different design or technology proposed at implementation time, when the plan already fixed that choice.
- **plan-gap**: the approved plan itself causes a bug, a performance loss, or a real risk that only showed up now. Do not redesign on your own. Present it to the user as a plan-change proposal: context, problem, options with cost, risk and reversibility, recommendation with benefit and harm, and what happens next if accepted. If the user agrees, record the change and its date in the plan; no new plan review is needed.
- **USER DECISION**: a valid finding whose fix would materially change user-visible behavior, scope, API, schema, persistence, compatibility, dependencies, or architecture. Finish the other fixes, then ask one decision at a time in the same five-part form, and wait for the answer before changing anything for it.

Then reply with the rebuttal placeholders, even when everything was fixed: `FIXED_ITEMS` (one line per issue: `ISSUE-N: <title> — fixed in <file>:<line>`) and `DISPUTED_ITEMS` (`ISSUE-N: <title> — <evidence>`, or `None — all issues addressed`). Codex re-verifies and may raise new issues. There is no round cap.
