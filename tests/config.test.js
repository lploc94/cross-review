// Two-level review settings (lib/config.js): validation, reading, writing, and per-key
// resolution in the order requested > workspace skill > workspace > global skill > global > default.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_SKILLS, ensureCrossReviewDir, globalConfigPath, readConfig, resolvePlanSettings, resolveSettings, validateConfig, workspaceConfigPath, writeConfig,
} from "../skill-packs/cross-review/scripts/lib/config.js";
import { SKILL_TEMPLATES } from "../skill-packs/cross-review/scripts/lib/review-core.js";

let tmp;
let home;
const savedHome = process.env.HOME;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-test-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const workspace = name => {
  const ws = path.join(tmp, name);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
};
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

test("paths: global under HOME, workspace under its .cross-review; the skill list matches the runner's", () => {
  assert.equal(globalConfigPath(), path.join(home, ".cross-review", "config.json"));
  assert.equal(workspaceConfigPath("/w/a"), path.join("/w/a", ".cross-review", "config.json"));
  assert.deepEqual([...CONFIG_SKILLS].sort(), Object.keys(SKILL_TEMPLATES).sort());
});

test("resolveSettings: each key comes from its own level in one call", () => {
  const ws = workspace("mixed");
  put(globalConfigPath(), { effort: "medium", model: "model-global", skills: { "review-impl": { effort: "low" } }, open_dashboard: true });
  put(workspaceConfigPath(ws), { skills: { "review-impl": { model: "model-ws-impl" } } });
  const r = resolveSettings({ skill: "review-impl", workingDir: ws });
  assert.deepEqual(r, {
    reviewer: "codex", model: "model-ws-impl", effort: "low", open_dashboard: true,
    sources: { reviewer: "default", model: "workspace:review-impl", effort: "global:review-impl", open_dashboard: "global" },
  });
  // Another skill in the same workspace: the workspace entry for review-impl does not apply
  const p = resolveSettings({ skill: "review-plan", workingDir: ws });
  assert.deepEqual([p.model, p.sources.model, p.effort, p.sources.effort], ["model-global", "global", "medium", "global"]);
  fs.rmSync(globalConfigPath());
});

test("resolveSettings: workspace beats global, requested beats both, defaults last", () => {
  const ws = workspace("order");
  put(globalConfigPath(), { effort: "medium", skills: { "review-plan": { model: "model-g-plan" } } });
  put(workspaceConfigPath(ws), { effort: "xhigh", model: "model-ws", open_dashboard: false });
  let r = resolveSettings({ skill: "review-plan", workingDir: ws });
  assert.deepEqual([r.model, r.sources.model, r.effort, r.sources.effort, r.open_dashboard, r.sources.open_dashboard],
    ["model-ws", "workspace", "xhigh", "workspace", false, "workspace"]);
  r = resolveSettings({ skill: "review-plan", workingDir: ws, explicit: { effort: "low", model: "model-asked", reviewer: "codex" } });
  assert.deepEqual([r.model, r.sources.model, r.effort, r.sources.effort, r.sources.reviewer], ["model-asked", "requested", "low", "requested", "requested"]);
  fs.rmSync(globalConfigPath());
  r = resolveSettings({ skill: "review-think", workingDir: workspace("bare") });
  assert.deepEqual(r, { reviewer: "codex", model: null, effort: "high", open_dashboard: false,
    sources: { reviewer: "default", model: "default", effort: "default", open_dashboard: "default" } });
});

test("validateConfig: unknown keys, skills, reviewers, bad model, effort and types are errors", () => {
  assert.deepEqual(validateConfig({}), []);
  assert.deepEqual(validateConfig({ reviewer: "codex", model: "gpt-x.1", effort: "xhigh", open_dashboard: true, skills: { "review-pr": { effort: "low" } } }), []);
  const bad = [
    [{ colour: "red" }, /colour/],
    [{ skills: { "review-commit": { model: "m" } } }, /review-commit/],
    [{ skills: { "review-impl": { reviewer: "codex" } } }, /reviewer/],
    [{ reviewer: "gemini" }, /gemini/],
    [{ model: "two words" }, /model/],
    [{ model: "" }, /model/],
    [{ model: "x".repeat(201) }, /model/],
    [{ effort: "High" }, /effort/],
    [{ open_dashboard: "yes" }, /open_dashboard/],
    [[], /object/],
    [{ skills: [] }, /skills/],
  ];
  for (const [value, re] of bad) {
    const errors = validateConfig(value);
    assert.ok(errors.length, JSON.stringify(value));
    assert.match(errors.join("\n"), re);
  }
});

test("readConfig: missing is {}; broken JSON or a bad value throws CONFIG_INVALID naming the file", () => {
  const file = path.join(tmp, "read", "config.json");
  assert.deepEqual(readConfig(file), {});
  put(file, "{ not json");
  assert.throws(() => readConfig(file), e => e.code === "CONFIG_INVALID" && e.message.includes(file));
  put(file, { effort: 3 });
  assert.throws(() => readConfig(file), e => e.code === "CONFIG_INVALID" && e.message.includes(file) && /effort/.test(e.message));
  const ws = workspace("broken");
  put(workspaceConfigPath(ws), "[");
  assert.throws(() => resolveSettings({ skill: "review-impl", workingDir: ws }), e => e.code === "CONFIG_INVALID");
});

test("writeConfig validates, writes atomically, and an empty object deletes the file", () => {
  const ws = workspace("write");
  const file = workspaceConfigPath(ws);
  assert.throws(() => writeConfig(file, { nope: 1 }), e => e.code === "CONFIG_INVALID");
  assert.equal(fs.existsSync(file), false);
  writeConfig(file, { effort: "low", skills: { "review-impl": {} } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { effort: "low" });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.includes(".tmp")), []);
  writeConfig(file, {});
  assert.equal(fs.existsSync(file), false);
  writeConfig(file, {}); // nothing to delete is fine
});

test("track_plans and open_plans: booleans at the global and workspace level only; workspace wins", () => {
  assert.deepEqual(validateConfig({ track_plans: true, open_plans: false }), []);
  for (const [value, re] of [
    [{ track_plans: "yes" }, /track_plans/],
    [{ open_plans: 1 }, /open_plans/],
    [{ skills: { "review-plan": { track_plans: true } } }, /track_plans/],
    [{ skills: { "review-plan": { open_plans: true } } }, /open_plans/],
  ]) assert.match(validateConfig(value).join("\n"), re, JSON.stringify(value));

  const ws = workspace("plan-settings");
  assert.deepEqual(resolvePlanSettings(ws), { track_plans: { value: false, source: "default" }, open_plans: { value: false, source: "default" } });
  put(globalConfigPath(), { track_plans: true, open_plans: true });
  assert.deepEqual(resolvePlanSettings(ws), { track_plans: { value: true, source: "global" }, open_plans: { value: true, source: "global" } });
  put(workspaceConfigPath(ws), { track_plans: false });
  assert.deepEqual(resolvePlanSettings(ws), { track_plans: { value: false, source: "workspace" }, open_plans: { value: true, source: "global" } });
  // review settings stay as they were: the plan keys are not review settings
  assert.deepEqual(Object.keys(resolveSettings({ skill: "review-plan", workingDir: ws }).sources).sort(), ["effort", "model", "open_dashboard", "reviewer"]);
  put(workspaceConfigPath(ws), "[");
  assert.throws(() => resolvePlanSettings(ws), e => e.code === "CONFIG_INVALID");
  fs.rmSync(globalConfigPath());
});

test("ensureCrossReviewDir writes .gitignore once and keeps an existing one", () => {
  const ws = workspace("ignore");
  ensureCrossReviewDir(ws);
  const gi = path.join(ws, ".cross-review", ".gitignore");
  assert.equal(fs.readFileSync(gi, "utf8"), "*\n");
  fs.writeFileSync(gi, "custom\n");
  ensureCrossReviewDir(ws);
  assert.equal(fs.readFileSync(gi, "utf8"), "custom\n");
});
