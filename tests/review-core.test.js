import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SKILL_TEMPLATES,
  beginSession,
  computeNext,
  endSession,
  parseReviewInput,
  replySession,
  waitSession,
} from "../skill-packs/codex-review/scripts/lib/review-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "skill-packs/codex-review/scripts/codex-runner.js");
const SKILLS_DIR = path.join(ROOT, "skill-packs/codex-review/skills");

let tmp;
let workDir;
let logPath;
let outputPath;

function writeFakeCodex(binDir) {
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
try { prompt = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");
const text = fs.readFileSync(process.env.FAKE_CODEX_OUTPUT, "utf8");
const out = [
  { type: "thread.started", thread_id: "thread-fake-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text } },
  { type: "turn.completed" },
];
process.stdout.write(out.map(e => JSON.stringify(e)).join("\\n") + "\\n");
`, { mode: 0o755 });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-core-test-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  writeFakeCodex(bin);
  workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir);
  logPath = path.join(tmp, "codex-log.jsonl");
  outputPath = path.join(tmp, "codex-output.md");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_CODEX_LOG = logPath;
  process.env.FAKE_CODEX_OUTPUT = outputPath;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function setCodexOutput(text) {
  fs.writeFileSync(outputPath, text);
}

function codexCalls() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
}

function resetLog() {
  fs.rmSync(logPath, { force: true });
}

// Input supplying every placeholder of the skill, so required ones are always present.
function inputFor(skill, tag) {
  const md = fs.readFileSync(path.join(SKILLS_DIR, skill, "references", "prompts.md"), "utf8");
  const names = [...new Set([...md.matchAll(/\{([A-Z][A-Z_0-9]+)\}/g)].map(m => m[1]))]
    .filter(n => n !== "OUTPUT_FORMAT" && n !== "CLAUDE_ANALYSIS_FORMAT");
  return names.map(n => `## ${n}\n${tag}-${n}\nsecond line\n`).join("\n");
}

function renderExpected(skill, template, input) {
  const names = new Set([...fs.readFileSync(path.join(SKILLS_DIR, skill, "references", "prompts.md"), "utf8")
    .matchAll(/\{([A-Z][A-Z_0-9]+)\}/g)].map(m => m[1]));
  const values = parseReviewInput(input, names);
  return execFileSync(process.execPath, [RUNNER, "render", "--skill", skill, "--template", template, "--skills-dir", SKILLS_DIR], {
    input: JSON.stringify(values),
    encoding: "utf8",
  });
}

// ---------- computeNext ----------

const PLAN = { skill_name: "codex-plan-review" };
const COMMIT = { skill_name: "codex-commit-review" };
const THINK = { skill_name: "codex-think-about" };

test("computeNext: running", () => {
  assert.equal(computeNext({ status: "running" }, PLAN).next, "running");
});

test("computeNext: APPROVE ends a plan review", () => {
  const r = computeNext({ status: "completed", review: { blocks: [], verdict: { status: "APPROVE" } } }, PLAN);
  assert.deepEqual(r, { next: "done", next_reason: "approved" });
});

test("computeNext: REVISE with issues asks for a response", () => {
  const r = computeNext({ status: "completed", review: { blocks: [{ id: 1 }], verdict: { status: "REVISE" } } }, PLAN);
  assert.equal(r.next, "respond");
});

test("computeNext: issues without a verdict still need a response", () => {
  assert.equal(computeNext({ status: "completed", review: { blocks: [{ id: 1 }], verdict: null } }, PLAN).next, "respond");
});

test("computeNext: completed without verdict or issues asks the user, never done", () => {
  const r = computeNext({ status: "completed", review: { format: "unknown", raw_markdown: "prose" } }, PLAN);
  assert.deepEqual(r, { next: "ask_user", next_reason: "missing_verdict" });
});

test("computeNext: convergence stalemate ends the review", () => {
  const r = computeNext({ status: "completed", review: { blocks: [{ id: 1 }], verdict: { status: "REVISE" } }, convergence: { stalemate: true } }, PLAN);
  assert.deepEqual(r, { next: "done", next_reason: "stalemate" });
});

test("computeNext: STALEMATE status without the convergence flag ends the review", () => {
  const r = computeNext({ status: "completed", review: { blocks: [], verdict: { status: "STALEMATE" } }, convergence: { stalemate: false } }, COMMIT);
  assert.deepEqual(r, { next: "done", next_reason: "stalemate" });
});

test("computeNext: think-about suggested_status STALEMATE ends the review", () => {
  const r = computeNext({ status: "completed", review: { format: "think-about", suggested_status: "STALEMATE" } }, THINK);
  assert.equal(r.next, "done");
});

test("computeNext: RESPONSE-only round of a plan review is answered", () => {
  const r = computeNext({ status: "completed", review: { format: "codebase-validation", blocks: [{ id: 1, prefix: "RESPONSE" }], verdict: { status: "REVISE" } } }, PLAN);
  assert.equal(r.next, "respond");
});

test("computeNext: peer skill with Codex CONSENSUS goes to cross_check, not done", () => {
  const r = computeNext({ status: "completed", review: { blocks: [], verdict: { status: "CONSENSUS" } } }, COMMIT);
  assert.deepEqual(r, { next: "cross_check", next_reason: "peer_verdict_is_advisory" });
  const t = computeNext({ status: "completed", review: { format: "think-about", suggested_status: "CONSENSUS" } }, THINK);
  assert.equal(t.next, "cross_check");
});

test("computeNext: recoverable runner-deadline timeout", () => {
  const r = computeNext({ status: "timeout", timeout_reason: "runner_deadline", recoverable: true, thread_id: "t", progress_observed: true }, PLAN);
  assert.deepEqual(r, { next: "stopped", next_reason: "recoverable_timeout" });
});

test("computeNext: non-recoverable timeout, failure and stall stop", () => {
  assert.deepEqual(computeNext({ status: "timeout", timeout_reason: "runner_deadline", recoverable: false }, PLAN), { next: "stopped", next_reason: "timeout" });
  assert.deepEqual(computeNext({ status: "failed", failure_reason: "codex_process_exit" }, PLAN), { next: "stopped", next_reason: "codex_process_exit" });
  assert.deepEqual(computeNext({ status: "stalled", failure_reason: "stalled" }, PLAN), { next: "stopped", next_reason: "stalled" });
});

// ---------- input parsing ----------

test("parseReviewInput: front-matter scalars and multi-line sections", () => {
  const names = new Set(["USER_REQUEST", "DIFF_CONTEXT", "PLAN_PATH"]);
  const v = parseReviewInput("---\nPLAN_PATH: /tmp/p.md\n---\n## USER_REQUEST\nDo X\n\n## DIFF_CONTEXT\n+## NOT_A_KEY\n## Not upper\nend\n", names);
  assert.equal(v.PLAN_PATH, "/tmp/p.md");
  assert.equal(v.USER_REQUEST, "Do X");
  assert.equal(v.DIFF_CONTEXT, "+## NOT_A_KEY\n## Not upper\nend");
});

// ---------- .gitignore ----------

test("init writes .codex-review/.gitignore once and never overwrites it", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "gi-"));
  execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "codex-plan-review", "--working-dir", dir], { encoding: "utf8" });
  const gi = path.join(dir, ".codex-review", ".gitignore");
  assert.equal(fs.readFileSync(gi, "utf8"), "*\n");
  fs.writeFileSync(gi, "custom\n");
  execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "codex-plan-review", "--working-dir", dir], { encoding: "utf8" });
  assert.equal(fs.readFileSync(gi, "utf8"), "custom\n");
});

// ---------- begin → wait → reply → wait for every skill/mode ----------

const COMBOS = [];
for (const [skill, entry] of Object.entries(SKILL_TEMPLATES)) {
  for (const [mode, templates] of Object.entries(entry.modes)) {
    COMBOS.push({ skill, mode: mode === "default" ? undefined : mode, templates, peer: entry.peer });
  }
}

test("there are 7 skill/mode combinations", () => {
  assert.equal(COMBOS.length, 7);
});

for (const combo of COMBOS) {
  test(`begin → wait → reply → wait: ${combo.skill}${combo.mode ? ` (${combo.mode})` : ""}`, async () => {
    resetLog();
    setCodexOutput("### ISSUE-1: Something\n- Category: correctness\n- Severity: high\n- Problem: p\n\n### VERDICT\n- Status: REVISE\n- Reason: r\n");
    const input1 = inputFor(combo.skill, "r1");
    const begun = await beginSession({ skill: combo.skill, mode: combo.mode, inputText: input1, workingDir: workDir, model: "model-a", effort: "low" });
    assert.equal(begun.status, "running");
    assert.equal(begun.round, 1);
    if (combo.peer) {
      assert.equal(begun.analysis_prompt, renderExpected(combo.skill, combo.templates.analysis, input1));
    } else {
      assert.equal(begun.analysis_prompt, undefined);
    }

    const w1 = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
    assert.equal(w1.status, "completed");
    assert.equal(w1.next, combo.peer ? "cross_check" : "respond");

    const input2 = inputFor(combo.skill, "r2");
    const replied = await replySession(begun.session_dir, { inputText: input2 });
    assert.equal(replied.round, 2);
    const w2 = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
    assert.equal(w2.status, "completed");

    const calls = codexCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt, renderExpected(combo.skill, combo.templates.round1, input1));
    assert.equal(calls[1].prompt, renderExpected(combo.skill, combo.templates.reply, input2));
    // reply without flags reuses the model and effort given to begin
    assert.ok(calls[1].args.includes("resume"));
    const mi = calls[1].args.indexOf("--model");
    assert.ok(mi >= 0 && calls[1].args[mi + 1] === "model-a", `resume args: ${calls[1].args.join(" ")}`);
    assert.ok(calls[1].args.includes("model_reasoning_effort=low"));

    await endSession(begun.session_dir);
  });
}

test("reply with a new model updates the stored model", async () => {
  resetLog();
  setCodexOutput("### VERDICT\n- Status: REVISE\n");
  const input = inputFor("codex-plan-review", "m");
  const begun = await beginSession({ skill: "codex-plan-review", inputText: input, workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const first = codexCalls()[0];
  assert.ok(!first.args.includes("--model"), "no model given → Codex default");
  await replySession(begun.session_dir, { inputText: input, model: "model-b" });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  await replySession(begun.session_dir, { inputText: input });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const calls = codexCalls();
  assert.equal(calls[2].args[calls[2].args.indexOf("--model") + 1], "model-b");
  await endSession(begun.session_dir);
});

// ---------- end ----------

test("end after APPROVE finalizes a plan review with the last round's verdict", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n- Reason: ok\n");
  const begun = await beginSession({ skill: "codex-plan-review", inputText: inputFor("codex-plan-review", "e"), workingDir: workDir });
  const w = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(w.next, "done");
  const ended = await endSession(begun.session_dir);
  assert.equal(ended.finalized, true);
  assert.equal(ended.verdict, "APPROVE");
  const meta = JSON.parse(fs.readFileSync(path.join(begun.session_dir, "meta.json"), "utf8"));
  assert.equal(meta.verdict, "APPROVE");
});

test("end while a plan review still needs a response only stops", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n");
  const begun = await beginSession({ skill: "codex-plan-review", inputText: inputFor("codex-plan-review", "e"), workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const ended = await endSession(begun.session_dir);
  assert.equal(ended.finalized, false);
  assert.ok(!fs.existsSync(path.join(begun.session_dir, "meta.json")));
});

test("peer end with outcome consensus finalizes as CONSENSUS; without outcome only stops", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: low\n\n### Overall Assessment\n- Code quality: ok\n\n### VERDICT\n- Status: CONSENSUS\n");
  const input = inputFor("codex-commit-review", "p");
  const a = await beginSession({ skill: "codex-commit-review", mode: "staged", inputText: input, workingDir: workDir });
  await waitSession(a.session_dir, { maxWaitSeconds: 30 });
  const endedA = await endSession(a.session_dir, { outcome: "consensus" });
  assert.equal(endedA.finalized, true);
  assert.equal(endedA.verdict, "CONSENSUS");

  const b = await beginSession({ skill: "codex-commit-review", mode: "staged", inputText: input, workingDir: workDir });
  await waitSession(b.session_dir, { maxWaitSeconds: 30 });
  const endedB = await endSession(b.session_dir);
  assert.equal(endedB.finalized, false);
  assert.ok(!fs.existsSync(path.join(b.session_dir, "meta.json")));
});

test("begin rejects a missing or unknown mode", async () => {
  await assert.rejects(
    beginSession({ skill: "codex-impl-review", inputText: "", workingDir: workDir }),
    e => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    beginSession({ skill: "codex-nope", inputText: "", workingDir: workDir }),
    e => e.code === "UNKNOWN_SKILL",
  );
});

// ---------- CLI ----------

test("CLI begin/wait/end round-trip with --input - and version 14", () => {
  assert.equal(execFileSync(process.execPath, [RUNNER, "version"], { encoding: "utf8" }).trim(), "14");
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  const begun = JSON.parse(execFileSync(process.execPath, [RUNNER, "begin", "--skill", "codex-plan-review", "--input", "-", "--working-dir", workDir], {
    input: inputFor("codex-plan-review", "cli"),
    encoding: "utf8",
  }));
  assert.equal(begun.status, "running");
  const waited = JSON.parse(execFileSync(process.execPath, [RUNNER, "wait", begun.session_dir, "--max-wait", "30"], { encoding: "utf8" }));
  assert.equal(waited.next, "done");
  const ended = JSON.parse(execFileSync(process.execPath, [RUNNER, "end", begun.session_dir], { encoding: "utf8" }));
  assert.equal(ended.finalized, true);
});
