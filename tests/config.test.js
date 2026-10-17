// Two-level review settings (lib/config.js): validation, reading, writing, and per-key
// resolution in the order requested > workspace skill > workspace > global skill > global > default.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_SKILLS, ensureCrossReviewDir, globalConfigPath, normalizeConfig, readConfig, resolvePlanSettings, resolveSettings, validateConfig, workspaceConfigPath, writeConfig,
} from "../skill-packs/cross-review/scripts/lib/config.js";
import { SKILL_TEMPLATES } from "../skill-packs/cross-review/scripts/lib/review-core.js";

let tmp;
let home;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "config-test-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  process.env.HOME = home;
  // os.homedir() reads USERPROFILE on Windows
  process.env.USERPROFILE = process.env.HOME;
});
after(() => {
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
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
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { reviewers: { codex: { effort: "low" } } });
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

// ---------- settings per reviewer (reviewers.<name>) ----------

test("resolve per reviewer: the chosen reviewer's entry, legacy keys only for Codex", () => {
  const ws = workspace("per-reviewer");
  // 1. a legacy global model is Codex's, so Claude gets its own default
  put(globalConfigPath(), { model: "gpt-5.5" });
  put(workspaceConfigPath(ws), { reviewer: "claude" });
  let r = resolveSettings({ skill: "review-impl", workingDir: ws });
  assert.deepEqual([r.reviewer, r.model, r.effort, r.sources.reviewer, r.sources.model], ["claude", null, "high", "workspace", "default"]);
  // the same files with Codex requested: the legacy model applies
  r = resolveSettings({ skill: "review-impl", workingDir: ws, explicit: { reviewer: "codex" } });
  assert.deepEqual([r.reviewer, r.model, r.sources.model], ["codex", "gpt-5.5", "global"]);

  // 2. Claude's global entry and its per-skill effort
  put(globalConfigPath(), { reviewers: { claude: { model: "opus", skills: { "review-plan": { effort: "max" } } } } });
  r = resolveSettings({ skill: "review-plan", workingDir: ws });
  assert.deepEqual([r.reviewer, r.model, r.effort], ["claude", "opus", "max"]);
  assert.deepEqual([r.sources.model, r.sources.effort], ["global", "global:review-plan"]);
  r = resolveSettings({ skill: "review-impl", workingDir: ws });
  assert.deepEqual([r.model, r.effort, r.sources.effort], ["opus", "high", "default"]);

  // 3. a legacy config without a reviewer runs Codex as before
  fs.rmSync(workspaceConfigPath(ws));
  put(globalConfigPath(), { model: "gpt-x", skills: { "review-impl": { effort: "xhigh" } } });
  r = resolveSettings({ skill: "review-impl", workingDir: ws });
  assert.deepEqual([r.reviewer, r.model, r.effort, r.sources.model, r.sources.effort], ["codex", "gpt-x", "xhigh", "global", "global:review-impl"]);

  // workspace entry beats global entry for the same reviewer; another reviewer's entry never applies
  put(globalConfigPath(), { reviewer: "agy", reviewers: { agy: { model: "g-model", effort: "low" }, codex: { model: "c-model" } } });
  put(workspaceConfigPath(ws), { reviewers: { agy: { effort: "medium" }, claude: { model: "sonnet" } } });
  r = resolveSettings({ skill: "review-pr", workingDir: ws });
  assert.deepEqual([r.reviewer, r.model, r.sources.model, r.effort, r.sources.effort], ["agy", "g-model", "global", "medium", "workspace"]);
  fs.rmSync(globalConfigPath());
  fs.rmSync(workspaceConfigPath(ws));
});

test("validate reviewers: unknown reviewer, unknown key, Claude effort, skills", () => {
  assert.deepEqual(validateConfig({
    reviewer: "claude",
    reviewers: {
      codex: { model: "gpt-x", effort: "xhigh", skills: { "review-impl": { effort: "low" } } },
      claude: { model: "opus", effort: "max", skills: { "review-plan": { model: "sonnet", effort: "low" } } },
      agy: { model: "gemini-x-flash", effort: "medium" },
    },
  }), []);
  // legacy keys next to reviewers stay valid
  assert.deepEqual(validateConfig({ model: "gpt-x", skills: { "review-pr": { effort: "low" } }, reviewers: { codex: { effort: "high" } } }), []);
  const bad = [
    [{ reviewers: { gemini: { model: "m" } } }, 'reviewers: unknown reviewer "gemini" (known: codex, claude, agy)'],
    [{ reviewers: { codex: { colour: "red" } } }, /reviewers\.codex: unknown key "colour"/],
    [{ reviewers: { claude: { effort: "huge" } } }, "reviewers.claude.effort: must be one of low, medium, high, xhigh, max"],
    [{ reviewers: { claude: { skills: { "review-plan": { effort: "huge" } } } } }, /reviewers\.claude\.skills\.review-plan\.effort: must be one of/],
    [{ reviewers: { codex: { skills: { "review-commit": { model: "m" } } } } }, /reviewers\.codex\.skills: unknown skill "review-commit"/],
    [{ reviewers: { agy: { model: "two words" } } }, /reviewers\.agy\.model/],
    [{ reviewers: { agy: { effort: "High" } } }, /reviewers\.agy\.effort/],
    [{ reviewers: [] }, /reviewers: must be an object/],
    [{ reviewers: { claude: "opus" } }, /reviewers\.claude: must be an object/],
    [{ reviewers: { __proto__: null, ["__proto__"]: {} } }, /unknown reviewer/],
  ];
  for (const [value, want] of bad) {
    const errors = validateConfig(value).join("\n");
    if (typeof want === "string") assert.ok(errors.includes(want), `${JSON.stringify(value)} → ${errors}`);
    else assert.match(errors, want, JSON.stringify(value));
  }
  assert.ok(validateConfig(JSON.parse('{"reviewers": {"__proto__": {"model": "m"}}}')).join().includes("unknown reviewer"));
});

// The steps Breaking Changes gives to go back to 10.3.x, as a pure function: the 10.3 keys
// and reviewer names are written out here, not taken from the current validator.
const KEYS_10_3 = ["reviewer", "model", "effort", "open_dashboard", "track_plans", "open_plans", "check_updates", "skills"];
function rollbackTo103(cfg) {
  const out = { ...cfg };
  const codex = (cfg.reviewers && cfg.reviewers.codex) || {};
  for (const k of ["model", "effort", "skills"]) if (codex[k] !== undefined) out[k] = codex[k];
  delete out.reviewers;
  if (out.reviewer !== undefined && out.reviewer !== "codex") delete out.reviewer;
  return out;
}

test("legacy keys move to reviewers.codex: normalize, write, rewrite, roll back", () => {
  const legacy = { reviewer: "codex", model: "gpt-x", effort: "low", skills: { "review-impl": { effort: "xhigh", model: "gpt-y" }, "review-pr": { model: "gpt-z" } }, open_dashboard: true };
  const frozen = JSON.stringify(legacy);
  const n = normalizeConfig(legacy);
  assert.equal(JSON.stringify(legacy), frozen, "the input is not changed");
  assert.deepEqual(n, {
    reviewer: "codex", open_dashboard: true,
    reviewers: { codex: { model: "gpt-x", effort: "low", skills: { "review-impl": { effort: "xhigh", model: "gpt-y" }, "review-pr": { model: "gpt-z" } } } },
  });
  assert.deepEqual(normalizeConfig(n), n, "normalizing twice is normalizing once");
  // a field already in reviewers.codex wins, field by field
  const mixed = { model: "old", skills: { "review-impl": { effort: "low", model: "old-impl" } }, reviewers: { codex: { model: "new", skills: { "review-impl": { effort: "high" } } }, claude: { model: "opus" } } };
  const mixedFrozen = JSON.stringify(mixed);
  assert.deepEqual(normalizeConfig(mixed), {
    reviewers: { codex: { model: "new", skills: { "review-impl": { effort: "high", model: "old-impl" } } }, claude: { model: "opus" } },
  });
  assert.equal(JSON.stringify(mixed), mixedFrozen);

  // readConfig gives the normalized form; writeConfig writes it, and rewriting changes nothing
  const ws = workspace("normalize");
  const file = workspaceConfigPath(ws);
  put(file, legacy);
  assert.deepEqual(readConfig(file), n);
  writeConfig(file, legacy);
  const written = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(written), n);
  assert.ok(!("model" in JSON.parse(written)) && !("skills" in JSON.parse(written)));
  writeConfig(file, readConfig(file));
  assert.equal(fs.readFileSync(file, "utf8"), written, "rewriting a normalized file leaves it byte for byte");
  // emptied entries are pruned away
  writeConfig(file, { reviewers: { claude: { skills: { "review-plan": {} } }, codex: {} }, open_dashboard: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { open_dashboard: false });

  // rollback recipe yields a 10.3 config
  const back = rollbackTo103({ reviewer: "claude", reviewers: { codex: { model: "gpt-x" }, claude: { model: "opus" } } });
  assert.ok(Object.keys(back).every(k => KEYS_10_3.includes(k)), JSON.stringify(back));
  assert.ok(back.reviewer === undefined || back.reviewer === "codex");
  assert.equal(back.model, "gpt-x");
  assert.equal(back.reviewers, undefined);
  assert.deepEqual(rollbackTo103(n), { reviewer: "codex", open_dashboard: true, model: "gpt-x", effort: "low", skills: legacy.skills });
});
