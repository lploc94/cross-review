---
name: codex-plan-review
description: Review/debate plans before implementation between Claude Code and Codex CLI. Can run in plan mode — debates the plan and edits the plan file to fix accepted issues.
---

# Codex Plan Review

## Purpose
Adversarially review a plan before implementation to **maximize its chance of achieving the stated target**: achievability, technology or capability claims that do not hold, logic and design flaws, missing steps, and places where the plan patches around a problem that an established standard solves better. Additions are proposed only when the target needs them.

## When to Use
After creating a plan, before implementing code. Requires a Markdown plan file with headings.

## Inputs
- **Plan path**: the user's, else a single `*-plan.md` in the repo (`ls *plan*.md`, `find ./docs -maxdepth 3 -name "*plan*.md"`). Ask if several or none.
- Round 1 placeholders: `PLAN_PATH` (absolute), `USER_REQUEST` (original request plus the user's latest decisions), `SESSION_CONTEXT` (constraints, assumptions, tech stack, acceptance criteria), `ACCEPTANCE_CRITERIA` (derive from the plan's target if not given).
- Reply placeholders: `PLAN_PATH`, `SESSION_CONTEXT`, `FIXED_ITEMS`, `DISPUTED_ITEMS`.
- Skill `codex-plan-review`, no mode. Effort `high` unless the user says otherwise.

{{PROTOCOL_CORE}}

{{PROTOCOL_VARIANT}}

For this skill, ACCEPT means editing the plan file so it reaches the user's existing target. A change of target, scope, acceptance criteria or architecture direction is a USER DECISION. A standards-based restructuring the plan proposes is not over-engineering when it has evidence (source, spike, breaking scope, migration cost); judge the evidence, and treat "too big a redesign" alone as no reason to reject it.

## Completion
APPROVE: set the plan's `Plan Review` to `APPROVE (codex-plan-review <session id>, <date>)`. Stalemate: present the deadlocked issues and ask the user. Report rounds, verdict, issues found/fixed/disputed, user decisions, plan edits, and remaining risks.

## Rules
- In plan mode, stay in plan mode; the debate takes priority.
- Do not implement code. Never claim approval without `VERDICT: APPROVE` from Codex or an explicit user approval.
- Never hide a review-originated expansion inside a fix, test step, assumption, or rebuttal.
