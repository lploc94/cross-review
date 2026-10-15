import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VARIANTS, renderSkillTemplate } from "../bin/lib/render-skill.js";
import { SKILL_TEMPLATES } from "../skill-packs/cross-review/scripts/lib/review-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "skill-packs/cross-review");
const RUNNER_SKILLS = Object.keys(PROTOCOL_VARIANTS);
const OPTS = { runnerPath: "/home/u/.claude/skills/cross-review/scripts/review-runner.js", skillsDir: "/home/u/.claude/skills" };

const CORE_MARK = "## Running the review";
const VARIANT_MARK = {
  "apply-rebut": "## Handling findings (`next: respond`)",
  "cross-analysis": "## Peer cross-analysis (`next: cross_check`)",
};

test("every runner skill renders with core and its own protocol variant", () => {
  assert.deepEqual(RUNNER_SKILLS.sort(), Object.keys(SKILL_TEMPLATES).sort());
  for (const skill of RUNNER_SKILLS) {
    const text = renderSkillTemplate(PACK, skill, OPTS);
    assert.equal(text.split(CORE_MARK).length - 1, 1, `${skill}: core section once`);
    const own = VARIANT_MARK[PROTOCOL_VARIANTS[skill]];
    assert.ok(text.includes(own), `${skill}: ${PROTOCOL_VARIANTS[skill]} variant`);
    for (const other of Object.values(VARIANT_MARK).filter(m => m !== own)) {
      assert.ok(!text.includes(other), `${skill}: no other variant`);
    }
    assert.ok(text.includes(`node "${OPTS.runnerPath}" begin|wait|reply|end`), `${skill}: CLI fallback uses the runner path`);
  }
});

test("rendered skills have no placeholders, flavor text, protocol files or bash plumbing", () => {
  for (const skill of RUNNER_SKILLS) {
    const text = renderSkillTemplate(PACK, skill, OPTS);
    assert.ok(!text.includes("{{"), `${skill}: no {{`);
    assert.ok(!/flavor/i.test(text), `${skill}: no flavor`);
    assert.ok(!text.includes("protocol.md"), `${skill}: no protocol.md`);
    assert.ok(!text.includes("json_esc"), `${skill}: no json_esc`);
    assert.ok(!text.includes("analysis-template.md"), `${skill}: analysis template comes via analysis_prompt`);
  }
});

test("placeholders a skill tells the model to supply exist in its prompt templates", () => {
  for (const skill of RUNNER_SKILLS) {
    const skillMd = fs.readFileSync(path.join(PACK, "skills", skill, "SKILL.md"), "utf8");
    const prompts = fs.readFileSync(path.join(PACK, "skills", skill, "references", "prompts.md"), "utf8");
    const inputLines = skillMd.split("\n").filter(l => /placeholders:/.test(l));
    assert.ok(inputLines.length >= 2, `${skill}: round 1 and reply placeholder lines`);
    for (const line of inputLines) {
      for (const [, name] of line.matchAll(/`([A-Z][A-Z_0-9]+)`/g)) {
        assert.ok(prompts.includes(`{${name}}`), `${skill}: {${name}} is used by prompts.md`);
      }
    }
  }
});

test("rendering fails loudly when a template lacks the protocol placeholders", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
  try {
    fs.mkdirSync(path.join(tmp, "skills", "review-plan"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "shared"));
    fs.cpSync(path.join(PACK, "shared", "protocol"), path.join(tmp, "shared", "protocol"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "skills", "review-plan", "SKILL.md"), "# x\n{{PROTOCOL_CORE}}\n");
    assert.throws(() => renderSkillTemplate(tmp, "review-plan", OPTS), /PROTOCOL_VARIANT/);
    fs.writeFileSync(path.join(tmp, "skills", "review-plan", "SKILL.md"), "# x\n{{PROTOCOL_CORE}}\n{{PROTOCOL_VARIANT}}\n{{UNKNOWN_THING}}\n");
    assert.throws(() => renderSkillTemplate(tmp, "review-plan", OPTS), /UNKNOWN_THING/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rendering rejects every leftover or malformed placeholder", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
  try {
    fs.mkdirSync(path.join(tmp, "skills", "loop-plan"), { recursive: true });
    for (const bad of ["{{CLIENT_SKILL2}}", "{{client_skill}}", "{{CLIENT_SKILL"]) {
      fs.writeFileSync(path.join(tmp, "skills", "loop-plan", "SKILL.md"), `# x\nRun ${bad}loop-implement\n`);
      assert.throws(() => renderSkillTemplate(tmp, "loop-plan", { client: "claude" }), /still contains/, bad);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("think-about file guard snapshots contents and ignores runner artifacts", () => {
  const text = fs.readFileSync(path.join(PACK, "skills", "review-think", "SKILL.md"), "utf8");
  assert.ok(text.includes("git write-tree"), "content snapshot");
  assert.ok(!text.includes("git status --porcelain"), "status-based comparison removed");
});

test("review-think sharpens without confirmation, records both sides, and resists reflexive agreement", () => {
  const dir = path.join(PACK, "skills", "review-think");
  const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const prompts = fs.readFileSync(path.join(dir, "references", "prompts.md"), "utf8");
  const format = fs.readFileSync(path.join(dir, "references", "output-format.md"), "utf8");
  assert.ok(skill.includes("Do not ask the user to confirm the rewrite"), "no sharpen confirmation");
  assert.ok(skill.includes("<session_dir>/analysis.md") && skill.includes("<session_dir>/summary.md"), "analysis and report saved");
  assert.ok(skill.includes("Lead with the answer"), "report leads with the recommendation");
  assert.ok(prompts.includes("Do not agree automatically"), "round 2 anti-sycophancy");
  assert.ok(prompts.includes("outside the project"), "experiments allowed outside the project");
  assert.ok(!/curl|CRITICAL RULES|danger-full-access/.test(prompts), "no network micro-rules");
  assert.ok(/```markdown\n### Position/.test(format), "Position comes first");
});
