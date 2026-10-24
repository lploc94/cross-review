import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as agy from "../skill-packs/cross-review/scripts/lib/reviewers/agy.js";
import { getReviewer, REVIEWER_NAMES } from "../skill-packs/cross-review/scripts/lib/reviewers/index.js";
import { FAKE_AGY_MODELS, writeFakeAgy } from "./helpers/fake-agy.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fixtures", "agy-turn.jsonl");
const lines = () => fs.readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const j = e => JSON.stringify(e);
const CATALOG = agy.parseCatalog(FAKE_AGY_MODELS);

let tmp;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-agy-"));
  fs.mkdirSync(path.join(tmp, "bin"));
  writeFakeAgy(path.join(tmp, "bin"));
  process.env.PATH = `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`;
  process.env.HOME = path.join(tmp, "home");
  // os.homedir() reads USERPROFILE on Windows
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("agy is a registered reviewer with model-dependent efforts", () => {
  assert.ok(REVIEWER_NAMES.includes("agy"));
  assert.equal(getReviewer("agy").label, "Antigravity");
  assert.equal(agy.efforts, null);
  assert.deepEqual(agy.sandboxes, ["read-only", "danger-full-access"]);
});

test("encodePrompt: one NDJSON user message carrying the text as is", () => {
  const text = "Review this.\nLine two with \"quotes\" and a tab\t.";
  const out = agy.encodePrompt(text);
  assert.ok(out.endsWith("\n"));
  assert.equal(out.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(out), { event: "user", message: { role: "user", content: text } });
});

test("catalog groups variants into families with their efforts, in order", () => {
  assert.deepEqual(CATALOG.map(({ slug, name, efforts }) => ({ slug, name, efforts })), [
    { slug: "gemini-x-flash", name: "Gemini X Flash", efforts: ["high", "medium", "low"] },
    { slug: "claude-y", name: "Claude Y (Thinking)", efforts: [] },
    { slug: "oss-z", name: "OSS Z", efforts: ["medium"] },
  ]);
  assert.deepEqual(CATALOG[0].variants.map(v => [v.slug, v.name, v.effort]), [
    ["gemini-x-flash-high", "Gemini X Flash (High)", "high"],
    ["gemini-x-flash-medium", "Gemini X Flash (Medium)", "medium"],
    ["gemini-x-flash-low", "Gemini X Flash (Low)", "low"],
  ]);
  assert.equal(agy.parseCatalog(""), null);
  assert.equal(agy.parseCatalog("Fetching available models...\n"), null);
  const other = agy.parseCatalog("m-max\tM (Max)\nm-minimal\tM (Minimal)\nsolo\tSolo\n");
  assert.deepEqual(other.map(m => [m.slug, m.efforts.join()]), [["m", "max,minimal"], ["solo", ""]]);
});

test("readCatalog and listModels ask `agy models`", async () => {
  assert.deepEqual(agy.readCatalog(), CATALOG);
  const models = await agy.listModels();
  assert.deepEqual(models.map(m => [m.slug, m.efforts.join()]), [["gemini-x-flash", "high,medium,low"], ["claude-y", ""], ["oss-z", "medium"]]);
  assert.ok(models.every(m => typeof m.name === "string" && m.description === ""));
});

test("resolveFlags: variant, family with levels, model without levels, no model, no catalog", () => {
  const rf = (model, effort, catalog = CATALOG, defaultName = null) => agy.resolveFlags({ model, effort, catalog, defaultName });
  // a variant slug already names its effort
  assert.deepEqual(rf("gemini-x-flash-low", "high"), ["--model", "gemini-x-flash-low"]);
  // a family takes the effort
  assert.deepEqual(rf("gemini-x-flash", "medium"), ["--model", "gemini-x-flash", "--effort", "medium"]);
  assert.deepEqual(rf("oss-z", "medium"), ["--model", "oss-z", "--effort", "medium"]);
  // no levels: no --effort, whatever the effort
  assert.deepEqual(rf("claude-y", "high"), ["--model", "claude-y"]);
  // no model: the default model's family decides
  assert.deepEqual(rf(null, "low", CATALOG, "Gemini X Flash (High)"), ["--effort", "low"]);
  assert.deepEqual(rf(null, "high", CATALOG, "Claude Y (Thinking)"), []);
  assert.deepEqual(rf(null, "high", CATALOG, null), ["--effort", "high"]);
  assert.deepEqual(rf(undefined, "high", CATALOG, "Something Else"), ["--effort", "high"]);
  // no catalog: the flags as requested, except a variant-looking slug
  assert.deepEqual(rf("foo", "high", null), ["--model", "foo", "--effort", "high"]);
  assert.deepEqual(rf("gemini-x-flash-low", "high", null), ["--model", "gemini-x-flash-low"]);
  assert.deepEqual(rf(null, "xhigh", null), ["--effort", "xhigh"]);
});

test("buildCommand: flag order, sandboxes, resume by conversation id", () => {
  const base = ["--input-format", "stream-json", "--output-format", "stream-json"];
  assert.deepEqual(
    agy.buildCommand({ threadId: "", workingDir: "/w", model: "gemini-x-flash", effort: "low", sandbox: "danger-full-access" }),
    { cmd: "agy", args: [...base, "--model", "gemini-x-flash", "--effort", "low", "--dangerously-skip-permissions", "--print="], cwd: "/w" },
  );
  assert.deepEqual(
    agy.buildCommand({ threadId: "conv-9", workingDir: "/w", model: "claude-y", effort: "high", sandbox: "read-only" }).args,
    [...base, "--model", "claude-y", "--sandbox", "--mode", "plan", "--conversation", "conv-9", "--print="],
  );
  // no model and no default model file: the effort as requested
  assert.deepEqual(
    agy.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "medium", sandbox: "danger-full-access" }).args,
    [...base, "--effort", "medium", "--dangerously-skip-permissions", "--print="],
  );

  // systemPromptFile + skillName adds --agent cross-reviewer-<skill> --disable-slash-commands and provisions global agent without touching workingDir
  const workDir = fs.mkdtempSync(path.join(tmp, "agy-work-"));
  const sysFile = path.join(tmp, "review-impl.compiled.md");
  fs.writeFileSync(sysFile, "# System Role: Test Reviewer\n", "utf8");
  const withAgent = agy.buildCommand({
    threadId: "conv-9",
    workingDir: workDir,
    model: "gemini-x-flash",
    effort: "low",
    sandbox: "danger-full-access",
    systemPromptFile: sysFile,
    skillName: "review-impl",
  });
  assert.deepEqual(withAgent.args, [
    ...base,
    "--agent", "cross-reviewer-review-impl", "--disable-slash-commands",
    "--model", "gemini-x-flash", "--effort", "low",
    "--dangerously-skip-permissions", "--conversation", "conv-9", "--print=",
  ]);
  const fallbackAgent = path.join(process.env.HOME, ".gemini", "config", "agents", "cross-reviewer-review-impl.md");
  assert.ok(fs.existsSync(fallbackAgent), "global fallback agent created under $HOME/.gemini/config/agents/");
  assert.match(fs.readFileSync(fallbackAgent, "utf8"), /name: cross-reviewer-review-impl/);
  assert.deepEqual(fs.readdirSync(workDir), [], "workingDir is never mutated with .agents/");
});

test("defaultModel reads the display name from agy's settings", () => {
  const dir = path.join(process.env.HOME, ".gemini", "antigravity-cli");
  assert.equal(agy.defaultModel(), null);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "{ broken");
  assert.equal(agy.defaultModel(), null);
  fs.writeFileSync(path.join(dir, "settings.json"), j({ model: "Claude Y (Thinking)" }));
  assert.equal(agy.defaultModel(), "Claude Y (Thinking)");
  // the default model has no levels: no --effort
  assert.deepEqual(
    agy.buildCommand({ threadId: "", workingDir: "/w", model: null, effort: "high", sandbox: "danger-full-access" }).args.slice(4, -1),
    ["--dangerously-skip-permissions"],
  );
  fs.rmSync(path.join(process.env.HOME, ".gemini"), { recursive: true, force: true });
});

test("checkSelection: efforts of the family, models without levels, unknown models, no catalog", () => {
  const cs = (model, effort, catalog = CATALOG, defaultName = null) => agy.checkSelection({ model, effort }, catalog, defaultName);
  assert.deepEqual(cs("gemini-x-flash", "low"), { ok: true });
  const bad = cs("gemini-x-flash", "max");
  assert.equal(bad.ok, false);
  assert.equal(bad.message, "Antigravity model gemini-x-flash supports effort: high, medium, low");
  assert.deepEqual(cs("claude-y", "high"), { ok: true });
  assert.deepEqual(cs("gemini-x-flash-low", "high"), { ok: true });
  const unknown = cs("no-such-model", "high");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.message, "Unknown Antigravity model no-such-model; agy models lists: gemini-x-flash, claude-y, oss-z");
  // the default model's family
  assert.equal(cs(null, "xhigh", CATALOG, "Gemini X Flash (High)").ok, false);
  assert.match(cs(null, "xhigh", CATALOG, "Gemini X Flash (High)").message, /gemini-x-flash supports effort: high, medium, low/);
  assert.deepEqual(cs(null, "high", CATALOG, "Gemini X Flash (High)"), { ok: true });
  assert.deepEqual(cs(null, "max", CATALOG, null), { ok: true });
  // no catalog: agy decides when the turn runs
  assert.deepEqual(cs("no-such-model", "max", null), { ok: true });
});

test("parseEvents: a completed turn gives the conversation id, the review and its activities", () => {
  const all = lines();
  const ev = agy.parseEvents(all, all, 7);
  assert.equal(ev.turnCompleted, true);
  assert.equal(ev.turnFailed, false);
  assert.equal(ev.threadId, "c0ffee00-0000-4000-8000-0000000a6e01");
  assert.match(ev.reviewText, /^### ISSUE-1: Basket skips the first line/);
  assert.equal(ev.progressObserved, true);
  assert.deepEqual(ev.activities.map(a => [a.type, a.detail]), [
    ["command_started", "git diff"],
    ["command_completed", "git diff"],
    ["file_change", "/tmp/invented-shop/notes.md (write_to_file)"],
  ]);
  assert.ok(ev.activities.every(a => a.time === 7));
  const later = agy.parseEvents(all, all.slice(5), 9);
  assert.deepEqual(later.activities.map(a => a.type), ["command_completed", "file_change"]);
});

test("parseEvents: status ERROR fails the turn, with its error or its status", () => {
  const failed = agy.parseEvents([j({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "invalid model selection (--model \"x\")" } })], [], 1);
  assert.deepEqual([failed.turnFailed, failed.turnCompleted, failed.threadId, failed.reviewText], [true, false, "", ""]);
  assert.match(failed.failMessage, /invalid model selection/);
  // a response does not make an ERROR a success
  const noError = agy.parseEvents([j({ event: "result", result: { conversation_id: "k", status: "ERROR", response: "partial" } })], [], 1);
  assert.deepEqual([noError.turnFailed, noError.failMessage, noError.reviewText], [true, "ERROR", ""]);
});

test("parseEvents: a running turn has its conversation id and no outcome", () => {
  const all = lines().slice(0, 4);
  const ev = agy.parseEvents(all, all, 1);
  assert.deepEqual([ev.turnCompleted, ev.turnFailed, ev.threadId, ev.progressObserved], [false, false, "c0ffee00-0000-4000-8000-0000000a6e01", true]);
  const initOnly = agy.parseEvents(all.slice(0, 1), [], 1);
  assert.equal(initOnly.progressObserved, false);
});

test("activityItems: text deltas joined per step, tool states applied, the final message left out", () => {
  const items = agy.activityItems(lines());
  assert.deepEqual(items.map(i => [i.kind, i.line]), [["message", 2], ["command", 4], ["tool", 6], ["file_change", 8]]);
  const [note, cmd, view, write] = items;
  assert.equal(note.text, "Reading the diff first.");
  assert.deepEqual([cmd.command, cmd.status, cmd.lastLine], ["git diff", "completed", 5]);
  assert.deepEqual([view.tool, view.text, view.status], ["view_file", "/tmp/invented-shop/basket.js", "completed"]);
  assert.deepEqual([write.path, write.status], ["/tmp/invented-shop/notes.md", "completed"]);

  const running = agy.activityItems(lines().slice(0, 12));
  assert.equal(running.at(-1).kind, "message");
  assert.match(running.at(-1).text, /^### ISSUE-1/);
  assert.equal(running.at(-1).text.length, 120);
  const open = agy.activityItems(lines().slice(0, 5));
  assert.deepEqual([open.at(-1).kind, open.at(-1).status], ["command", "in_progress"]);
});

test("the incremental fold equals the one-shot fold", () => {
  const all = lines();
  const s = agy.newLogState();
  agy.foldLog(s, all.slice(0, 11));
  agy.foldLog(s, all.slice(11));
  assert.deepEqual(agy.logItems(s), agy.activityItems(all));
  assert.deepEqual(agy.logOutcome(s), {
    turnCompleted: true, turnFailed: false, failMessage: "",
    reviewText: agy.parseEvents(all, [], 0).reviewText, threadId: "c0ffee00-0000-4000-8000-0000000a6e01",
  });
});

test("matchesCmdline: only print-mode stream-json agy turns", () => {
  for (const yes of [
    "agy --input-format stream-json --output-format stream-json --effort high --dangerously-skip-permissions --print=",
    "/Users/x/.local/bin/agy --input-format stream-json --output-format stream-json --conversation c --print=",
    "C:\\tools\\agy.exe --output-format stream-json --print=",
    "\"C:\\Users\\x y\\AppData\\Local\\agy\\bin\\agy.exe\" --output-format stream-json --print=",
    "\"C:\\Program Files\\nodejs\\node.exe\" C:\\t\\node_modules\\fake-agy\\agy.js --input-format stream-json --output-format stream-json --print=",
  ]) assert.equal(agy.matchesCmdline(yes), true, yes);
  for (const no of [
    "agy",
    "agy models",
    "agy -p hello --output-format stream-json",
    "agy-helper --output-format stream-json --print=",
    "vim agy --print= stream-json",
    "code.exe C:\\x\\agy.md --print= stream-json",
  ]) assert.equal(agy.matchesCmdline(no), false, no);
});

test("cliInfo: the version, and no login check", async () => {
  assert.deepEqual(await agy.cliInfo(), { version: "9.9.9", loggedIn: null });
});
