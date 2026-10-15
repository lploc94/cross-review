import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENTS, renderSkillTemplate } from "../bin/lib/render-skill.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "skill-packs/codex-review");

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
  assert.ok(claude.includes("/loop-implement") && claude.includes("/codex-plan-review"));
  assert.ok(codex.includes("$loop-implement") && codex.includes("$codex-plan-review"));
  assert.ok(!codex.includes("CLAUDE.md"), "codex copy does not mention CLAUDE.md");
  assert.ok(!/(^|[\s`(])\/(loop|codex)-/.test(codex), "codex copy has no slash commands");
});

test("loop-plan never lets the agent approve its own plan", () => {
  const text = render("loop-plan", "claude");
  assert.ok(!/self-review/i.test(text), "no self-review step");
  // Every APPROVE mention must name an external source: Codex plan review or the user
  for (const line of text.split("\n").filter(l => l.includes("APPROVE"))) {
    assert.ok(/codex-plan-review|user/.test(line), `APPROVE without a source: ${line}`);
  }
  assert.ok(/`Plan Review`[^\n]*pending/.test(text), "Plan Review starts pending");
});

test("loop-plan stays within 1.4x of the original 80 lines", () => {
  for (const client of Object.keys(CLIENTS)) {
    const n = lineCount(render("loop-plan", client));
    assert.ok(n <= 112, `${client}: ${n} lines`);
  }
});
