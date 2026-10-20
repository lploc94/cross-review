import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as claude from "../skill-packs/cross-review/scripts/lib/reviewers/claude.js";
import { getReviewer, REVIEWER_NAMES } from "../skill-packs/cross-review/scripts/lib/reviewers/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fixtures", "claude-turn.jsonl");
const lines = () => fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const j = e => JSON.stringify(e);

test("claude is a registered reviewer", () => {
  assert.ok(REVIEWER_NAMES.includes("claude"));
  assert.equal(getReviewer("claude"), getReviewer("claude"));
  assert.equal(getReviewer("claude").label, "Claude Code");
});

test("buildCommand: new and resumed turns, both sandboxes, with and without a model", () => {
  const base = ["-p", "--output-format", "stream-json", "--verbose", "--effort", "xhigh", "--disallowedTools", "ReportFindings"];
  assert.deepEqual(
    claude.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "xhigh", sandbox: "danger-full-access" }),
    { cmd: "claude", args: [...base, "--dangerously-skip-permissions"], cwd: "/w" },
  );
  assert.deepEqual(
    claude.buildCommand({ threadId: "", workingDir: "/w", model: "opus", effort: "xhigh", sandbox: "read-only" }).args,
    [...base, "--model", "opus", "--permission-mode", "plan"],
  );
  assert.deepEqual(
    claude.buildCommand({ threadId: "sid-9", workingDir: "/w", model: "sonnet", effort: "low", sandbox: "danger-full-access" }).args,
    ["-p", "--output-format", "stream-json", "--verbose", "--effort", "low", "--disallowedTools", "ReportFindings", "--model", "sonnet", "--dangerously-skip-permissions", "--resume", "sid-9"],
  );
  // ReportFindings sends a review to the host UI, so its findings and verdict never reach the
  // event log the runner parses; every turn, new or resumed, leaves it out
  for (const threadId of ["", "sid-9"]) {
    for (const sandbox of ["danger-full-access", "read-only"]) {
      const args = claude.buildCommand({ threadId, workingDir: "/w", model: null, effort: "high", sandbox }).args;
      assert.equal(args[args.indexOf("--disallowedTools") + 1], "ReportFindings");
    }
  }
  const ro = claude.buildCommand({ threadId: "sid-9", workingDir: "/w", model: undefined, effort: "high", sandbox: "read-only" }).args;
  assert.ok(!ro.includes("--model") && !ro.includes("--dangerously-skip-permissions"));
  assert.deepEqual(ro.slice(-4), ["--permission-mode", "plan", "--resume", "sid-9"]);
});

test("parseEvents: a completed turn gives the session id, the review and its activities", () => {
  const all = lines();
  const ev = claude.parseEvents(all, all, 12);
  assert.equal(ev.turnCompleted, true);
  assert.equal(ev.turnFailed, false);
  assert.equal(ev.threadId, "5f0c1e2a-0000-4000-8000-00000000c1a0");
  assert.match(ev.reviewText, /^### ISSUE-1: Basket skips the first line/);
  assert.equal(ev.progressObserved, true);
  assert.deepEqual(ev.activities.map(a => [a.type, a.detail]), [
    ["thinking", "Look at the diff first."],
    ["command_started", "git diff"],
    ["command_completed", "git diff"],
    ["command_started", "npm test"],
    ["command_completed", "npm test"],
  ]);
  assert.ok(ev.activities.every(a => a.time === 12));
});

test("parseEvents: activities come only from the new lines", () => {
  const all = lines();
  const ev = claude.parseEvents(all, all.slice(4), 30);
  assert.deepEqual(ev.activities.map(a => [a.type, a.detail]), [["command_started", "npm test"], ["command_completed", "npm test"]]);
});

test("parseEvents: is_error fails the turn even with subtype success", () => {
  const all = [
    j({ type: "system", subtype: "init", session_id: "s1" }),
    j({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "There's an issue with the selected model (gpt-x)." }] }, session_id: "s1" }),
    j({ type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model (gpt-x).", session_id: "s1" }),
  ];
  const ev = claude.parseEvents(all, all, 1);
  assert.equal(ev.turnFailed, true);
  assert.equal(ev.turnCompleted, false);
  assert.match(ev.failMessage, /selected model \(gpt-x\)/);
  assert.equal(ev.reviewText, "");
  const noText = claude.parseEvents([j({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bang"], session_id: "s1" })], [], 1);
  assert.equal(noText.failMessage, "boom; bang");
});

test("parseEvents: only the init line is a running turn with its session id", () => {
  const all = [j({ type: "system", subtype: "init", session_id: "s2" })];
  const ev = claude.parseEvents(all, all, 1);
  assert.deepEqual([ev.turnCompleted, ev.turnFailed, ev.threadId, ev.progressObserved], [false, false, "s2", false]);
});

test("activityItems: every kind, results applied to their tool call, the final message left out", () => {
  const items = claude.activityItems(lines());
  assert.deepEqual(items.map(i => [i.kind, i.line]), [
    ["reasoning", 1], ["command", 2], ["tool", 5], ["command", 7], ["message", 9],
  ]);
  const [, diff, read, test_, note] = items;
  assert.deepEqual([diff.command, diff.status, diff.exitCode, diff.lastLine], ["git diff", "completed", 0, 3]);
  assert.deepEqual([read.tool, read.text, read.status], ["Read", "/tmp/invented-shop/basket.js", "completed"]);
  assert.deepEqual([test_.command, test_.status, test_.exitCode], ["npm test", "failed", 2]);
  assert.equal(note.text, "Checking the totals next.");
  assert.ok(!items.some(i => /VERDICT/.test(i.text || "")));
});

test("activityItems: a running turn keeps its last message and an open command", () => {
  const items = claude.activityItems(lines().slice(0, 8));
  assert.equal(items.at(-1).kind, "command");
  assert.deepEqual([items.at(-1).status, items.at(-1).exitCode], ["in_progress", null]);
  const edit = claude.activityItems([j({ type: "assistant", message: { id: "e", content: [{ type: "tool_use", id: "w1", name: "Edit", input: { file_path: "/x/a.js" } }] } })]);
  assert.deepEqual(edit.map(i => [i.kind, i.path]), [["file_change", "/x/a.js"]]);
});

test("the incremental fold equals the one-shot fold", () => {
  const all = lines();
  const s = claude.newLogState();
  claude.foldLog(s, all.slice(0, 5));
  claude.foldLog(s, all.slice(5));
  assert.deepEqual(claude.logItems(s), claude.activityItems(all));
  assert.deepEqual(claude.logOutcome(s), {
    turnCompleted: true, turnFailed: false, failMessage: "",
    reviewText: claude.parseEvents(all, [], 0).reviewText, threadId: "5f0c1e2a-0000-4000-8000-00000000c1a0",
  });
});

test("matchesCmdline: only print-mode stream-json Claude turns", () => {
  for (const yes of [
    "claude -p --output-format stream-json --verbose --effort high --dangerously-skip-permissions",
    "/Users/x/.local/bin/claude --print --output-format stream-json --verbose",
    "C:\\tools\\claude.exe -p --output-format stream-json",
    "\"C:\\Program Files\\x\\claude.exe\" -p --output-format stream-json",
    "\"C:\\Program Files\\nodejs\\node.exe\" C:\\t\\node_modules\\fake-claude\\claude.js -p --output-format stream-json --verbose",
  ]) assert.equal(claude.matchesCmdline(yes), true, yes);
  for (const no of [
    "claude",
    "claude --resume abc",
    "/opt/homebrew/bin/node /x/codex.js exec --json",
    "vim claude.md -p stream-json",
    "claude-helper -p --output-format stream-json",
    "code.exe C:\\x\\claude.md -p stream-json",
    "\"C:\\Program Files\\x\\claude.exe\" --resume abc",
  ]) assert.equal(claude.matchesCmdline(no), false, no);
});

test("checkSelection: the fixed effort levels", () => {
  for (const e of ["low", "medium", "high", "xhigh", "max"]) assert.deepEqual(claude.checkSelection({ model: null, effort: e }), { ok: true });
  const bad = claude.checkSelection({ model: "opus", effort: "huge" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /low, medium, high, xhigh, max/);
});

test("listModels and defaultModel", async () => {
  const models = await claude.listModels();
  assert.deepEqual(models.map(m => m.slug), ["fable", "opus", "sonnet", "haiku"]);
  assert.ok(models.every(m => m.efforts.join() === "low,medium,high,xhigh,max"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-config-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(claude.defaultModel(), null);
    fs.writeFileSync(path.join(dir, "settings.json"), "{ broken");
    assert.equal(claude.defaultModel(), null);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "sonnet" }));
    assert.equal(claude.defaultModel(), "sonnet");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
