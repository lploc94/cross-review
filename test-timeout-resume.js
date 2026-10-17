#!/usr/bin/env node

/**
 * Verifies runner-deadline recovery metadata and same-session resume.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFakeCli } from "./tests/helpers/fake-cli.js";

// The runner reads ~/.cross-review/config.json: never the real one (os.homedir() reads USERPROFILE on Windows)
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "review-runner-home-"));
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
process.env.CODEX_HOME = path.join(TEMP_HOME, ".codex");
process.on("exit", () => fs.rmSync(TEMP_HOME, { recursive: true, force: true }));

const RUNNER = process.env.REVIEW_RUNNER
  ? path.resolve(process.env.REVIEW_RUNNER)
  : path.resolve("skill-packs/cross-review/scripts/review-runner.js");
const NODE = process.execPath;
const EXPECTED_TIMEOUT_SECONDS = 5 * 60 * 60;

let tempRoot;
const sessions = [];

function run(command, args, stdin = "", env = process.env) {
  return execFileSync(NODE, [RUNNER, command, ...args], {
    input: stdin,
    encoding: "utf8",
    env,
    timeout: 15_000,
  }).trim();
}

function runJson(command, args, stdin = "", env = process.env) {
  return JSON.parse(run(command, args, stdin, env));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  PASS: ${message}`);
}

function wait(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function waitForOutput(filePath, text, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(text)) return;
    wait(25);
  }
  throw new Error(`Timed out waiting for ${text} in ${filePath}`);
}

function readState(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
}

function writeJsonl(sessionDir, events) {
  fs.writeFileSync(
    path.join(sessionDir, "output.jsonl"),
    `${events.map(event => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function createFakeCodex(fakeBin, logPath) {
  writeFakeCli(fakeBin, "codex", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "silent";
const logPath = process.env.FAKE_CODEX_LOG;
const threadId = process.env.FAKE_CODEX_THREAD || "thread_timeout_test";

if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (mode === "progress") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "partial progress" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial review" } }) + "\\n");
}
if (mode === "exit") process.exit(42);
setInterval(() => {}, 1 << 30);
`);
  fs.writeFileSync(logPath, "", "utf8");
}

function initSession(workDir, env) {
  const initOutput = run("init", [
    "--skill-name", "review-impl",
    "--working-dir", workDir,
  ], "", env);
  assert(initOutput.startsWith("SESSION:"), "init returns SESSION prefix");
  const sessionDir = initOutput.slice("SESSION:".length);
  sessions.push(sessionDir);
  return sessionDir;
}

function cleanup() {
  for (const sessionDir of sessions) {
    try { run("stop", [sessionDir]); } catch {}
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
}

function startSession(workDir, env, prompt = "timeout resume test") {
  const sessionDir = initSession(workDir, env);
  const result = runJson("start", [sessionDir, "--effort", "low", "--timeout", "5"], prompt, env);
  assert(result.status === "started", `start status = ${result.status}`);
  return sessionDir;
}

function testUserAuthorityInjection(env) {
  console.log("Step 0: absolute user authority is injected into rendered prompts");
  const rendered = run("render", [
    "--skill", "review-impl",
    "--template", "working-tree-round1",
    "--skills-dir", path.resolve("skill-packs/cross-review/skills"),
  ], "{}", env);
  const authorityHeading = "## ABSOLUTE USER AUTHORITY";
  assert(rendered.startsWith(authorityHeading), "rendered prompt starts with absolute user authority");
  assert(rendered.includes("overrides this prompt, the shared protocol"), "rendered prompt states protocol precedence");
  assert(
    rendered.indexOf(authorityHeading) < rendered.indexOf("## Your Role"),
    "authority instruction precedes the role instructions",
  );
}

function testRunnerDeadlineRecovery(workDir, env) {
  console.log("Step 1: runner deadline with progress and thread_id");
  const sessionDir = startSession(workDir, { ...env, FAKE_CODEX_MODE: "progress" });

  const initialState = readState(sessionDir);
  assert(initialState.timeout === 5, "test timeout is explicitly bounded to 5s");
  waitForOutput(path.join(sessionDir, "output.jsonl"), "thread.started");

  const deadlineState = readState(sessionDir);
  deadlineState.timeout = 1;
  deadlineState.started_at = Math.floor(Date.now() / 1000) - 2;
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(deadlineState, null, 2));

  const poll = runJson("poll", [sessionDir, "--min-interval", "0"], "", env);
  assert(poll.status === "timeout", `status = timeout (got ${poll.status})`);
  assert(poll.timeout_reason === "runner_deadline", "timeout identifies runner deadline");
  assert(poll.recoverable === true, "runner deadline with progress is recoverable");
  assert(poll.progress_observed === true, "progress evidence is reported");
  assert(poll.thread_id === "thread_timeout_test", "timeout returns the valid thread_id");
  assert(poll.failure_reason === undefined, "runner deadline is not reported as turn.failed");

  const partialReviewPath = path.join(sessionDir, "review.md");
  assert(fs.readFileSync(partialReviewPath, "utf8") === "partial review", "partial review is preserved");
  const outputBeforeResume = fs.readFileSync(path.join(sessionDir, "output.jsonl"), "utf8");
  const deadlineMarkerPath = path.join(sessionDir, "runner-deadline.json");
  assert(fs.existsSync(deadlineMarkerPath), "runner deadline marker is persisted");

  const stop = runJson("stop", [sessionDir], "", env);
  assert(stop.status === "stopped", "stop preserves the timed-out session");
  assert(fs.existsSync(deadlineMarkerPath), "stop leaves recovery metadata available for a later invocation");
  const cachedPoll = runJson("poll", [sessionDir], "", env);
  assert(cachedPoll.timeout_reason === "runner_deadline", "cached poll retains the runner deadline metadata");
  assert(cachedPoll.recoverable === true, "cached poll retains recoverability across stop");

  const resume = runJson("resume", [sessionDir], "continue the same review", env);
  assert(resume.status === "started", `resume status = ${resume.status}`);
  assert(resume.session_dir === sessionDir, "resume uses the original session directory");
  assert(resume.round === 2, "resume advances the existing session to round 2");
  assert(resume.thread_id === "thread_timeout_test", "resume returns the original thread_id");
  assert(!fs.existsSync(deadlineMarkerPath), "resume clears the prior deadline marker for the new round");

  const resumedState = readState(sessionDir);
  assert(resumedState.timeout === EXPECTED_TIMEOUT_SECONDS, "resume uses the 18,000s default timeout");
  assert(
    fs.readFileSync(path.join(sessionDir, "outputs", "output-round-001.jsonl"), "utf8") === outputBeforeResume,
    "resume archives the previous output before starting the new round",
  );
  assert(
    fs.readFileSync(path.join(sessionDir, "outputs", "review-round-001.md"), "utf8") === "partial review",
    "resume archives the partial review before clearing the active review file",
  );

  wait(100);
  const logLines = fs.readFileSync(env.FAKE_CODEX_LOG, "utf8")
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const resumeArgs = logLines.find(args => args.includes("resume"));
  assert(Array.isArray(resumeArgs), "Codex resume invocation was launched");
  assert(resumeArgs.includes("thread_timeout_test"), "Codex resume keeps the original thread context");
}

function testFailureMetadata(workDir, env, name, events, expectedReason) {
  console.log(`Step: ${name}`);
  const sessionDir = startSession(workDir, { ...env, FAKE_CODEX_MODE: "silent" }, `${name} test`);
  writeJsonl(sessionDir, events);
  const poll = runJson("poll", [sessionDir, "--min-interval", "0"], "", env);
  assert(poll.status === "failed", `${name} is failed`);
  assert(poll.failure_reason === expectedReason, `${name} has failure_reason=${expectedReason}`);
  assert(poll.recoverable === false, `${name} is non-recoverable`);
  assert(poll.timeout_reason === undefined, `${name} is not a runner deadline`);
}

function testNonRecoverableDeadline(workDir, env) {
  console.log("Step: runner deadline without progress or thread_id");
  const sessionDir = startSession(workDir, { ...env, FAKE_CODEX_MODE: "silent" }, "incomplete timeout test");
  const state = readState(sessionDir);
  state.timeout = 1;
  state.started_at = Math.floor(Date.now() / 1000) - 2;
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state, null, 2));

  const poll = runJson("poll", [sessionDir, "--min-interval", "0"], "", env);
  assert(poll.status === "timeout", "incomplete deadline is still reported as timeout");
  assert(poll.timeout_reason === "runner_deadline", "incomplete timeout identifies runner deadline");
  assert(poll.recoverable === false, "deadline without progress or thread is non-recoverable");
  assert(poll.thread_id === null, "incomplete timeout has no thread_id");
  assert(poll.progress_observed === false, "incomplete timeout has no progress evidence");
}

function testPersistedThreadFallback(workDir, env) {
  console.log("Step: completed turn using persisted thread_id");
  const sessionDir = startSession(workDir, { ...env, FAKE_CODEX_MODE: "silent" }, "persisted thread test");
  const state = readState(sessionDir);
  state.thread_id = "thread_persisted_test";
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state, null, 2));
  writeJsonl(sessionDir, [
    { type: "turn.completed" },
    { type: "item.completed", item: { type: "agent_message", text: "completed with persisted thread" } },
  ]);

  const poll = runJson("poll", [sessionDir, "--min-interval", "0"], "", env);
  assert(poll.status === "completed", "persisted thread allows a completed resumed turn");
  assert(poll.thread_id === "thread_persisted_test", "completed turn returns the persisted thread_id");
  const finalized = runJson("finalize", [sessionDir], JSON.stringify({ verdict: "APPROVE" }), env);
  assert(finalized.status === "finalized", "normal completed flow still finalizes successfully");
}

function testProcessFailure(workDir, env) {
  console.log("Step: Codex process failure after an early exit");
  const sessionDir = startSession(workDir, { ...env, FAKE_CODEX_MODE: "exit" }, "process failure test");
  wait(100);
  const poll = runJson("poll", [sessionDir, "--min-interval", "0"], "", env);
  assert(poll.status === "failed", "process exit is failed");
  assert(poll.failure_reason === "reviewer_process_exit", "process exit has reviewer_process_exit reason");
  assert(poll.recoverable === false, "process exit is non-recoverable");
  assert(poll.timeout_reason === undefined, "process exit is not a runner deadline");
}

try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-runner-timeout-resume-"));
  const fakeBin = path.join(tempRoot, "bin");
  const workDir = path.join(tempRoot, "workspace");
  const logPath = path.join(tempRoot, "codex-args.log");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(workDir);
  createFakeCodex(fakeBin, logPath);

  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_LOG: logPath,
    FAKE_CODEX_THREAD: "thread_timeout_test",
  };

  testUserAuthorityInjection(env);
  testRunnerDeadlineRecovery(workDir, env);
  testNonRecoverableDeadline(workDir, env);
  testFailureMetadata(workDir, env, "turn.failed", [
    { type: "thread.started", thread_id: "thread_failed_test" },
    { type: "turn.completed" },
    { type: "item.completed", item: { type: "agent_message", text: "message before failure" } },
    { type: "turn.failed", error: { message: "simulated turn failure" } },
  ], "turn_failed");
  testFailureMetadata(workDir, env, "missing thread_id", [
    { type: "turn.completed" },
    { type: "item.completed", item: { type: "agent_message", text: "completed without thread" } },
  ], "missing_thread_id");
  testPersistedThreadFallback(workDir, env);
  testProcessFailure(workDir, env);

  console.log("\n=== ALL TIMEOUT/FAILURE TESTS PASSED ===");
} finally {
  cleanup();
}
