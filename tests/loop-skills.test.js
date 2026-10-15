import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENTS, renderSkillTemplate } from "../bin/lib/render-skill.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "skill-packs/cross-review");

const PLAN_HEADINGS = [
  "## Plan schema", "## Target", "## Scope", "## Invariants", "## Fixed decisions", "## Baseline",
  "## Design and project patterns", "## Feasibility evidence", "## Capacity", "## Global Gates",
  "## Review checkpoints", "## Plan Review", "## Phase 1:", "## Completion Criteria", "## Progress Log",
];

function render(skill, client) {
  return renderSkillTemplate(PACK, skill, { client });
}

function lineCount(text) {
  return text.trimEnd().split("\n").length;
}

test("both clients are known and an unknown client is rejected", () => {
  assert.deepEqual(Object.keys(CLIENTS).sort(), ["claude", "codex"]);
  assert.throws(() => render("loop-plan", "cursor"), /unknown client/i);
  assert.throws(() => renderSkillTemplate(PACK, "loop-plan", {}), /\{\{CLIENT_/);
});

test("loop-plan template lists the plan headings in order", () => {
  for (const client of Object.keys(CLIENTS)) {
    const text = render("loop-plan", client);
    let at = -1;
    for (const heading of PLAN_HEADINGS) {
      const next = text.indexOf(`\n${heading}`, at + 1);
      assert.ok(next > at, `${client}: ${heading} after the previous heading`);
      at = next;
    }
  }
});

test("loop-plan renders per client without placeholders", () => {
  const claude = render("loop-plan", "claude");
  const codex = render("loop-plan", "codex");
  for (const text of [claude, codex]) assert.ok(!text.includes("{{"));
  assert.ok(claude.includes("/loop-implement") && claude.includes("/review-plan"));
  assert.ok(codex.includes("$loop-implement") && codex.includes("$review-plan"));
  assert.ok(!codex.includes("CLAUDE.md"), "codex copy does not mention CLAUDE.md");
  assert.ok(!/(^|[\s`(])\/(loop|review)-/.test(codex), "codex copy has no slash commands");
});

test("loop-plan never lets the agent approve its own plan", () => {
  const text = render("loop-plan", "claude");
  assert.ok(!/self-review/i.test(text), "no self-review step");
  // Every APPROVE mention must name an external source: review-plan or the user
  for (const line of text.split("\n").filter(l => l.includes("APPROVE"))) {
    assert.ok(/review-plan|user/.test(line), `APPROVE without a source: ${line}`);
  }
  assert.ok(/`Plan Review`[^\n]*pending/.test(text), "Plan Review starts pending");
});

test("loop-plan and loop-implement agree on the living-plan rules", () => {
  const plan = render("loop-plan", "claude");
  const impl = render("loop-implement", "claude");
  assert.ok(/fresh session, with only the repository and this file/.test(plan), "plan is self-contained");
  assert.ok(/end-to-end scenario/.test(plan) && /end-to-end scenario/.test(impl), "end-to-end scenario planned and run");
  assert.ok(/retry or rollback path/.test(plan) && /retry or rollback path/.test(impl), "risky steps have a recovery path");
  for (const tag of ["`Decision:`", "`Discovery:`"]) {
    assert.ok(plan.includes(tag) && impl.includes(tag), `${tag} lines in Progress Log`);
  }
});

test("loop-plan stays within 1.4x of the original 80 lines", () => {
  for (const client of Object.keys(CLIENTS)) {
    const n = lineCount(render("loop-plan", client));
    assert.ok(n <= 112, `${client}: ${n} lines`);
  }
});

test("loop-implement keeps its four blocks and the checkpoint review", () => {
  const claude = render("loop-implement", "claude");
  const codex = render("loop-implement", "codex");
  for (const text of [claude, codex]) {
    assert.ok(!text.includes("{{"));
    for (const heading of ["## Admission", "## Per-phase loop", "## Finalization", "## Stop conditions and reporting"]) {
      assert.ok(text.includes(`\n${heading}`), heading);
    }
  }
  assert.ok(claude.includes("/review-impl"));
  assert.ok(codex.includes("$review-impl") && codex.includes("$loop-plan"));
  assert.ok(!codex.includes("CLAUDE.md"), "codex copy does not mention CLAUDE.md");
  assert.ok(!/(^|[\s`(])\/(loop|review)-/.test(codex), "codex copy has no slash commands");
});

test("loop-implement admits only a sourced approval and drops interim bookkeeping", () => {
  const text = render("loop-implement", "claude");
  assert.ok(/APPROVE[^\n]*review-plan[^\n]*user|APPROVE[^\n]*user[^\n]*review-plan/.test(text), "approval names its source");
  assert.ok(!text.includes("in_progress"), "no interim in_progress state");
  assert.ok(!/record[^.\n]*blocked/i.test(text), "no record-blocked-and-continue");
  assert.ok(/not done/.test(text), "unfinished ACs are reported as not done");
  assert.ok(/baseline/i.test(text), "pre-existing failures are compared with the baseline");
});

test("loop-implement stays within 1.2x of the original 49 lines", () => {
  for (const client of Object.keys(CLIENTS)) {
    const n = lineCount(render("loop-implement", client));
    assert.ok(n <= 59, `${client}: ${n} lines`);
  }
});
