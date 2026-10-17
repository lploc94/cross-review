#!/usr/bin/env node

/**
 * Verifies that a start without an explicit --timeout uses the documented
 * five-hour default without waiting for a real Codex turn to finish.
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
let sessionDir;

function run(command, args, stdin = "", env = process.env) {
  return execFileSync(NODE, [RUNNER, command, ...args], {
    input: stdin,
    encoding: "utf8",
    env,
    timeout: 15_000,
  }).trim();
}

function cleanup() {
  if (sessionDir) {
    try { run("stop", [sessionDir]); } catch {}
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-runner-default-timeout-"));
  const fakeBin = path.join(tempRoot, "bin");
  const workDir = path.join(tempRoot, "workspace");
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(workDir);

  // Keep the fake Codex alive so start records the running session state.
  writeFakeCli(fakeBin, "codex", "setInterval(() => {}, 1 << 30);\n");

  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
  };

  const initOutput = run("init", [
    "--skill-name", "review-impl",
    "--working-dir", workDir,
  ], "", env);
  assert(initOutput.startsWith("SESSION:"), "init returns SESSION prefix");
  sessionDir = initOutput.slice("SESSION:".length);

  const start = JSON.parse(run("start", [sessionDir], "default timeout test", env));
  assert(start.status === "started", `start status = ${start.status}`);

  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
  assert(
    state.timeout === EXPECTED_TIMEOUT_SECONDS,
    `default timeout = ${state.timeout}, expected ${EXPECTED_TIMEOUT_SECONDS}`,
  );

  console.log(`PASS: default timeout is ${EXPECTED_TIMEOUT_SECONDS}s (5h)`);
} finally {
  cleanup();
}
