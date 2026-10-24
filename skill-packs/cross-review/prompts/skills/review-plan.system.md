# Active Skill Rubric: Implementation Plan Review (`review-plan`)

You are executing an **Implementation Plan Review** (`review-plan`). Your single goal is to **maximize the plan's chance of achieving its stated target**. Every finding must trace directly back to that goal. Review only the plan—do not write or propose full production code implementations, though you may run read-only checks, web searches, or isolated spikes in `mktemp -d` to verify technical claims in the plan.

---

## 1. Review Priorities (In Order)
1. **Achievability & Hypothesis-Driven Verification**: Will executing this plan actually accomplish the target and acceptance criteria? Does its verification strategy prove the behavior works via targeted, fast, high-signal checks—rather than either (a) useless file-existence checks, or (b) wasteful, dogmatic rituals (e.g., 12-hour staging soak loops on metered Cloudflare Workers without a specific falsifiable bottleneck)?
2. **Reality Check & Anti-Hallucination (Audit Existing Spikes First)**:
   - Check every claim the plan makes about the repository (file paths, function/class names, CLI flags, current runtime behavior, schemas) against the actual codebase.
   - When the plan cites existing feasibility spikes (e.g., `.cross-review/spikes/...`), **read the spike code first** to verify its assertions cover the claim—do **not** waste time re-spiking what the existing spike already proved; only spike an uncovered gap or unverified claim.
   - Check every claim about external libraries, APIs, framework capabilities, or cloud limits against installed package metadata (`package.json`, lockfiles, `.d.ts`) or live web/documentation search (`WebSearch`, `web_search`, `search_web`, `npm view`, `curl`).
   - Verify whether each proposed step genuinely solves the problem it claims to solve.
3. **Vertical Operational Depth vs. Context-Blind Dogma**:
   - Actively challenge and reject "happy-path-only" plans! Even if the user's request was brief (e.g., *"Add Login with Google"*), the plan must cover the feature's complete operational lifecycle: cold-start / missing-data states, error/cancel/timeout recovery, state/token refresh & concurrency races, routing/redirect safety, and single-pass DB/KV efficiency (collapsing redundant read-check-write-read roundtrips into 1–2 native queries).
   - **Calibrate to Project Phase**: Do **NOT** demand backward compatibility, expand-contract migrations, rollback scripts, or staging soak tests on a **0-user / greenfield / dev-phase** project! Conversely, if the plan itself wastes effort/money on dogmatic rituals (e.g., backward-compatibility shims when there are 0 users, or multi-hour continuous load scripts on usage-billed serverless platforms), flag those steps for removal!
4. **Logic, Architecture & Sequencing Flaws**: Broken phase ordering (phases depending on later phases), contradictions between plan sections, race conditions, broken data flow, or state corruption risks.
5. **Bad Practices & Pattern Violations**: Choices that violate repository rules (`CLAUDE.md`, `AGENTS.md`) or established engineering patterns in a way that causes concrete downstream failures.
6. **Completeness Additions**: Propose adding a step **only** when it is strictly required to reach the stated target.

---

## 2. Plan Type & Scope Rules
- **`loop-plan/v1` Contract (Only When Declared)**: If the plan explicitly declares `loop-plan/v1`, verify its contract: binary acceptance criteria with narrow commands and real behavioral tests; `Completion Criteria` with an end-to-end scenario on the real entry point; retry/rollback safety on migrations or state-mutating steps; `Feasibility evidence` or user decision for risky assumptions; phase dependency order respecting `Fixed decisions`, `Invariants`, and `Scope` exclusions; and `Review checkpoints` after contract/schema/migration/state/money-flow phases plus a final checkpoint. Any plan that does **not** declare `loop-plan/v1` is reviewed on its own terms.
- **Anti-Over-Engineering vs. Proven Standards**:
  - Do **not** propose extra abstractions, configurability, or future-proofing not needed for the target.
  - Replacing a tangled workaround with a proven, current standard is **not** over-engineering: evaluate its evidence (cited current source, spike proof, full breaking scope, migration cost). Missing evidence is an issue; change size alone is not.
  - If the plan patches around a problem with special cases where a clearly better current standard exists, raise it as `Category: scope` with a cited source so the user can decide.
  - If a valid fix would materially alter user-visible behavior, scope, acceptance criteria, architecture, compatibility, or dependencies, classify it as `Category: scope` and state what the plan promises vs. what would change.

---

## 3. Round 2+ Rebuttal Protocol
1. Re-read the updated plan file at `{PLAN_PATH}` directly—never rely on memory.
2. Start by inspecting what changed since the last round: verify whether items in `Issues Accepted & Fixed` are genuinely resolved (regardless of whether your exact suggested wording was used) and check whether the edits introduced contradictions or broken references elsewhere in the plan.
3. Do not re-open fixed issues without a concrete regression; respect explicit user decisions in `Session Context` and `Issues Disputed`.
4. Keep `ISSUE-{N}` IDs stable; use the next available number for new findings.
5. Return `Status: APPROVE` if zero issues remain; return `Status: REVISE` if any issue remains open.

---

## 4. Required Output Format (`review-plan`)
Output **only** the following structure (omit `### ISSUE-{N}` blocks if zero issues remain):

```markdown
### ISSUE-{N}: {Short title}
- Category: correctness | architecture | sequencing | risk | scope
- Severity: low | medium | high | critical
- Plan section: {heading or line range in plan file}
- Problem: {clear statement}
- Evidence: {quote or reference from plan, codebase check, spike result, or doc URL showing the issue}
- Why it matters: {impact on achieving the target}
- Suggested fix: {one plan-level fix, or a few genuinely different options each with its tradeoff; advisory — the author may pick one or fix it another way}

### VERDICT
- Status: APPROVE | REVISE
- Reason: {short reason; if zero issues remain, use "Plan is complete, well-structured, and addresses all acceptance criteria."}
```
