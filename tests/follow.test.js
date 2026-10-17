// Follow reviews (lib/dashboard/follow.js): find the running dashboard through
// ~/.cross-review/dashboard.json or start one, register the session's workspace, open the
// session's page. HOME is a temp dir; the browser is a function that records the URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeSession } from "./helpers/dashboard-fixture.js";
import { followInDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/follow.js";
import { discoveryFile } from "../skill-packs/cross-review/scripts/lib/dashboard/discovery.js";

let tmp;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
const spawned = [];
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "follow-test-")));
  process.env.HOME = path.join(tmp, "home");
  // os.homedir() reads USERPROFILE on Windows
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME);
});
after(async () => {
  for (const pid of spawned) try { process.kill(pid, "SIGTERM"); } catch {}
  // a dashboard still writes its files while it shuts down; remove the folder once they are gone
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && spawned.some(alive); i++) await new Promise(r => setTimeout(r, 50));
  process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function session(name, id) {
  const ws = path.join(tmp, name);
  const now = Math.floor(Date.now() / 1000);
  const dir = writeSession(path.join(ws, ".cross-review", "sessions"), id, {
    skill: "review-plan", created: now - 10, inputs: ["PLAN_PATH: /work/invented-plan.md\n"],
    rounds: [{ status: "running", started: now - 10, elapsed: 0, acts: [] }],
  });
  return { ws, dir };
}

const bearerGet = async (info, p) => (await fetch(`http://127.0.0.1:${info.port}${p}`, { headers: { Authorization: `Bearer ${info.token}` } })).json();

test("no dashboard yet: starts one, opens the session's page on it; the next follow reuses it and registers its workspace", async () => {
  const a = session("alpha", "review-plan-20261015-001");
  const opened = [];
  const r = await followInDashboard({ sessionDir: a.dir, workingDir: a.ws, openBrowser: url => opened.push(url), idleExitSeconds: 5 });
  assert.ok(r.url, JSON.stringify(r));
  const info = JSON.parse(fs.readFileSync(discoveryFile(), "utf8"));
  spawned.push(info.pid);
  assert.notEqual(info.pid, process.pid);
  const m = r.url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})#\/s\/\.\/review-plan-20261015-001$/);
  assert.ok(m, r.url);
  assert.ok(Number(m[1]) >= 20000 && Number(m[1]) <= 30000);
  assert.equal(Number(m[1]), info.port);
  assert.deepEqual(opened, [r.url]);

  // A second review elsewhere: same dashboard, no new process, its workspace followed
  const b = session("beta", "review-plan-20261015-002");
  let spawns = 0;
  const r2 = await followInDashboard({ sessionDir: b.dir, workingDir: b.ws, openBrowser: url => opened.push(url), spawnDashboard: () => { spawns++; } });
  assert.equal(spawns, 0);
  assert.ok(r2.url.startsWith(`http://127.0.0.1:${info.port}/?t=${info.token}#/s/${encodeURIComponent(b.ws)}/review-plan-20261015-002`), r2.url);
  const list = await bearerGet(info, "/api/sessions");
  assert.ok(list.workspaces.some(w => w.path === b.ws));
  assert.equal(JSON.parse(fs.readFileSync(discoveryFile(), "utf8")).pid, info.pid);
});

test("dashboard.json of a dead process: a new dashboard is started", async () => {
  const c = session("gamma", "review-plan-20261015-003");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  fs.mkdirSync(path.dirname(discoveryFile()), { recursive: true });
  fs.writeFileSync(discoveryFile(), JSON.stringify({ pid: Number(dead.stdout), port: 1, token: "0".repeat(64), root: "/nowhere", started_at: 1 }));
  const calls = [];
  const r = await followInDashboard({ sessionDir: c.dir, workingDir: c.ws, openBrowser: () => {}, spawnDashboard: opts => calls.push(opts), waitMs: 300 });
  assert.deepEqual(calls, [{ root: c.ws, idleExitSeconds: 1800 }]);
  assert.match(r.error, /did not start within/);
});

test("a dashboard that never comes up: an error after 5 s, nothing opened", async () => {
  const d = session("delta", "review-plan-20261015-004");
  fs.rmSync(discoveryFile(), { force: true });
  const opened = [];
  const t0 = Date.now();
  const r = await followInDashboard({ sessionDir: d.dir, workingDir: d.ws, openBrowser: url => opened.push(url), spawnDashboard: () => {} });
  const waited = Date.now() - t0;
  assert.equal(r.error, "dashboard did not start within 5 s");
  assert.ok(waited >= 4500 && waited < 8000, `${waited} ms`);
  assert.deepEqual(opened, []);
});

test("the browser does not open: dashboard_error says so and keeps the link; openBrowser reports a launcher that is missing", async () => {
  const e = session("echo", "review-plan-20261015-005");
  fs.rmSync(discoveryFile(), { force: true });
  const r = await followInDashboard({ sessionDir: e.dir, workingDir: e.ws, idleExitSeconds: 5, openBrowser: async () => ({ ok: false, error: "spawn open ENOENT" }) });
  spawned.push(JSON.parse(fs.readFileSync(discoveryFile(), "utf8")).pid);
  assert.match(r.error || "", /^could not open the browser: spawn open ENOENT/);
  assert.match(r.url || "", /#\/s\/\.\/review-plan-20261015-005$/);

  const { openBrowser } = await import("../skill-packs/cross-review/scripts/lib/dashboard/server.js");
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(os.tmpdir(), "no-such-bin-dir");
  try {
    const o = await openBrowser("http://127.0.0.1:9/");
    assert.equal(o.ok, false);
    assert.ok(o.error);
  } finally {
    process.env.PATH = savedPath;
  }
});

// On Windows the launcher is `cmd /c start`, which a PATH fake cannot replace: these two would open a real browser
const OPENS_A_BROWSER = { skip: process.platform === "win32" && "opens a real browser on Windows" };

test("CLI begin with Follow reviews on waits for the browser launcher and prints its JSON", OPENS_A_BROWSER, async () => {
  const { writeFakeCodex } = await import("./helpers/fake-codex.js");
  const { placeholderNames, endSession } = await import("../skill-packs/cross-review/scripts/lib/review-core.js");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bin = path.join(tmp, "cli-bin");
  fs.mkdirSync(bin, { recursive: true });
  writeFakeCodex(bin);
  // a launcher that succeeds a little later, like `open` handing the URL to a browser
  fs.writeFileSync(path.join(bin, "open"), "#!/bin/sh\n/bin/sleep 0.25\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "xdg-open"), "#!/bin/sh\n/bin/sleep 0.25\nexit 0\n", { mode: 0o755 });
  const ws = path.join(tmp, "cli-ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(process.env.HOME, ".cross-review"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, ".cross-review", "config.json"), JSON.stringify({ open_dashboard: true }));
  fs.writeFileSync(path.join(tmp, "out.md"), "### VERDICT\n- Status: REVISE\n- Reason: Invented pending review.\n");
  const skillsDir = path.join(repo, "skill-packs", "cross-review", "skills");
  const input = [...placeholderNames(skillsDir, "review-plan")].filter(n => !["OUTPUT_FORMAT", "ANALYSIS_FORMAT"].includes(n))
    .map(n => `## ${n}\nInvented ${n}.\n`).join("\n");
  fs.rmSync(discoveryFile(), { force: true });
  const r = spawnSync(process.execPath, [path.join(repo, "skill-packs", "cross-review", "scripts", "review-runner.js"), "begin", "--skill", "review-plan", "--working-dir", ws, "--input", "-"], {
    input, encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CODEX_LOG: path.join(tmp, "calls.jsonl"), FAKE_CODEX_OUTPUT: path.join(tmp, "out.md") },
  });
  try {
    if (fs.existsSync(discoveryFile())) spawned.push(JSON.parse(fs.readFileSync(discoveryFile(), "utf8")).pid);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.session_dir, r.stdout);
    assert.match(out.dashboard_url || "", /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}#\/s\//, r.stdout);
  } finally {
    const sessions = path.join(ws, ".cross-review", "sessions");
    if (fs.existsSync(sessions)) for (const id of fs.readdirSync(sessions)) await endSession(path.join(sessions, id));
    fs.rmSync(path.join(process.env.HOME, ".cross-review", "config.json"), { force: true });
  }
});

test("Follow plans: `plans --finished` opens the plan's Plan tab, also in workspaces that have no sessions", OPENS_A_BROWSER, async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bin = path.join(tmp, "plans-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const fixture = fs.readFileSync(path.join(repo, "tests", "helpers", "fixtures", "export-formats-plan.md"), "utf8");
  const planWs = name => {
    const ws = path.join(tmp, name);
    fs.mkdirSync(path.join(ws, ".cross-review", "plans"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".cross-review", "plans", "export-formats-plan.md"), fixture);
    fs.writeFileSync(path.join(ws, ".cross-review", "plans", "notes.md"), "# Invented notes\n");
    return ws;
  };
  const first = planWs("plans-first");
  const second = planWs("plans-second");
  const run = (ws, file) => spawnSync(process.execPath, [path.join(repo, "skill-packs", "cross-review", "scripts", "review-runner.js"), "plans", "--working-dir", ws, "--finished", file], {
    encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  fs.mkdirSync(path.join(process.env.HOME, ".cross-review"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, ".cross-review", "config.json"), JSON.stringify({ open_plans: true }));
  fs.rmSync(discoveryFile(), { force: true });
  try {
    const r = run(first, "export-formats-plan.md");
    if (fs.existsSync(discoveryFile())) spawned.push(JSON.parse(fs.readFileSync(discoveryFile(), "utf8")).pid);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(out.dashboard_url || "", /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}#\/p\/\.\/export-formats-plan\.md\/plan$/, r.stdout);
    assert.equal(out.plans.length, 2);
    // a second workspace with plans only: the same dashboard takes it and opens the document
    const r2 = run(second, "notes.md");
    assert.equal(r2.status, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout);
    assert.ok((out2.dashboard_url || "").endsWith(`#/p/${encodeURIComponent(second)}/notes.md/plan`), r2.stdout);
    const info = JSON.parse(fs.readFileSync(discoveryFile(), "utf8"));
    const list = await bearerGet(info, "/api/sessions");
    assert.ok(list.workspaces.some(w => w.path === second), JSON.stringify(list.workspaces));
  } finally {
    fs.rmSync(path.join(process.env.HOME, ".cross-review", "config.json"), { force: true });
  }
});
