// Settings data: the Codex model catalog and default model (reviewers/codex.js), and the
// Settings page's pure helpers (ui/settings.js) that must never lose a saved value.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cliInfo, defaultModel, listModels } from "../skill-packs/cross-review/scripts/lib/reviewers/codex.js";
import { FALLBACK_EFFORTS, effortOptions, mergeForm, modelOptions } from "../skill-packs/cross-review/scripts/lib/dashboard/ui/settings.js";
import { startDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";

let tmp;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

// An invented catalog in the shape `codex debug models` prints: 9 models, 7 listed
const level = effort => ({ effort, description: `Invented ${effort} level` });
const CATALOG = {
  models: [
    { slug: "model-c", display_name: "Model C", description: "Third.", visibility: "list", priority: 3, supported_reasoning_levels: ["low", "medium", "high"].map(level) },
    { slug: "model-a", display_name: "Model A", description: "First.", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh", "ultra"].map(level) },
    { slug: "model-hidden", display_name: "Hidden", description: "Not listed.", visibility: "hide", priority: 0, supported_reasoning_levels: [] },
    { slug: "model-b", display_name: "Model B", description: "Second.", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "high"].map(level) },
    { slug: "model-g", display_name: "Model G", description: "Seventh.", visibility: "list", priority: 7, supported_reasoning_levels: ["low"].map(level) },
    { slug: "model-e", display_name: "Model E", description: "Fifth.", visibility: "list", priority: 5, supported_reasoning_levels: ["medium"].map(level) },
    { slug: "model-d", display_name: "Model D", description: "Fourth.", visibility: "list", priority: 4, supported_reasoning_levels: ["high"].map(level) },
    { slug: "model-f", display_name: "Model F", description: "Sixth.", visibility: "list", priority: 6, supported_reasoning_levels: ["xhigh"].map(level) },
    { slug: "model-internal", display_name: "Internal", description: "Not listed.", visibility: "none", priority: 8, supported_reasoning_levels: [] },
  ],
};

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-settings-")));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tmp, "catalog.json"), JSON.stringify(CATALOG));
  // FAKE_MODELS: ok | bundled (only --bundled works) | fail
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const mode = process.env.FAKE_MODELS || "ok";
if (args === "--version") { process.stdout.write("codex-cli 9.9.9-invented\\n"); process.exit(0); }
if (args === "login status") { process.stdout.write("Logged in\\n"); process.exit(0); }
if (args.startsWith("debug models")) {
  const bundled = args.includes("--bundled");
  if (mode === "fail" || (mode === "bundled" && !bundled)) { process.stderr.write("invented failure\\n"); process.exit(1); }
  process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path.join(tmp, "catalog.json"))}, "utf8"));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  delete process.env.FAKE_MODELS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- 4, 5 ----------

test("listModels: listed models by priority with their efforts; --bundled when the live list fails; null when both fail", async () => {
  process.env.FAKE_MODELS = "ok";
  const models = await listModels();
  assert.deepEqual(models.map(m => m.slug), ["model-a", "model-b", "model-c", "model-d", "model-e", "model-f", "model-g"]);
  assert.deepEqual(models[0], { slug: "model-a", name: "Model A", description: "First.", efforts: ["low", "medium", "high", "xhigh", "ultra"] });
  process.env.FAKE_MODELS = "bundled";
  assert.equal((await listModels()).length, 7);
  process.env.FAKE_MODELS = "fail";
  assert.equal(await listModels(), null);
  process.env.FAKE_MODELS = "ok";
  assert.deepEqual(await cliInfo(), { version: "codex-cli 9.9.9-invented", loggedIn: true });
});

test("defaultModel: the top-level `model` of $CODEX_HOME/config.toml, not one inside a table", () => {
  const home = path.join(tmp, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  process.env.CODEX_HOME = home;
  assert.equal(defaultModel(), null);
  fs.writeFileSync(path.join(home, "config.toml"), `# invented\nmodel_reasoning_effort = "high"\nmodel = "model-top"\n\n[profiles.fast]\nmodel = "model-profile"\n`);
  assert.equal(defaultModel(), "model-top");
  fs.writeFileSync(path.join(home, "config.toml"), `[profiles.fast]\nmodel = "model-profile"\n`);
  assert.equal(defaultModel(), null);
  delete process.env.CODEX_HOME;
});

// ---------- 6b ----------

const catalog = CATALOG.models.filter(m => m.visibility === "list")
  .map(m => ({ slug: m.slug, name: m.display_name, description: m.description, efforts: m.supported_reasoning_levels.map(l => l.effort) }));

test("effortOptions: a saved effort outside the list stays, marked and selected — with or without a catalog", () => {
  const none = effortOptions({ catalog: null, model: null, saved: "ultra", inherited: "high (default)" });
  assert.deepEqual(none.map(o => o.value), ["", ...FALLBACK_EFFORTS, "ultra"]);
  assert.deepEqual(none.filter(o => o.selected), [{ value: "ultra", label: "ultra (not verified)", selected: true }]);
  const b = effortOptions({ catalog, model: "model-b", saved: "xhigh", inherited: "Inherit — high" });
  assert.deepEqual(b.map(o => o.label), ["Inherit — high", "low", "high", "xhigh (not verified)"]);
  const a = effortOptions({ catalog, model: "model-a", saved: "ultra", inherited: "x" });
  assert.deepEqual(a.filter(o => o.selected).map(o => o.label), ["ultra"]);
  assert.deepEqual(effortOptions({ catalog, model: "model-a", saved: undefined, inherited: "x" }).filter(o => o.selected).map(o => o.value), [""]);
});

test("modelOptions: a saved model not in the catalog stays, marked and selected; no catalog offers Other…", () => {
  const opts = modelOptions({ catalog, saved: "x-unknown", inherited: "Codex default (Model A)", codexDefault: "model-a" });
  assert.equal(opts[0].label, "Codex default (Model A)");
  assert.deepEqual(opts.filter(o => o.selected), [{ value: "x-unknown", label: "x-unknown (not in list)", selected: true }]);
  assert.equal(opts.filter(o => o.value.startsWith("model-")).length, 7);
  const none = modelOptions({ catalog: null, saved: undefined, inherited: "Codex default", codexDefault: null });
  assert.deepEqual(none.map(o => o.label), ["Codex default", "Other…"]);
  assert.equal(none[0].selected, true);
});

test("mergeForm: only touched keys change; clearing one removes it; an untouched skill entry stays", () => {
  const file = { effort: "ultra", model: "x-unknown", skills: { "review-impl": { effort: "xhigh" }, "review-plan": { model: "model-b" } } };
  const form = { effort: "", model: "", open_dashboard: true, skills: {} };
  assert.deepEqual(mergeForm(file, form, ["open_dashboard"]), { ...file, open_dashboard: true });
  assert.deepEqual(mergeForm(file, { skills: { "review-impl": { effort: "" } } }, ["skills.review-impl.effort"]),
    { effort: "ultra", model: "x-unknown", skills: { "review-plan": { model: "model-b" } } });
  assert.deepEqual(mergeForm(file, { model: "model-a" }, new Set(["model"])), { ...file, model: "model-a" });
  assert.deepEqual(file.skills["review-impl"], { effort: "xhigh" }, "the saved object is not changed");
});

test("through the server: with no catalog, changing Follow reviews keeps effort ultra and model x-unknown in the file", async () => {
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, ".cross-review", "sessions"), { recursive: true });
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.writeFileSync(globalFile, JSON.stringify({ effort: "ultra", model: "x-unknown" }));
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null,
    catalog: { listModels: async () => null, defaultModel: () => null, cliInfo: async () => ({ version: null, loggedIn: false }) } });
  try {
    const auth = { Authorization: `Bearer ${d.token}` };
    const s = await (await fetch(`http://127.0.0.1:${d.port}/api/settings`, { headers: auth })).json();
    assert.equal(s.models, null);
    assert.deepEqual(s.global, { effort: "ultra", model: "x-unknown" });
    const shownEffort = effortOptions({ catalog: s.models, model: s.global.model, saved: s.global.effort, inherited: "high (default)" }).find(o => o.selected).value;
    const shownModel = modelOptions({ catalog: s.models, saved: s.global.model, inherited: "Codex default", codexDefault: s.codexDefault }).find(o => o.selected).value;
    const config = mergeForm(s.global, { effort: shownEffort, model: shownModel, open_dashboard: true }, ["open_dashboard"]);
    const r = await fetch(`http://127.0.0.1:${d.port}/api/settings`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "global", config }) });
    assert.equal(r.status, 200, await r.text());
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { effort: "ultra", model: "x-unknown", open_dashboard: true });
  } finally {
    await d.close();
  }
});

test("through the server: a save with `touched` changes only those fields in the file as it is now; bad paths are refused", async () => {
  const root = path.join(tmp, "root-touched");
  fs.mkdirSync(path.join(root, ".cross-review", "sessions"), { recursive: true });
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null,
    catalog: { listModels: async () => null, defaultModel: () => null, cliInfo: async () => ({ version: null, loggedIn: false }) } });
  const post = body => fetch(`http://127.0.0.1:${d.port}/api/settings`, { method: "POST", headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    // the page loaded { effort: "high" }; meanwhile the file gained a model and a per-skill effort
    fs.writeFileSync(globalFile, JSON.stringify({ effort: "high", model: "model-x", skills: { "review-pr": { effort: "low" } } }));
    const form = { effort: "medium", open_plans: true, skills: { "review-impl": { model: "model-b" } } };
    let r = await post({ scope: "global", config: form, touched: ["effort", "skills.review-impl.model"] });
    const answer = await r.text();
    assert.equal(r.status, 200, answer);
    const want = { effort: "medium", model: "model-x", skills: { "review-pr": { effort: "low" }, "review-impl": { model: "model-b" } } };
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), want, "untouched open_plans is not written; the file's own fields stay");
    assert.deepEqual(JSON.parse(answer).config, want);
    // clearing a touched field removes it
    r = await post({ scope: "global", config: {}, touched: ["model"] });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).model, undefined);
    // a broken file is replaced by the touched fields
    fs.writeFileSync(globalFile, "{ broken");
    r = await post({ scope: "global", config: { effort: "low" }, touched: ["effort"] });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { effort: "low" });
    for (const touched of [["__proto__"], ["skills.__proto__.model"], ["skills.review-impl.reviewer"], "effort", [1]]) {
      r = await post({ scope: "global", config: { effort: "high" }, touched });
      assert.equal(r.status, 400, JSON.stringify(touched));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { effort: "low" }, "refused saves change nothing");
  } finally {
    fs.rmSync(globalFile, { force: true });
    await d.close();
  }
});
