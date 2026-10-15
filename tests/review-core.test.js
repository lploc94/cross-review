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
  hooks,
  replySession,
  waitSession,
} from "../skill-packs/cross-review/scripts/lib/review-core.js";
import { followInDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/follow.js";
import { writeFakeCodex } from "./helpers/fake-codex.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "skill-packs/cross-review/scripts/review-runner.js");
const SKILLS_DIR = path.join(ROOT, "skill-packs/cross-review/skills");

let tmp;
let workDir;
let logPath;
let outputPath;

const savedHome = process.env.HOME;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-core-test-"));
  // begin reads ~/.cross-review/config.json: never the real one
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME);
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
  process.env.HOME = savedHome;
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
    .filter(n => n !== "OUTPUT_FORMAT" && n !== "ANALYSIS_FORMAT");
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

const PLAN = { skill_name: "review-plan" };
const PR = { skill_name: "review-pr" };
const THINK = { skill_name: "review-think" };

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
  const r = computeNext({ status: "completed", review: { blocks: [], verdict: { status: "STALEMATE" } }, convergence: { stalemate: false } }, PR);
  assert.deepEqual(r, { next: "done", next_reason: "stalemate" });
});

test("computeNext: think-about suggested_status STALEMATE ends the review", () => {
  const r = computeNext({ status: "completed", review: { format: "think-about", suggested_status: "STALEMATE" } }, THINK);
  assert.equal(r.next, "done");
});

test("computeNext: RESPONSE-only round of a plan review is answered", () => {
  const r = computeNext({ status: "completed", review: { format: "response", blocks: [{ id: 1, prefix: "RESPONSE" }], verdict: { status: "REVISE" } } }, PLAN);
  assert.equal(r.next, "respond");
});

test("computeNext: peer skill with Codex CONSENSUS goes to cross_check, not done", () => {
  const r = computeNext({ status: "completed", review: { blocks: [], verdict: { status: "CONSENSUS" } } }, PR);
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
  assert.deepEqual(computeNext({ status: "failed", failure_reason: "reviewer_process_exit" }, PLAN), { next: "stopped", next_reason: "reviewer_process_exit" });
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

test("parseReviewInput: scalar lines before the first section count without --- fences", () => {
  const names = new Set(["PLAN_PATH", "BASE_BRANCH", "USER_REQUEST"]);
  const v = parseReviewInput("PLAN_PATH: /tmp/p.md\nBASE_BRANCH: main\nNOTE: ignored\n\n## USER_REQUEST\nDo X\nBASE_BRANCH: stays text\n", names);
  assert.deepEqual(v, { PLAN_PATH: "/tmp/p.md", BASE_BRANCH: "main", USER_REQUEST: "Do X\nBASE_BRANCH: stays text" });
});

test("parseReviewInput: CRLF input parses like LF", () => {
  const names = new Set(["USER_REQUEST", "PLAN_PATH"]);
  const v = parseReviewInput("---\r\nPLAN_PATH: /tmp/plan.md\r\n---\r\n## USER_REQUEST\r\nReview this plan\r\nline 2\r\n", names);
  assert.deepEqual(v, { PLAN_PATH: "/tmp/plan.md", USER_REQUEST: "Review this plan\nline 2" });
});

// ---------- .gitignore ----------

test("init writes .cross-review/.gitignore once and never overwrites it", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "gi-"));
  execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "review-plan", "--working-dir", dir], { encoding: "utf8" });
  const gi = path.join(dir, ".cross-review", ".gitignore");
  assert.equal(fs.readFileSync(gi, "utf8"), "*\n");
  fs.writeFileSync(gi, "custom\n");
  execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "review-plan", "--working-dir", dir], { encoding: "utf8" });
  assert.equal(fs.readFileSync(gi, "utf8"), "custom\n");
});

// ---------- begin → wait → reply → wait for every skill/mode ----------

const COMBOS = [];
for (const [skill, entry] of Object.entries(SKILL_TEMPLATES)) {
  for (const [mode, templates] of Object.entries(entry.modes)) {
    COMBOS.push({ skill, mode: mode === "default" ? undefined : mode, templates, peer: entry.peer });
  }
}

test("there are 5 skill/mode combinations", () => {
  assert.equal(COMBOS.length, 5);
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

test("a round that failed mid-turn resumes the same reviewer thread after review_end", async () => {
  resetLog();
  process.env.FAKE_CODEX_FAIL = "You've hit your usage limit.";
  let begun;
  try {
    begun = await beginSession({ skill: "review-impl", mode: "working-tree", inputText: inputFor("review-impl", "q1"), workingDir: workDir });
    const failed = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
    assert.equal(failed.next, "stopped");
    assert.equal(failed.thread_id, "thread-fake-1");
    await endSession(begun.session_dir);
  } finally {
    delete process.env.FAKE_CODEX_FAIL;
  }

  // After a new login the user asks to resume: the same thread continues, no new session
  setCodexOutput("### VERDICT\n- Status: APPROVE\n- Reason: ok\n");
  const replied = await replySession(begun.session_dir, { inputText: inputFor("review-impl", "q2") });
  assert.equal(replied.round, 2);
  assert.equal(replied.thread_id, "thread-fake-1");
  const done = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(done.next, "done");
  const calls = codexCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("resume") && calls[1].args.includes("thread-fake-1"), `resume args: ${calls[1].args.join(" ")}`);
  await endSession(begun.session_dir);
});

test("every review skill starts and resumes Codex with full access for verification commands", async () => {
  setCodexOutput("### Key Insights\n- a\n\n### Suggested Status\nCONTINUE\n");
  resetLog();
  const t = await beginSession({ skill: "review-think", inputText: inputFor("review-think", "sb"), workingDir: workDir });
  await waitSession(t.session_dir, { maxWaitSeconds: 30 });
  setCodexOutput("### ISSUE-1: Something\n- Category: correctness\n- Severity: high\n- Problem: p\n\n### VERDICT\n- Status: REVISE\n");
  const p = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "sb"), workingDir: workDir });
  await waitSession(p.session_dir, { maxWaitSeconds: 30 });
  await replySession(p.session_dir, { inputText: inputFor("review-plan", "sb2") });
  await waitSession(p.session_dir, { maxWaitSeconds: 30 });
  const calls = codexCalls();
  assert.equal(calls.length, 3);
  const [thinkStart, planStart, planResume] = calls;
  for (const call of [thinkStart, planStart]) {
    assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "danger-full-access", call.args.join(" "));
  }
  assert.ok(planResume.args.includes("resume"), "third call resumes the plan review");
  assert.ok(planResume.args.includes('sandbox_mode="danger-full-access"'), planResume.args.join(" "));
  await endSession(t.session_dir);
  await endSession(p.session_dir);
});

test("the session remembers its reviewer; codex is the default", async () => {
  setCodexOutput("### VERDICT\n- Status: REVISE\n");
  const input = inputFor("review-plan", "rv");
  const named = await beginSession({ skill: "review-plan", inputText: input, workingDir: workDir, reviewer: "codex" });
  const unnamed = await beginSession({ skill: "review-plan", inputText: input, workingDir: workDir });
  for (const s of [named, unnamed]) {
    await waitSession(s.session_dir, { maxWaitSeconds: 30 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.session_dir, "state.json"), "utf8")).reviewer, "codex");
    await endSession(s.session_dir);
  }
});

test("an unknown reviewer is rejected before any session is created", async () => {
  const sessions = path.join(workDir, ".cross-review", "sessions");
  const before = fs.existsSync(sessions) ? fs.readdirSync(sessions).length : 0;
  // Names an object inherits are not reviewers either
  for (const reviewer of ["nope", "toString", "constructor", "__proto__"]) {
    await assert.rejects(
      beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "x"), workingDir: workDir, reviewer }),
      e => e.code === "UNKNOWN_REVIEWER" && /Available: codex/.test(e.message),
      reviewer,
    );
  }
  assert.equal(fs.existsSync(sessions) ? fs.readdirSync(sessions).length : 0, before);
});

test("a session whose state predates the reviewer field still resumes with codex", async () => {
  resetLog();
  setCodexOutput("### VERDICT\n- Status: REVISE\n");
  const input = inputFor("review-plan", "old");
  const begun = await beginSession({ skill: "review-plan", inputText: input, workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const stateFile = path.join(begun.session_dir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  delete state.reviewer;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await replySession(begun.session_dir, { inputText: input });
  const w = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(w.status, "completed");
  assert.ok(codexCalls()[1].args.includes("resume"));
  await endSession(begun.session_dir);
});

test("reply with a new model updates the stored model", async () => {
  resetLog();
  setCodexOutput("### VERDICT\n- Status: REVISE\n");
  const input = inputFor("review-plan", "m");
  const begun = await beginSession({ skill: "review-plan", inputText: input, workingDir: workDir });
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

test("a relative skillsDir is stored absolute, so reply works from another cwd", async () => {
  setCodexOutput("### VERDICT\n- Status: REVISE\n");
  const input = inputFor("review-plan", "rel");
  const cwd = process.cwd();
  process.chdir(ROOT);
  let begun;
  try {
    begun = await beginSession({ skill: "review-plan", inputText: input, workingDir: workDir, skillsDir: "skill-packs/cross-review/skills" });
  } finally {
    process.chdir(cwd);
  }
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  process.chdir(tmp);
  try {
    const replied = await replySession(begun.session_dir, { inputText: input });
    assert.equal(replied.round, 2);
  } finally {
    process.chdir(cwd);
  }
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  await endSession(begun.session_dir);
});

test("wait returns activities from polls made before its deadline", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  process.env.FAKE_CODEX_SLOW_MS = "4000";
  try {
    const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "act"), workingDir: workDir });
    await new Promise(r => setTimeout(r, 500));
    const w1 = await waitSession(begun.session_dir, { maxWaitSeconds: 1 });
    assert.equal(w1.status, "running");
    assert.ok(w1.activities.length > 0, "activities from the in-call poll are returned");
    const w2 = await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
    assert.equal(w2.status, "completed");
    assert.equal(w2.next, "done");
    await endSession(begun.session_dir);
  } finally {
    delete process.env.FAKE_CODEX_SLOW_MS;
  }
});

// ---------- end ----------

test("end after APPROVE finalizes a plan review with the last round's verdict", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n- Reason: ok\n");
  const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "e"), workingDir: workDir });
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
  const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "e"), workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const ended = await endSession(begun.session_dir);
  assert.equal(ended.finalized, false);
  assert.ok(!fs.existsSync(path.join(begun.session_dir, "meta.json")));
});

test("peer end with outcome consensus finalizes as CONSENSUS; without outcome only stops", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: low\n\n### Overall Assessment\n- Code quality: ok\n\n### VERDICT\n- Status: CONSENSUS\n");
  const input = inputFor("review-pr", "p");
  const a = await beginSession({ skill: "review-pr", inputText: input, workingDir: workDir });
  await waitSession(a.session_dir, { maxWaitSeconds: 30 });
  const endedA = await endSession(a.session_dir, { outcome: "consensus" });
  assert.equal(endedA.finalized, true);
  assert.equal(endedA.verdict, "CONSENSUS");

  const b = await beginSession({ skill: "review-pr", inputText: input, workingDir: workDir });
  await waitSession(b.session_dir, { maxWaitSeconds: 30 });
  const endedB = await endSession(b.session_dir);
  assert.equal(endedB.finalized, false);
  assert.ok(!fs.existsSync(path.join(b.session_dir, "meta.json")));
});

test("CLI end exits non-zero when finalize fails", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "ef"), workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  fs.mkdirSync(path.join(begun.session_dir, "meta.json", "blocker"), { recursive: true });
  let failed = null;
  try {
    execFileSync(process.execPath, [RUNNER, "end", begun.session_dir], { encoding: "utf8" });
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, "end must exit non-zero");
  const out = JSON.parse(failed.stdout);
  assert.equal(out.finalized, false);
  assert.ok(out.error);
});

test("begin rejects a missing or unknown mode", async () => {
  await assert.rejects(
    beginSession({ skill: "review-impl", inputText: "", workingDir: workDir }),
    e => e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    beginSession({ skill: "review-nope", inputText: "", workingDir: workDir }),
    e => e.code === "UNKNOWN_SKILL",
  );
});

// ---------- CLI ----------

test("CLI begin/wait/end round-trip with --input - and version 15", () => {
  assert.equal(execFileSync(process.execPath, [RUNNER, "version"], { encoding: "utf8" }).trim(), "15");
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  const begun = JSON.parse(execFileSync(process.execPath, [RUNNER, "begin", "--skill", "review-plan", "--input", "-", "--working-dir", workDir], {
    input: inputFor("review-plan", "cli"),
    encoding: "utf8",
  }));
  assert.equal(begun.status, "running");
  const waited = JSON.parse(execFileSync(process.execPath, [RUNNER, "wait", begun.session_dir, "--max-wait", "30"], { encoding: "utf8" }));
  assert.equal(waited.next, "done");
  const ended = JSON.parse(execFileSync(process.execPath, [RUNNER, "end", begun.session_dir], { encoding: "utf8" }));
  assert.equal(ended.finalized, true);
});

// ---------- records for the dashboard ----------

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
const completeLines = f => (fs.readFileSync(f, "utf8").match(/\n/g) || []).length;
const timesRows = (dir, round) => {
  const f = path.join(dir, "outputs", `times-round-${String(round).padStart(3, "0")}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};
const lastCount = rows => (rows.length ? rows[rows.length - 1][0] : 0);
const aliveNow = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("begin and reply keep each round's raw input", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n");
  const a = "---\nPLAN_PATH: /tmp/a-plan.md\n---\n## USER_REQUEST\nfirst  round\r\n\ttabs kept\n";
  const b = "PLAN_PATH: /tmp/a-plan.md\n## FIXED_ITEMS\nISSUE-1: x — fixed in a.md:3\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n";
  const begun = await beginSession({ skill: "review-plan", inputText: a, workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  await replySession(begun.session_dir, { inputText: b });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(fs.readFileSync(path.join(begun.session_dir, "inputs", "round-001.md"), "utf8"), a);
  assert.equal(fs.readFileSync(path.join(begun.session_dir, "inputs", "round-002.md"), "utf8"), b);
  await endSession(begun.session_dir);
});

test("a reply whose resume fails writes no input file", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n");
  const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "nf"), workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  const savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    await assert.rejects(replySession(begun.session_dir, { inputText: inputFor("review-plan", "nf2") }), e => e.code === "REVIEWER_NOT_FOUND");
  } finally {
    process.env.PATH = savedPath;
  }
  assert.ok(fs.existsSync(path.join(begun.session_dir, "inputs", "round-001.md")));
  assert.ok(!fs.existsSync(path.join(begun.session_dir, "inputs", "round-002.md")));
  await endSession(begun.session_dir);
});

test("end records ended_at and outcome; a later reply clears them", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n- Reason: ok\n");
  const ok = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "ea"), workingDir: workDir });
  await waitSession(ok.session_dir, { maxWaitSeconds: 30 });
  const before = Math.floor(Date.now() / 1000);
  await endSession(ok.session_dir);
  let st = readJson(path.join(ok.session_dir, "state.json"));
  assert.equal(st.end_outcome, "finalized");
  assert.ok(st.ended_at >= before && st.ended_at <= before + 30);

  setCodexOutput("### ISSUE-1: x\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n");
  const rev = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "eb"), workingDir: workDir });
  await waitSession(rev.session_dir, { maxWaitSeconds: 30 });
  await endSession(rev.session_dir);
  st = readJson(path.join(rev.session_dir, "state.json"));
  assert.equal(st.end_outcome, "stopped");
  assert.ok(st.ended_at > 0);

  await replySession(rev.session_dir, { inputText: inputFor("review-plan", "ec") });
  st = readJson(path.join(rev.session_dir, "state.json"));
  assert.equal(st.ended_at, null);
  assert.equal(st.end_outcome, null);
  await waitSession(rev.session_dir, { maxWaitSeconds: 30 });
  await endSession(rev.session_dir);
});

test("CLI begin stores no caller", () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  const begun = JSON.parse(execFileSync(process.execPath, [RUNNER, "begin", "--skill", "review-plan", "--input", "-", "--working-dir", workDir], {
    input: inputFor("review-plan", "nc"), encoding: "utf8",
  }));
  assert.equal(readJson(path.join(begun.session_dir, "state.json")).caller, undefined);
  execFileSync(process.execPath, [RUNNER, "end", begun.session_dir], { encoding: "utf8" });
});

test("the watchdog stamps output lines and exits after the reviewer", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  process.env.FAKE_CODEX_STEPS = "4";
  process.env.FAKE_CODEX_STEP_MS = "1200";
  try {
    // Low-level start without any poll: only the watchdog can stamp lines and notice the exit
    const init = execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "review-plan", "--working-dir", workDir], { encoding: "utf8" }).trim();
    const dir = init.slice("SESSION:".length);
    execFileSync(process.execPath, [RUNNER, "start", dir], { input: "prompt", encoding: "utf8" });
    const st = readJson(path.join(dir, "state.json"));
    await until(() => !aliveNow(st.pid), 20000, "reviewer exit");
    const done = Math.floor(Date.now() / 1000);
    await until(() => !aliveNow(st.watchdog_pid), 5000, "watchdog exit");
    const rows = timesRows(dir, 1);
    assert.ok(rows.length >= 2, `rows: ${JSON.stringify(rows)}`);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i][0] > rows[i - 1][0], "counts strictly increase");
      assert.ok(rows[i][1] >= rows[i - 1][1], "epochs never decrease");
    }
    assert.ok(rows[rows.length - 1][1] > rows[0][1], "rows come from different seconds");
    assert.ok(rows[0][1] >= st.started_at && rows[rows.length - 1][1] <= done + 2);
    assert.equal(lastCount(rows), completeLines(path.join(dir, "output.jsonl")));
    execFileSync(process.execPath, [RUNNER, "stop", dir], { encoding: "utf8" });
  } finally {
    delete process.env.FAKE_CODEX_STEPS;
    delete process.env.FAKE_CODEX_STEP_MS;
  }
});

test("output written while the deadline stops the reviewer is stamped", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  process.env.FAKE_CODEX_TERM_LINE = "1";
  try {
    const init = execFileSync(process.execPath, [RUNNER, "init", "--skill-name", "review-plan", "--working-dir", workDir], { encoding: "utf8" }).trim();
    const dir = init.slice("SESSION:".length);
    execFileSync(process.execPath, [RUNNER, "start", dir, "--timeout", "2"], { input: "prompt", encoding: "utf8" });
    const st = readJson(path.join(dir, "state.json"));
    // Deadline at 2 s, then the watchdog's SIGTERM, a 2 s grace period and the watchdog's exit; no poll
    await until(() => !aliveNow(st.watchdog_pid), 15000, "watchdog exit");
    const out = fs.readFileSync(path.join(dir, "output.jsonl"), "utf8");
    assert.ok(out.includes("on_term"), "the reviewer wrote while being stopped");
    assert.equal(lastCount(timesRows(dir, 1)), completeLines(path.join(dir, "output.jsonl")));
    execFileSync(process.execPath, [RUNNER, "stop", dir], { encoding: "utf8" });
  } finally {
    delete process.env.FAKE_CODEX_TERM_LINE;
  }
});

test("a review that ends before the first tick still has every line stamped", async () => {
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  const begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "ft"), workingDir: workDir });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(lastCount(timesRows(begun.session_dir, 1)), completeLines(path.join(begun.session_dir, "output.jsonl")));
  await endSession(begun.session_dir);
});

test("stop and resume flush the round's line times", async () => {
  setCodexOutput("### ISSUE-1: x\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n");
  process.env.FAKE_CODEX_SLOW_MS = "20000";
  let begun;
  try {
    begun = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "sr"), workingDir: workDir });
    await until(() => fs.existsSync(path.join(begun.session_dir, "output.jsonl")) && completeLines(path.join(begun.session_dir, "output.jsonl")) >= 2, 10000, "first events");
    // One poll records the thread id, so the stopped round can be resumed
    await waitSession(begun.session_dir, { maxWaitSeconds: 0 });
    // Kill the watchdog first, so only stop itself can stamp the line written next
    const wd = readJson(path.join(begun.session_dir, "state.json")).watchdog_pid;
    process.kill(wd, "SIGKILL");
    await until(() => !aliveNow(wd), 3000, "watchdog killed");
    fs.appendFileSync(path.join(begun.session_dir, "output.jsonl"), JSON.stringify({ type: "item.completed", item: { id: "late", type: "reasoning", text: "late" } }) + "\n");
    // Stop right away: the watchdog may not have ticked since the last line appeared
    await endSession(begun.session_dir);
  } finally {
    delete process.env.FAKE_CODEX_SLOW_MS;
  }
  const r1Lines = completeLines(path.join(begun.session_dir, "output.jsonl"));
  assert.equal(lastCount(timesRows(begun.session_dir, 1)), r1Lines);

  await replySession(begun.session_dir, { inputText: inputFor("review-plan", "sr2") });
  await waitSession(begun.session_dir, { maxWaitSeconds: 30 });
  assert.equal(lastCount(timesRows(begun.session_dir, 1)), completeLines(path.join(begun.session_dir, "outputs", "output-round-001.jsonl")));
  const r2 = timesRows(begun.session_dir, 2);
  assert.ok(r2.length >= 1);
  assert.equal(lastCount(r2), completeLines(path.join(begun.session_dir, "output.jsonl")));
  await endSession(begun.session_dir);
});

test("flushLineTimes adds at most one row when nothing new was written", async () => {
  const { flushLineTimes, readLineTimes } = await import("../skill-packs/cross-review/scripts/lib/line-times.js");
  const dir = fs.mkdtempSync(path.join(tmp, "lt-"));
  fs.mkdirSync(path.join(dir, "outputs"));
  fs.writeFileSync(path.join(dir, "output.jsonl"), "{\"a\":1}\n{\"b\":2}\n{\"partial\":");
  assert.equal(flushLineTimes(dir, 1), 2);
  assert.equal(flushLineTimes(dir, 1), 2);
  assert.equal(readLineTimes(dir, 1).length, 1);
  fs.appendFileSync(path.join(dir, "output.jsonl"), "3}\n");
  const cursor = {};
  assert.equal(flushLineTimes(dir, 1, cursor), 3);
  assert.equal(flushLineTimes(dir, 1, cursor), 3);
  assert.deepEqual(readLineTimes(dir, 1).map(r => r[0]), [2, 3]);
  // No output file, bad round: no row, no throw
  assert.equal(flushLineTimes(path.join(dir, "missing"), 1), null);
  assert.equal(flushLineTimes(dir, 0), null);
});

// ---------- settings from the two config levels ----------

const globalConfig = () => path.join(process.env.HOME, ".cross-review", "config.json");
function putConfig(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function freshWorkspace(name) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(tmp, `${name}-`)));
  return ws;
}
const stateOf = dir => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const argAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("global effort reaches the reviewer with its source; a requested effort wins", async () => {
  const ws = freshWorkspace("global-effort");
  putConfig(globalConfig(), { effort: "xhigh" });
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  try {
    resetLog();
    const a = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "ge"), workingDir: ws });
    await waitSession(a.session_dir, { maxWaitSeconds: 30 });
    assert.equal(argAfter(codexCalls()[0].args, "--config"), "model_reasoning_effort=xhigh");
    assert.equal(argAfter(codexCalls()[0].args, "--model"), undefined, "no model configured: Codex picks");
    assert.deepEqual(stateOf(a.session_dir).settings_sources, { reviewer: "default", model: "default", effort: "global", open_dashboard: "default" });
    resetLog();
    const b = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "ge"), workingDir: ws, effort: "low" });
    await waitSession(b.session_dir, { maxWaitSeconds: 30 });
    assert.equal(argAfter(codexCalls()[0].args, "--config"), "model_reasoning_effort=low");
    assert.equal(stateOf(b.session_dir).settings_sources.effort, "requested");
    assert.equal(stateOf(b.session_dir).effort, "low");
    await endSession(a.session_dir);
    await endSession(b.session_dir);
  } finally {
    fs.rmSync(globalConfig(), { force: true });
  }
});

test("a workspace per-skill model is passed as --model; other skills there keep the default", async () => {
  const ws = freshWorkspace("ws-model");
  putConfig(path.join(ws, ".cross-review", "config.json"), { skills: { "review-impl": { model: "model-invented-1" } } });
  setCodexOutput("### VERDICT\n- Status: APPROVE\n");
  resetLog();
  const s = await beginSession({ skill: "review-impl", mode: "working-tree", inputText: inputFor("review-impl", "wm"), workingDir: ws });
  await waitSession(s.session_dir, { maxWaitSeconds: 30 });
  assert.equal(argAfter(codexCalls()[0].args, "--model"), "model-invented-1");
  assert.equal(stateOf(s.session_dir).settings_sources.model, "workspace:review-impl");
  resetLog();
  const p = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "wm"), workingDir: ws });
  await waitSession(p.session_dir, { maxWaitSeconds: 30 });
  assert.equal(argAfter(codexCalls()[0].args, "--model"), undefined);
  await endSession(s.session_dir);
  await endSession(p.session_dir);
});

test("a broken config rejects begin with CONFIG_INVALID before any session exists", async () => {
  const ws = freshWorkspace("broken");
  putConfig(path.join(ws, ".cross-review", "config.json"), "{ broken");
  resetLog();
  await assert.rejects(
    beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "bc"), workingDir: ws }),
    e => e.code === "CONFIG_INVALID" && e.message.includes(path.join(ws, ".cross-review", "config.json")),
  );
  assert.equal(fs.existsSync(path.join(ws, ".cross-review", "sessions")), false);
  putConfig(globalConfig(), { skills: { "review-nope": {} } });
  try {
    await assert.rejects(beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "bc"), workingDir: freshWorkspace("broken-g") }), e => e.code === "CONFIG_INVALID");
  } finally {
    fs.rmSync(globalConfig(), { force: true });
  }
  assert.equal(codexCalls().length, 0);
});

test("open_dashboard: a dashboard that cannot start only adds dashboard_error; unset, nothing is called", async () => {
  const ws = freshWorkspace("follow");
  const saved = hooks.follow;
  let calls = 0;
  try {
    hooks.follow = () => { calls++; return { url: "unused" }; };
    setCodexOutput("### VERDICT\n- Status: APPROVE\n");
    const quiet = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "of"), workingDir: ws });
    assert.equal(calls, 0);
    assert.equal(quiet.dashboard_url, undefined);
    await waitSession(quiet.session_dir, { maxWaitSeconds: 30 });
    await endSession(quiet.session_dir);

    putConfig(path.join(ws, ".cross-review", "config.json"), { open_dashboard: true });
    const opened = [];
    hooks.follow = args => followInDashboard({ ...args, spawnDashboard: () => {}, waitMs: 300, openBrowser: url => opened.push(url) });
    resetLog();
    const s = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "of"), workingDir: ws });
    assert.ok(s.session_dir);
    assert.match(s.dashboard_error, /did not start/);
    assert.equal(s.dashboard_url, undefined);
    assert.deepEqual(opened, []);
    assert.equal(stateOf(s.session_dir).settings_sources.open_dashboard, "workspace");
    const done = await waitSession(s.session_dir, { maxWaitSeconds: 30 });
    assert.equal(done.next, "done", "the reviewer ran anyway");

    hooks.follow = () => { throw new Error("invented failure"); };
    const t = await beginSession({ skill: "review-plan", inputText: inputFor("review-plan", "of"), workingDir: ws });
    assert.match(t.dashboard_error, /invented failure/);
    await waitSession(t.session_dir, { maxWaitSeconds: 30 });
    await endSession(s.session_dir);
    await endSession(t.session_dir);
  } finally {
    hooks.follow = saved;
  }
});
