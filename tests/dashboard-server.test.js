// Dashboard server (Phase 3): workspace scan, Sessions API and list stream, token / Host /
// Origin checks, port choice, dashboard.json, idle exit, workspace registration and the
// `dashboard` command. Every server runs on a temp fixture root, never on a real folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixture, writeSession } from "./helpers/dashboard-fixture.js";
import { findWorkspaces } from "../skill-packs/cross-review/scripts/lib/dashboard/scan.js";
import { startDashboard, createListWatcher } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO, "skill-packs/cross-review/scripts/review-runner.js");
const BIN = path.join(REPO, "bin/cross-review.js");

let tmp;
const mk = name => fs.mkdtempSync(path.join(tmp, `${name}-`));
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-server-"))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fixture root and a running dashboard on it (port 0, no discovery file, no browser). */
async function serve(opts = {}) {
  const root = mk("root");
  const fx = buildFixture(root, { now: nowS(), livePid: process.pid });
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, ...opts });
  return { root, fx, d };
}

function request(port, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", d => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}
const bearer = d => ({ Authorization: `Bearer ${d.token}` });
const getJson = async (d, p) => {
  const r = await request(d.port, p, { headers: bearer(d) });
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return JSON.parse(r.text);
};

/** Minimal SSE client: collects events; next(pred) waits for the first unseen match. */
function sse(port, pathname, headers) {
  const events = [];
  let cursor = 0;
  let wake = () => {};
  let res = null;
  const r = http.request({ host: "127.0.0.1", port, path: pathname, headers: { Accept: "text/event-stream", ...headers } }, response => {
    res = response;
    let buf = "";
    response.setEncoding("utf8");
    response.on("data", chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { event: "message", data: "" };
        let isEvent = false;
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) { ev.event = line.slice(7); isEvent = true; }
          else if (line.startsWith("data: ")) { ev.data += line.slice(6); isEvent = true; }
        }
        if (isEvent) {
          ev.json = ev.data ? JSON.parse(ev.data) : null;
          events.push(ev);
          wake();
        }
      }
    });
  });
  r.on("error", () => {});
  r.end();
  return {
    events,
    get status() { return res && res.statusCode; },
    async next(pred = () => true, ms = 4000) {
      const end = Date.now() + ms;
      for (;;) {
        while (cursor < events.length) {
          const ev = events[cursor++];
          if (pred(ev)) return ev;
        }
        const left = end - Date.now();
        if (left <= 0) throw new Error(`no matching SSE event within ${ms} ms (${events.length} received)`);
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, Math.min(left, 100)); });
      }
    },
    close() { r.destroy(); },
  };
}

const find = (payload, id, ws) => [...payload.active, ...payload.history].find(s => s.id === id && (!ws || s.ws === ws));
const idOf = dir => path.basename(dir);

// ---------- 1 ----------

test("findWorkspaces: depth 0..3, not 4, not node_modules, hidden dirs or symlinks", () => {
  const root = mk("scan");
  const ws = rel => {
    const dir = path.join(root, rel);
    fs.mkdirSync(path.join(dir, ".cross-review", "sessions"), { recursive: true });
    return dir;
  };
  const found = [ws("."), ws("a"), ws("a/b"), ws("a/b/c")];
  ws("a/b/c/d");
  ws("node_modules/pkg");
  ws(".hidden/w");
  const target = ws("../outside-target");
  fs.symlinkSync(target, path.join(root, "link"));
  fs.symlinkSync(path.join(root, "a"), path.join(root, "x-link-to-a"));
  assert.deepEqual(findWorkspaces(root).sort(), found.map(p => path.resolve(p)).sort());
});

// ---------- 2 ----------

test("/api/sessions groups the fixture sessions with labels and order", async () => {
  const { d, fx } = await serve();
  try {
    const p = await getJson(d, "/api/sessions");
    const ids = list => list.map(s => `${s.ws}/${s.id}`);
    // active: newest `since` first
    assert.deepEqual(ids(p.active), [
      `harbor-app/${idOf(fx.sessions.running)}`,
      `harbor-app/${idOf(fx.sessions.waiting)}`,
      `inkwell/${idOf(fx.sessions.pr)}`,
      `harbor-app/${idOf(fx.sessions.stopped)}`,
      `services/orchard-api/${idOf(fx.sessions.warn)}`,
    ]);
    for (let i = 1; i < p.active.length; i++) assert.ok(p.active[i - 1].since >= p.active[i].since);
    // history: newest created_at first
    for (let i = 1; i < p.history.length; i++) assert.ok(p.history[i - 1].createdAt >= p.history[i].createdAt);
    assert.equal(p.history.length, 8);
    const label = key => find(p, idOf(fx.sessions[key])).label;
    assert.equal(label("running"), "reviewer working");
    assert.equal(label("waiting"), "agent's turn");
    assert.equal(label("stopped"), "stopped, resumable");
    assert.equal(label("noReply"), "no reply");
    assert.equal(label("think"), "consensus");
    assert.ok(find(p, idOf(fx.sessions.warn)).warn);
    assert.equal(find(p, idOf(fx.sessions.waiting)).warn, null);
    assert.match(find(p, idOf(fx.sessions.warn)).searchText, /model list cached forever/);
    assert.deepEqual(p.workspaces.map(w => w.ws).sort(), ["harbor-app", "inkwell", "services/orchard-api"]);
    assert.equal(p.depth, 3);
    assert.match(p.version, /^\d+\.\d+\.\d+$/);
  } finally {
    await d.close();
  }
});

// ---------- 3 ----------

test("Host, Origin, static paths and session keys are checked even with a valid token", async () => {
  const { d, fx } = await serve();
  try {
    const auth = bearer(d);
    assert.equal((await request(d.port, "/api/sessions", { headers: { ...auth, Host: `evil.example:${d.port}` } })).status, 403);
    assert.equal((await request(d.port, "/api/health", { headers: { ...auth, Host: `localhost:${d.port}` } })).status, 200);
    const cookie = { Cookie: `cr_token=${d.token}` };
    const reg = { "Content-Type": "application/json" };
    const ws = fx.workspaces.inkwell;
    assert.equal((await request(d.port, "/api/workspaces", { method: "POST", headers: { ...cookie, ...reg, Origin: "http://evil.example" }, body: { path: ws } })).status, 403);
    assert.equal((await request(d.port, "/api/workspaces", { method: "POST", headers: { ...cookie, ...reg }, body: { path: ws } })).status, 403);
    assert.equal((await request(d.port, "/api/workspaces", { method: "POST", headers: { ...cookie, ...reg, Origin: `http://127.0.0.1:${d.port}` }, body: { path: ws } })).status, 200);
    assert.equal((await request(d.port, "/../../etc/passwd", { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/avatars/../../server.js", { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/%2e%2e/%2e%2e/etc/passwd", { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/api/session?ws=..&id=x", { headers: auth })).status, 404);
    assert.equal((await request(d.port, `/api/session?ws=..&id=${idOf(fx.sessions.waiting)}`, { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/api/session?ws=harbor-app&id=..%2F..%2Fx", { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/api/session?ws=harbor-app&id=Review-impl-20261015-001", { headers: auth })).status, 404);
    assert.equal((await request(d.port, "/api/session?ws=harbor-app&id=review-impl-20261015-999", { headers: auth })).status, 404);
    const ok = await request(d.port, `/api/session?ws=harbor-app&id=${idOf(fx.sessions.waiting)}`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).state, "waiting");
    const page = await request(d.port, "/", { headers: auth });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(page.text, /<script>|style="/);
    assert.equal((await request(d.port, "/api/sessions", { headers: auth })).headers["cache-control"], "no-store");
  } finally {
    await d.close();
  }
});

test("a session folder that is a symlink is neither listed nor served", async () => {
  const root = mk("symlinked");
  fs.mkdirSync(path.join(root, ".cross-review", "sessions"), { recursive: true });
  const fx = buildFixture(mk("elsewhere"), { now: nowS(), livePid: 1 });
  const id = idOf(fx.sessions.waiting);
  fs.symlinkSync(fx.sessions.waiting, path.join(root, ".cross-review", "sessions", id));
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null });
  try {
    const p = await getJson(d, "/api/sessions");
    assert.equal(p.active.length + p.history.length, 0);
    assert.equal((await request(d.port, `/api/session?ws=.&id=${id}`, { headers: bearer(d) })).status, 404);
  } finally {
    await d.close();
  }
});

// ---------- 4, 4d ----------

test("list stream: a new event line changes Now; final.txt moves the session to waiting; reconnect gets the new state first", async () => {
  const { d, fx } = await serve({ tickMs: 200 });
  const dir = fx.sessions.running;
  const id = idOf(dir);
  const s = sse(d.port, "/api/stream?view=list", bearer(d));
  try {
    const first = await s.next(e => e.event === "sessions");
    assert.equal(find(first.json, id).state, "running");
    const oldNow = find(first.json, id).now;
    fs.appendFileSync(path.join(dir, "output.jsonl"), JSON.stringify({ type: "item.started", item: { id: "item_new", type: "command_execution", command: "/bin/zsh -lc 'rg -n invented_marker scripts'", status: "in_progress", exit_code: null } }) + "\n");
    const changed = await s.next(e => e.event === "sessions" && find(e.json, id).now !== oldNow, 3000);
    assert.equal(find(changed.json, id).now, "Searched for invented_marker");
    s.close();

    // While nobody is connected the round ends with a verdict
    const r3 = "### ISSUE-3: Per-skill override ignored\n- Severity: medium\n- Location: scripts/lib/config.js:63\n- Problem: Still replaced.\n\n### VERDICT\n- Status: REVISE\n- Reason: One left.\n";
    const { parseOutputMarkdown } = await import("../skill-packs/cross-review/scripts/lib/parse.js");
    fs.writeFileSync(path.join(dir, "final.txt"), JSON.stringify({ status: "completed", round: 3, elapsed_seconds: 130, thread_id: `thread-${id}`, review: parseOutputMarkdown(r3, "review-impl"), activities: [], convergence: { stalemate: false } }));
    const again = sse(d.port, "/api/stream?view=list", bearer(d));
    try {
      const ev = await again.next(() => true);
      assert.equal(ev.event, "sessions");
      assert.equal(find(ev.json, id).state, "waiting");
      assert.ok(ev.json.active.length && ev.json.history.length, "the first event is the full list");
    } finally {
      again.close();
    }
  } finally {
    s.close();
    await d.close();
  }
});

// ---------- 4b ----------

test("watcher: warn after 1200 s, no reply after 24 h, stopped leaves after 24 h — no file changes", async () => {
  const root = mk("clock");
  const base = 1_800_000_000;
  const fx = buildFixture(root, { now: base, livePid: process.pid });
  let now = base;
  const w = createListWatcher({ root, now: () => now, tickMs: 50 });
  const got = [];
  const off = w.subscribe(p => got.push(p));
  const latest = async pred => {
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const p = got[got.length - 1];
      if (p && pred(p)) return p;
      await sleep(20);
    }
    throw new Error("watcher did not emit the expected change");
  };
  try {
    const waitingId = idOf(fx.sessions.waiting);
    const stoppedId = idOf(fx.sessions.stopped);
    const p0 = await latest(() => true);
    const since = find(p0, waitingId).since;
    const stoppedSince = find(p0, stoppedId).since;
    now = since + 1199;
    await sleep(150);
    assert.equal(find(got[got.length - 1], waitingId).warn, null);
    const count = got.length;
    now = since + 1201;
    const p1 = await latest(p => find(p, waitingId).warn);
    assert.ok(got.length > count);
    assert.equal(find(p1, waitingId).group, "active");
    now = since + 86401;
    const p2 = await latest(p => find(p, waitingId).group === "history");
    assert.equal(find(p2, waitingId).label, "no reply");
    now = stoppedSince + 86399;
    await latest(p => find(p, stoppedId).group === "active");
    now = stoppedSince + 86401;
    const p3 = await latest(p => find(p, stoppedId).group === "history");
    assert.equal(find(p3, stoppedId).label, "stopped");
  } finally {
    off();
    w.close();
  }
});

// ---------- 4c ----------

test("list stream: a new session in a known workspace appears on the next tick; a new workspace after the rescan", async () => {
  const { d, root, fx } = await serve({ tickMs: 100, rescanMs: 500 });
  const s = sse(d.port, "/api/stream?view=list", bearer(d));
  try {
    await s.next(e => e.event === "sessions");
    const base = nowS();
    const done = { status: "completed", started: base - 100, elapsed: 50, review: "### VERDICT\n- Status: APPROVE\n- Reason: Fine.\n", acts: [] };
    writeSession(path.join(fx.workspaces.inkwell, ".cross-review", "sessions"), "review-impl-20261015-077", {
      skill: "review-impl", created: base - 100, inputs: ["## USER_REQUEST\nInvented late session.\n"], meta: "APPROVE", rounds: [done],
    });
    const a = await s.next(e => e.event === "sessions" && find(e.json, "review-impl-20261015-077", "inkwell"), 2000);
    assert.equal(find(a.json, "review-impl-20261015-077", "inkwell").title, "Invented late session.");
    const fresh = path.join(root, "late", "comer");
    writeSession(path.join(fresh, ".cross-review", "sessions"), "review-plan-20261015-078", {
      skill: "review-plan", created: base - 50, inputs: ["PLAN_PATH: /work/late/comer-plan.md\n"], meta: "APPROVE", rounds: [done],
    });
    const b = await s.next(e => e.event === "sessions" && find(e.json, "review-plan-20261015-078", "late/comer"), 3000);
    assert.ok(b.json.workspaces.some(w => w.ws === "late/comer"));
  } finally {
    s.close();
    await d.close();
  }
});

// ---------- 5 ----------

test("port: random in [20000, 30000]; busy ports are skipped; 50 busy ports fail", async () => {
  const root = mk("port");
  const d = await startDashboard({ root, open: false, discoveryFile: null });
  try {
    assert.ok(d.port >= 20000 && d.port <= 30000, `port ${d.port}`);
  } finally {
    await d.close();
  }
  const busy = [];
  for (let i = 0; i < 3; i++) {
    const srv = net.createServer();
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    busy.push(srv);
  }
  const free = await new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const picks = [...busy.map(s => s.address().port), free];
  let calls = 0;
  try {
    const d2 = await startDashboard({ root, open: false, discoveryFile: null, pickPort: () => picks[calls++] });
    assert.equal(d2.port, free);
    assert.equal(calls, 4);
    await d2.close();
    let n = 0;
    await assert.rejects(
      startDashboard({ root, open: false, discoveryFile: null, pickPort: () => { n++; return busy[0].address().port; } }),
      /No free port/,
    );
    assert.equal(n, 50);
  } finally {
    for (const s of busy) s.close();
  }
});

// ---------- 6 ----------

test("token: 401 without it, 303 with a cookie for the right one, Bearer accepted", async () => {
  const { d } = await serve();
  try {
    for (const p of ["/", "/app.js", "/api/sessions", "/api/stream?view=list", "/avatars/you.png"]) {
      const r = await request(d.port, p);
      assert.equal(r.status, 401, p);
    }
    const page = await request(d.port, "/", { headers: { Accept: "text/html" } });
    assert.match(page.text, /Open the dashboard from the link printed in the terminal/);
    assert.equal((await request(d.port, `/?t=${"0".repeat(64)}`)).status, 401);
    assert.equal((await request(d.port, "/?t=short")).status, 401);
    assert.equal((await request(d.port, "/", { headers: { Cookie: "cr_token=nope" } })).status, 401);
    const r = await request(d.port, `/?t=${d.token}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    const set = String(r.headers["set-cookie"]);
    assert.match(set, /cr_token=/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const cookie = set.split(";")[0];
    assert.equal((await request(d.port, "/", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request(d.port, "/app.js", { headers: { Cookie: `other=1; ${cookie}` } })).status, 200);
    assert.equal((await request(d.port, "/api/sessions", { headers: bearer(d) })).status, 200);
    assert.equal((await request(d.port, "/api/sessions", { headers: { Authorization: "Bearer nope" } })).status, 401);
    assert.match(d.token, /^[0-9a-f]{64}$/);
  } finally {
    await d.close();
  }
});

// ---------- 7 ----------

test("dashboard.json: written 0600 with pid, port, token, root; removed on close unless another process owns it", async () => {
  const root = mk("disc");
  const file = path.join(mk("home"), ".cross-review", "dashboard.json");
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: file });
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual({ pid: info.pid, port: info.port, token: info.token, root: info.root }, { pid: process.pid, port: d.port, token: d.token, root: fs.realpathSync(root) });
  assert.equal(typeof info.started_at, "number");
  await d.close();
  assert.equal(fs.existsSync(file), false);

  const d2 = await startDashboard({ root, port: 0, open: false, discoveryFile: file });
  const other = { pid: 1, port: 1234, token: "f".repeat(64), root: "/elsewhere", started_at: 1 };
  fs.writeFileSync(file, JSON.stringify(other));
  await d2.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), other);
});

// ---------- 8, AC-3.5 ----------

/** Spawn a dashboard command with a temp HOME; resolves once it prints its URL. */
function spawnDashboard(args, home) {
  const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const exited = new Promise(r => child.on("exit", (code, signal) => r({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", d => {
      out += d;
      const m = out.match(/cross-review dashboard: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64}) {2}\(scanning (.+), 3 levels down\)/);
      if (m) resolve({ port: Number(m[1]), token: m[2], root: m[3] });
    });
    child.stderr.on("data", d => { err += d; });
    exited.then(() => reject(new Error(`exited before printing its URL: ${out}${err}`)));
  });
  return { child, ready, exited };
}

test("--idle-exit 2: exits about 2 s after the last stream closes, not while one is open", async () => {
  const root = mk("idle");
  buildFixture(root, { now: nowS(), livePid: 1 });
  const home = mk("home");
  const run = spawnDashboard([RUNNER, "dashboard", "--root", root, "--no-open", "--port", "0", "--idle-exit", "2"], home);
  const info = await run.ready;
  const s = sse(info.port, "/api/stream?view=list", { Authorization: `Bearer ${info.token}` });
  await s.next(e => e.event === "sessions");
  const early = await Promise.race([run.exited, sleep(3500).then(() => "alive")]);
  assert.equal(early, "alive", "exited while a stream was open");
  const closedAt = Date.now();
  s.close();
  const result = await Promise.race([run.exited, sleep(6000).then(() => null)]);
  assert.ok(result, "did not exit after the stream closed");
  assert.equal(result.code, 0);
  const waited = Date.now() - closedAt;
  assert.ok(waited >= 1500 && waited < 5000, `exited after ${waited} ms`);
  assert.equal(fs.existsSync(path.join(home, ".cross-review", "dashboard.json")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

for (const [name, script] of [["review-runner.js dashboard", RUNNER], ["bin/cross-review.js dashboard", BIN]]) {
  test(`${name}: serves the root, writes dashboard.json, installs nothing, exits on SIGTERM`, async () => {
    const root = mk("cmd");
    buildFixture(root, { now: nowS(), livePid: 1 });
    const home = mk("home");
    const run = spawnDashboard([script, "dashboard", "--root", root, "--no-open"], home);
    try {
      const info = await run.ready;
      assert.ok(info.port >= 20000 && info.port <= 30000);
      assert.equal(info.root, fs.realpathSync(root));
      const health = await request(info.port, "/api/health", { headers: { Authorization: `Bearer ${info.token}` } });
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.text), { ok: true, root: fs.realpathSync(root), pid: run.child.pid });
      const disc = JSON.parse(fs.readFileSync(path.join(home, ".cross-review", "dashboard.json"), "utf8"));
      assert.equal(disc.port, info.port);
      run.child.kill("SIGTERM");
      const { code } = await run.exited;
      assert.equal(code, 0);
      assert.equal(fs.existsSync(path.join(home, ".cross-review", "dashboard.json")), false);
      assert.equal(fs.existsSync(path.join(home, ".claude")), false);
      assert.equal(fs.existsSync(path.join(home, ".agents")), false);
    } finally {
      run.child.kill("SIGKILL");
    }
  });
}

test("dashboard command: bad arguments fail with a message", async () => {
  const home = mk("home");
  const run = spawnDashboard([RUNNER, "dashboard", "--root", path.join(tmp, "does-not-exist"), "--no-open"], home);
  await assert.rejects(run.ready);
  const { code } = await run.exited;
  assert.equal(code, 1);
});

// ---------- 9 ----------

test("POST /api/workspaces: a workspace outside the root is followed under its absolute path; a folder without sessions is 400", async () => {
  const { d } = await serve();
  const outside = mk("outside");
  const base = nowS();
  writeSession(path.join(outside, ".cross-review", "sessions"), "review-impl-20261015-050", {
    skill: "review-impl", created: base - 60, inputs: ["## USER_REQUEST\nInvented outside session.\n"], meta: "APPROVE",
    rounds: [{ status: "completed", started: base - 60, elapsed: 30, review: "### VERDICT\n- Status: APPROVE\n- Reason: Fine.\n", acts: [] }],
  });
  try {
    const post = body => request(d.port, "/api/workspaces", { method: "POST", headers: { ...bearer(d), "Content-Type": "application/json" }, body });
    assert.equal(find(await getJson(d, "/api/sessions"), "review-impl-20261015-050"), undefined);
    const r = await post({ path: outside });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).ws, outside);
    const s = find(await getJson(d, "/api/sessions"), "review-impl-20261015-050");
    assert.equal(s.ws, outside);
    assert.equal((await request(d.port, `/api/session?ws=${encodeURIComponent(outside)}&id=review-impl-20261015-050`, { headers: bearer(d) })).status, 200);
    assert.equal((await post({ path: mk("empty") })).status, 400);
    assert.equal((await post({ path: "relative/path" })).status, 400);
    assert.equal((await post("not json")).status, 400);
  } finally {
    await d.close();
  }
});

// ---------- Phase 4: activity, prompt, reveal, session stream ----------

const q = (fx, key) => `ws=harbor-app&id=${idOf(fx.sessions[key])}`;
const lineCount = file => fs.readFileSync(file, "utf8").split("\n").length - 1;
const appendLines = (file, lines) => fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
const started = (id, command) => ({ type: "item.started", item: { id, type: "command_execution", command: `/bin/zsh -lc '${command}'`, aggregated_output: "", exit_code: null, status: "in_progress" } });
const completed = (id, command, exit) => ({ type: "item.completed", item: { id, type: "command_execution", command: `/bin/zsh -lc '${command}'`, aggregated_output: "", exit_code: exit, status: exit === 0 ? "completed" : "failed" } });

test("/api/activity: pages of 20 by `before`, hasEarlier false on the last page; unknown round and bad limit fail", async () => {
  const { d, fx } = await serve();
  try {
    const p1 = await getJson(d, `/api/activity?${q(fx, "running")}&limit=20`);
    assert.equal(p1.round, 3);
    assert.equal(p1.total, 45);
    assert.equal(p1.items.length, 20);
    assert.equal(p1.hasEarlier, true);
    for (let i = 1; i < p1.items.length; i++) assert.ok(p1.items[i - 1].line < p1.items[i].line);
    assert.ok(p1.items.every(x => /^3:item_\d+$/.test(x.key) && typeof x.t === "number" && x.text));
    const p2 = await getJson(d, `/api/activity?${q(fx, "running")}&round=3&before=${p1.items[0].line}&limit=20`);
    assert.equal(p2.items.length, 20);
    assert.equal(p2.hasEarlier, true);
    assert.ok(p2.items[19].line < p1.items[0].line);
    const p3 = await getJson(d, `/api/activity?${q(fx, "running")}&round=3&before=${p2.items[0].line}&limit=20`);
    assert.equal(p3.items.length, 5);
    assert.equal(p3.hasEarlier, false);
    assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map(x => x.key)).size, 45);
    const r1 = await getJson(d, `/api/activity?${q(fx, "running")}&round=1`);
    assert.equal(r1.round, 1);
    assert.equal(r1.total, 12);
    assert.ok(r1.items.every(x => x.key.startsWith("1:")));
    assert.equal((await request(d.port, `/api/activity?${q(fx, "running")}&round=9`, { headers: bearer(d) })).status, 404);
    assert.equal((await request(d.port, `/api/activity?${q(fx, "running")}&limit=-1`, { headers: bearer(d) })).status, 400);
    assert.equal((await request(d.port, `/api/activity?ws=harbor-app&id=review-impl-20261015-999`, { headers: bearer(d) })).status, 404);
  } finally {
    await d.close();
  }
});

test("/api/prompt: the round's prompt as text; a round without one is 404", async () => {
  const { d, fx } = await serve();
  try {
    const r = await request(d.port, `/api/prompt?${q(fx, "approved")}&round=2`, { headers: bearer(d) });
    assert.equal(r.status, 200);
    assert.equal(r.text, "Invented prompt for round 2.\n");
    assert.match(r.headers["content-type"], /^text\/plain/);
    assert.equal((await request(d.port, `/api/prompt?${q(fx, "approved")}&round=7`, { headers: bearer(d) })).status, 404);
    assert.equal((await request(d.port, `/api/prompt?${q(fx, "approved")}&round=x`, { headers: bearer(d) })).status, 404);
  } finally {
    await d.close();
  }
});

test("session stream: snapshot first; new items arrive as `add` in order with `t`; a command's completion is an `update` of the same key", async () => {
  const { d, fx } = await serve({ tickMs: 100 });
  const dir = fx.sessions.running;
  const log = path.join(dir, "output.jsonl");
  const times = path.join(dir, "outputs", "times-round-003.jsonl");
  const s = sse(d.port, `/api/stream?view=session&${q(fx, "running")}`, bearer(d));
  try {
    const snap = await s.next(() => true);
    assert.equal(snap.event, "snapshot");
    assert.deepEqual(snap.json, { round: 3, total: 45 });

    const base = lineCount(log);
    const startedAt = JSON.parse(fs.readFileSync(path.join(dir, "rounds.json"), "utf8"))[2].started_at;
    appendLines(log, [
      { type: "item.completed", item: { id: "new_a", type: "reasoning", text: "Invented thought A." } },
      { type: "item.completed", item: { id: "new_b", type: "reasoning", text: "Invented thought B." } },
      { type: "item.completed", item: { id: "new_c", type: "reasoning", text: "Invented thought C." } },
    ]);
    fs.appendFileSync(times, `${JSON.stringify([base + 3, startedAt + 500])}\n`);
    const adds = [];
    for (let i = 0; i < 3; i++) adds.push(await s.next(e => e.event === "activity"));
    assert.deepEqual(adds.map(e => [e.json.op, e.json.key]), [["add", "3:new_a"], ["add", "3:new_b"], ["add", "3:new_c"]]);
    assert.deepEqual(adds.map(e => e.json.total), [48, 48, 48]);
    assert.ok(adds.every(e => e.json.item.t === 500 && e.json.item.key === e.json.key));

    appendLines(log, [started("cmd_ok", "node --test tests/a.test.js"), started("cmd_bad", "npm test")]);
    const a1 = await s.next(e => e.event === "activity" && e.json.key === "3:cmd_ok");
    const a2 = await s.next(e => e.event === "activity" && e.json.key === "3:cmd_bad");
    assert.equal(a1.json.op, "add");
    assert.equal(a2.json.op, "add");
    assert.equal(a1.json.item.exitCode, null);
    appendLines(log, [completed("cmd_ok", "node --test tests/a.test.js", 0), completed("cmd_bad", "npm test", 1)]);
    const u1 = await s.next(e => e.event === "activity" && e.json.key === "3:cmd_ok");
    const u2 = await s.next(e => e.event === "activity" && e.json.key === "3:cmd_bad");
    assert.deepEqual([u1.json.op, u1.json.item.exitCode, u1.json.item.result], ["update", 0, "passed"]);
    assert.deepEqual([u2.json.op, u2.json.item.exitCode, u2.json.item.result], ["update", 1, "failed (exit 1)"]);
    assert.equal(u2.json.total, 50);

    const page = await getJson(d, `/api/activity?${q(fx, "running")}&limit=20`);
    assert.equal(page.total, 50);
    assert.equal(page.items.filter(x => x.key === "3:cmd_ok" || x.key === "3:cmd_bad").length, 2);
  } finally {
    s.close();
    await d.close();
  }
});

test("session stream: reconnect gets a snapshot with the new total; a round that ended while away keeps its round and reads as waiting", async () => {
  const { d, fx } = await serve({ tickMs: 100 });
  const dir = fx.sessions.running;
  const log = path.join(dir, "output.jsonl");
  const url = `/api/stream?view=session&${q(fx, "running")}`;
  let s = sse(d.port, url, bearer(d));
  try {
    assert.deepEqual((await s.next(() => true)).json, { round: 3, total: 45 });
    s.close();
    appendLines(log, [
      { type: "item.completed", item: { id: "away_1", type: "reasoning", text: "Invented while away 1." } },
      { type: "item.completed", item: { id: "away_2", type: "reasoning", text: "Invented while away 2." } },
    ]);
    s = sse(d.port, url, bearer(d));
    const again = await s.next(() => true);
    assert.equal(again.event, "snapshot");
    assert.deepEqual(again.json, { round: 3, total: 47 });
    s.close();

    // Round 3 ends with REVISE while nobody watches; no round 4 starts
    const { parseOutputMarkdown } = await import("../skill-packs/cross-review/scripts/lib/parse.js");
    const r3 = "### ISSUE-3: Per-skill override ignored\n- Severity: medium\n- Location: scripts/lib/config.js:63\n- Problem: Still replaced.\n\n### VERDICT\n- Status: REVISE\n- Reason: One left.\n";
    appendLines(log, [{ type: "item.completed", item: { id: "final_msg", type: "agent_message", text: r3 } }, { type: "turn.completed", usage: {} }]);
    fs.writeFileSync(path.join(dir, "final.txt"), JSON.stringify({ status: "completed", round: 3, elapsed_seconds: 130, thread_id: `thread-${idOf(dir)}`, review: parseOutputMarkdown(r3, "review-impl"), activities: [], convergence: { stalemate: false } }));
    s = sse(d.port, url, bearer(d));
    const back = await s.next(() => true);
    assert.equal(back.event, "snapshot");
    assert.equal(back.json.round, 3);
    const detail = await getJson(d, `/api/session?${q(fx, "running")}`);
    assert.equal(detail.state, "waiting");
    assert.equal(detail.wsName, "harbor-app");

    // While connected, finalizing the session is a `session` event
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ skill: "review-impl", verdict: "REVISE", rounds: 3 }));
    await s.next(e => e.event === "session", 3000);
  } finally {
    s.close();
    await d.close();
  }
});

test("session stream: unknown session is 404; POST /api/reveal needs a matching Origin and opens only the session's folder", async () => {
  const opened = [];
  const { d, fx } = await serve({ reveal: dir => opened.push(dir) });
  try {
    assert.equal((await request(d.port, "/api/stream?view=session&ws=harbor-app&id=review-impl-20261015-999", { headers: bearer(d) })).status, 404);
    const cookie = { Cookie: `cr_token=${d.token}`, "Content-Type": "application/json" };
    const body = { ws: "harbor-app", id: idOf(fx.sessions.waiting) };
    assert.equal((await request(d.port, "/api/reveal", { method: "POST", headers: cookie, body })).status, 403);
    assert.equal((await request(d.port, "/api/reveal", { method: "POST", headers: { ...cookie, Origin: "http://evil.example" }, body })).status, 403);
    assert.deepEqual(opened, []);
    const origin = { ...cookie, Origin: `http://127.0.0.1:${d.port}` };
    assert.equal((await request(d.port, "/api/reveal", { method: "POST", headers: origin, body: { ws: "harbor-app", id: "review-impl-20261015-999" } })).status, 404);
    const ok = await request(d.port, "/api/reveal", { method: "POST", headers: origin, body });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(opened, [fx.sessions.waiting]);
  } finally {
    await d.close();
  }
});
