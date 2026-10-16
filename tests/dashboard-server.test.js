// Dashboard server (Phase 3): workspace scan, Sessions API and list stream, token / Host /
// Origin checks, port choice, dashboard.json, idle exit, workspace registration and the
// `dashboard` command. Every server runs on a temp fixture root, never on a real folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixture, buildPlans, PLANS, writePlan, writeSession } from "./helpers/dashboard-fixture.js";
import { GITIGNORE } from "../skill-packs/cross-review/scripts/lib/config.js";
import { findWorkspaces } from "../skill-packs/cross-review/scripts/lib/dashboard/scan.js";
import { startDashboard, createListWatcher } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO, "skill-packs/cross-review/scripts/review-runner.js");
const BIN = path.join(REPO, "bin/cross-review.js");

let tmp;
const mk = name => fs.mkdtempSync(path.join(tmp, `${name}-`));
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const savedHome = process.env.HOME;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-server-")));
  // Settings and avatars live under HOME: never the real one
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fixture root and a running dashboard on it (port 0, no discovery file, no browser, the invented catalog). */
async function serve(opts = {}) {
  const root = mk("root");
  const fx = buildFixture(root, { now: nowS(), livePid: process.pid });
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: CATALOG, ...opts });
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
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: CATALOG });
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

test("watcher: warn after 1200 s, no reply after 1 h, stopped leaves after 1 h — no file changes", async () => {
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
    now = since + 3601;
    const p2 = await latest(p => find(p, waitingId).group === "history");
    assert.equal(find(p2, waitingId).label, "no reply");
    now = stoppedSince + 3599;
    await latest(p => find(p, stoppedId).group === "active");
    now = stoppedSince + 3601;
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
  const d = await startDashboard({ root, open: false, discoveryFile: null, catalog: CATALOG });
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
    const d2 = await startDashboard({ root, open: false, discoveryFile: null, catalog: CATALOG, pickPort: () => picks[calls++] });
    assert.equal(d2.port, free);
    assert.equal(calls, 4);
    await d2.close();
    let n = 0;
    await assert.rejects(
      startDashboard({ root, open: false, discoveryFile: null, catalog: CATALOG, pickPort: () => { n++; return busy[0].address().port; } }),
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
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: file, catalog: CATALOG });
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual({ pid: info.pid, port: info.port, token: info.token, root: info.root }, { pid: process.pid, port: d.port, token: d.token, root: fs.realpathSync(root) });
  assert.equal(typeof info.started_at, "number");
  await d.close();
  assert.equal(fs.existsSync(file), false);

  const d2 = await startDashboard({ root, port: 0, open: false, discoveryFile: file, catalog: CATALOG });
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

    // the watchdog stamps those lines after the dashboard saw them: the time arrives as an update
    assert.equal(u1.json.item.t, null);
    fs.appendFileSync(times, `${JSON.stringify([lineCount(log), startedAt + 600])}\n`);
    const stamped = await s.next(e => e.event === "activity" && e.json.key === "3:cmd_ok");
    assert.deepEqual([stamped.json.op, stamped.json.item.t], ["update", 600]);

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

// ---------- Phase 5: settings and avatars ----------

const CATALOG = {
  listModels: async () => [{ slug: "model-a", name: "Model A", description: "Invented.", efforts: ["low", "high"] }],
  defaultModel: () => "model-a",
  cliInfo: async () => ({ version: "codex-cli 9.9.9-invented", loggedIn: true }),
};
const originOf = d => ({ Origin: `http://127.0.0.1:${d.port}`, Cookie: `cr_token=${d.token}` });

test("settings: GET lists both levels and the catalog; POST writes the workspace file with a .gitignore; bad input changes nothing", async () => {
  const { d, fx } = await serve({ catalog: CATALOG });
  const wsFile = path.join(fx.workspaces.harbor, ".cross-review", "config.json");
  const post = (body, headers = originOf(d)) => request(d.port, "/api/settings", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body });
  try {
    fs.rmSync(path.join(fx.workspaces.harbor, ".cross-review", ".gitignore"), { force: true });
    let s = await getJson(d, "/api/settings");
    assert.deepEqual(s.global, {});
    assert.deepEqual(Object.keys(s.workspaces).sort(), ["harbor-app", "inkwell", "services/orchard-api"]);
    assert.equal(s.models[0].slug, "model-a");
    assert.equal(s.codexDefault, "model-a");
    assert.deepEqual(s.reviewer, { version: "codex-cli 9.9.9-invented", loggedIn: true });

    const ok = await post({ scope: "workspace", ws: "harbor-app", config: { effort: "low", skills: { "review-impl": { model: "model-a" } } } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf8")), { effort: "low", skills: { "review-impl": { model: "model-a" } } });
    assert.equal(fs.readFileSync(path.join(fx.workspaces.harbor, ".cross-review", ".gitignore"), "utf8"), "*\n");
    const before = fs.readFileSync(wsFile, "utf8");
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: { effort: "Not An Effort" } })).status, 400);
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: { surprise: 1 } })).status, 400);
    assert.equal((await post({ scope: "workspace", ws: "no-such-ws", config: {} })).status, 400);
    assert.equal((await post({ scope: "elsewhere", config: {} })).status, 400);
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: { model: "x" }, pad: "y".repeat(70 * 1024) })).status, 413);
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: {} }, { Cookie: `cr_token=${d.token}` })).status, 403);
    assert.equal(fs.readFileSync(wsFile, "utf8"), before);

    assert.equal((await post({ scope: "global", config: { open_dashboard: true } })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".cross-review", "config.json"), "utf8")), { open_dashboard: true });
    s = await getJson(d, "/api/settings");
    assert.deepEqual(s.workspaces["harbor-app"], { effort: "low", skills: { "review-impl": { model: "model-a" } } });
    // An empty config removes the file
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: {} })).status, 200);
    assert.equal(fs.existsSync(wsFile), false);
    // A broken file is reported, not hidden
    fs.writeFileSync(wsFile, "{ broken");
    s = await getJson(d, "/api/settings");
    assert.match(s.errors.workspaces["harbor-app"], /not valid JSON/);
    assert.equal(s.errors.global, undefined);
    const models = await getJson(d, "/api/models?refresh=1");
    assert.equal(models.models.length, 1);
    assert.equal(typeof models.fetchedAt, "number");
  } finally {
    fs.rmSync(wsFile, { force: true });
    fs.rmSync(path.join(process.env.HOME, ".cross-review", "config.json"), { force: true });
    await d.close();
  }
});

test("settings: workspaces named __proto__ and global are listed; a broken workspace file is not reported as the global one", async () => {
  const root = mk("odd-names");
  for (const ws of ["__proto__", "global"]) {
    writeSession(path.join(root, ws, ".cross-review", "sessions"), "review-impl-20261016-001", {
      skill: "review-impl", mode: "branch", created: nowS() - 60, meta: "APPROVE",
      inputs: ["## USER_REQUEST\nInvented request.\n"],
      rounds: [{ status: "completed", started: nowS() - 60, elapsed: 1, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented approval.\n" }],
    });
  }
  fs.writeFileSync(path.join(root, "__proto__", ".cross-review", "config.json"), JSON.stringify({ effort: "low" }));
  fs.writeFileSync(path.join(root, "global", ".cross-review", "config.json"), "{ broken");
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: CATALOG });
  try {
    const s = await getJson(d, "/api/settings");
    assert.deepEqual(Object.keys(s.workspaces).sort(), ["__proto__", "global"]);
    assert.deepEqual(Object.keys(s.paths).sort(), ["__proto__", "global"]);
    assert.deepEqual(s.workspaces.__proto__, { effort: "low" });
    assert.equal(s.errors.global, undefined);
    assert.match(s.errors.workspaces.global, /not valid JSON/);
  } finally {
    await d.close();
  }
});

/** A catalog that answers only when the test says so; `calls` counts listModels calls. */
function slowCatalog() {
  const c = { calls: 0, pending: [] };
  c.listModels = () => {
    c.calls++;
    return new Promise(resolve => c.pending.push(resolve));
  };
  c.answer = list => {
    for (const resolve of c.pending.splice(0)) resolve(list);
  };
  c.defaultModel = () => "model-a";
  c.cliInfo = async () => ({ version: "codex-cli 9.9.9-invented", loggedIn: true });
  return c;
}
const OLD_MODELS = [{ slug: "model-old", name: "Model Old", description: "Invented, cached.", efforts: ["high"] }];
const NEW_MODELS = [{ slug: "model-a", name: "Model A", description: "Invented.", efforts: ["low", "high"] }];
const writeCache = (file, models) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ models, reviewer: { version: "codex-cli 9.9.8-invented", loggedIn: true }, fetchedAt: 1000 }));
};

test("models: a cached catalog answers at once while the server asks the reviewer again; the answer replaces the cache", async () => {
  const cache = path.join(mk("models-cache"), "models.json");
  writeCache(cache, OLD_MODELS);
  const catalog = slowCatalog();
  const { d } = await serve({ catalog, catalogCache: cache });
  try {
    // the server asked at start, before any page did
    assert.equal(catalog.calls, 1);
    let s = await getJson(d, "/api/settings");
    assert.deepEqual([s.models, s.modelsFetchedAt, s.modelsRefreshing, s.reviewer.version], [OLD_MODELS, 1000, true, "codex-cli 9.9.8-invented"]);
    // /api/models waits for the answer in flight instead of asking again
    const fresh = getJson(d, "/api/models");
    await new Promise(r => setTimeout(r, 50));
    assert.equal(catalog.calls, 1);
    catalog.answer(NEW_MODELS);
    const m = await fresh;
    assert.deepEqual([m.models, m.reviewer.version, m.refreshing], [NEW_MODELS, "codex-cli 9.9.9-invented", false]);
    assert.ok(m.fetchedAt > 1000);
    s = await getJson(d, "/api/settings");
    assert.deepEqual([s.models, s.modelsRefreshing], [NEW_MODELS, false]);
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).models, NEW_MODELS);
  } finally {
    catalog.answer(null);
    await d.close();
  }
});

test("models: a failed refresh keeps the cached list; with no cache the first settings load waits for the reviewer once", async () => {
  const cache = path.join(mk("models-cache"), "models.json");
  writeCache(cache, OLD_MODELS);
  let catalog = slowCatalog();
  let { d } = await serve({ catalog, catalogCache: cache });
  try {
    catalog.answer(null); // the reviewer CLI is gone or broken
    const m = await getJson(d, "/api/models");
    assert.deepEqual(m.models, OLD_MODELS);
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).models, OLD_MODELS);
  } finally {
    await d.close();
  }
  fs.rmSync(cache);
  catalog = slowCatalog();
  ({ d } = await serve({ catalog, catalogCache: cache }));
  try {
    let answered = false;
    const s = getJson(d, "/api/settings").then(x => { answered = true; return x; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(answered, false, "nothing to show yet: the first load waits");
    catalog.answer(NEW_MODELS);
    assert.deepEqual((await s).models, NEW_MODELS);
    assert.equal(catalog.calls, 1, "the load waited for the request the start made");
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")).models, NEW_MODELS);
  } finally {
    catalog.answer(null);
    await d.close();
  }
});

test("models: an injected catalog writes no cache unless one is named", async () => {
  const file = path.join(process.env.HOME, ".cross-review", "models.json");
  fs.rmSync(file, { force: true });
  const { d } = await serve({ catalog: CATALOG });
  try {
    await getJson(d, "/api/settings");
    assert.equal(fs.existsSync(file), false);
  } finally {
    await d.close();
  }
});

test("avatars: a real PNG is stored and served byte for byte; renamed text, over 1 MB and bad keys are refused", async () => {
  const { d } = await serve({ catalog: CATALOG });
  const png = fs.readFileSync(path.join(REPO, "skill-packs/cross-review/scripts/lib/dashboard/ui/avatars/you.png"));
  const upload = (key, body, headers = originOf(d)) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: d.port, path: `/api/avatars/${key}`, method: "POST", headers: { ...headers, "Content-Type": "image/png", "Content-Length": body.length } }, res => {
      let text = "";
      res.on("data", c => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    r.on("error", reject);
    r.end(body);
  });
  const getRaw = p => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: d.port, path: p, headers: bearer(d) }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  try {
    assert.equal((await upload("you", png)).status, 200);
    const got = await getRaw("/avatars/you");
    assert.equal(got.status, 200);
    assert.equal(got.type, "image/png");
    assert.ok(got.body.equals(png));
    assert.ok(fs.existsSync(path.join(process.env.HOME, ".cross-review", "avatars", "you.png")));
    assert.equal((await upload("agent%3Aclaude-code", png)).status, 200);
    assert.ok(fs.existsSync(path.join(process.env.HOME, ".cross-review", "avatars", "agent-claude-code.png")));

    assert.equal((await upload("you", Buffer.from("just text, renamed to .png"))).status, 400);
    assert.equal((await upload("you", Buffer.concat([png.subarray(0, 8), Buffer.alloc(1024 * 1024 + 10)]))).status, 413);
    assert.equal((await upload("..%2Fx", png)).status, 400);
    assert.equal((await upload("reviewer%3AUPPER", png)).status, 400);
    assert.equal((await upload("you", png, { Cookie: `cr_token=${d.token}` })).status, 403);
    assert.ok((await getRaw("/avatars/you")).body.equals(png), "a refused upload leaves the image");

    const list = await getJson(d, "/api/avatars");
    assert.deepEqual(list.keys, ["agent:claude-code", "you"]);
    const byKey = Object.fromEntries(list.parties.map(p => [p.key, p]));
    assert.equal(byKey.you.label, "You");
    assert.equal(byKey["reviewer:codex"].label, "Reviewer · Codex");
    assert.equal(byKey["agent:claude-code"].label, "Agent · Claude Code");
    assert.equal(byKey["agent:claude-code"].seenIn, "2 sessions");
    assert.equal(byKey["agent:codex-mcp-client"].seenIn, "1 session");
    assert.equal(byKey["agent:unknown"].label, "Agent");

    const del = await request(d.port, "/api/avatars/you", { method: "DELETE", headers: originOf(d) });
    assert.equal(del.status, 200);
    assert.equal((await getRaw("/avatars/you")).status, 404);
    assert.equal((await request(d.port, "/api/avatars/agent%3Aclaude-code", { method: "DELETE", headers: { Cookie: `cr_token=${d.token}` } })).status, 403);
  } finally {
    fs.rmSync(path.join(process.env.HOME, ".cross-review", "avatars"), { recursive: true, force: true });
    await d.close();
  }
});

// ---------- plans (dashboard-plans plan, Phase 3) ----------

async function servePlans(opts = {}) {
  const root = mk("plans-root");
  const fx = buildFixture(root, { now: nowS(), livePid: process.pid });
  const pl = buildPlans(fx);
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: CATALOG, ...opts });
  return { root, fx, pl, d };
}
const planOf = (p, ws, file) => p.plans.find(x => x.ws === ws && x.file === file);
const planUrl = (ws, file) => `/api/plan?ws=${encodeURIComponent(ws)}&file=${encodeURIComponent(file)}`;
const GIT_ENV = { GIT_AUTHOR_NAME: "Invented", GIT_AUTHOR_EMAIL: "invented@example.invalid", GIT_COMMITTER_NAME: "Invented", GIT_COMMITTER_EMAIL: "invented@example.invalid" };
const git = (ws, ...args) => {
  const r = spawnSync("git", ["-C", ws, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.ok(r.status === 0 || args[0] === "check-ignore", `git ${args.join(" ")}: ${r.stderr}`);
  return r;
};
/** A review-plan session on `planPath`: rounds running/completed as given, ended with `meta`. */
function reviewPlanOn(ws, id, planPath, { rounds = 1, running = true, meta = null } = {}) {
  const t = nowS();
  const list = [];
  for (let i = 1; i <= rounds; i++) {
    const last = i === rounds;
    list.push(last && running
      ? { status: "running", started: t - 60, elapsed: 0, acts: [] }
      : { status: "completed", started: t - 600 + i * 60, elapsed: 30, review: "### VERDICT\n- Status: REVISE\n- Reason: Invented.\n", acts: [] });
  }
  return writeSession(path.join(ws, ".cross-review", "sessions"), id, {
    skill: "review-plan", created: t - 600, inputs: [`PLAN_PATH: ${planPath}\n\n## USER_REQUEST\nInvented plan review.\n`],
    state: { pid: process.pid, pgid: process.pid, ...(meta ? { ended_at: t, end_outcome: "finalized" } : {}) }, rounds: list, meta,
  });
}
/** A review-impl session that waits for the agent (REVISE), or approved and finalized. */
function implSession(ws, id, approved) {
  const t = nowS();
  return writeSession(path.join(ws, ".cross-review", "sessions"), id, {
    skill: "review-impl", mode: "branch", created: t - 900, inputs: ["BASE_BRANCH: a1b2c3d\n\n## USER_REQUEST\nInvented checkpoint.\n"],
    state: approved ? { ended_at: t, end_outcome: "finalized" } : {}, meta: approved ? "APPROVE" : null,
    rounds: [
      { status: "completed", started: t - 900, elapsed: 60, review: "### VERDICT\n- Status: REVISE\n- Reason: Invented.\n", acts: [] },
      ...(approved ? [{ status: "completed", started: t - 300, elapsed: 60, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n", acts: [] }] : []),
    ],
  });
}

test("plans: a workspace with only plans is listed with its plan", async () => {
  const { d } = await servePlans();
  try {
    const p = await getJson(d, "/api/sessions");
    assert.ok(p.workspaces.some(w => w.ws === "atlas-notes"));
    const it = planOf(p, "atlas-notes", "kế-hoạch.md");
    assert.equal(it.title, "Tag colours");
    assert.equal(it.wsName, "atlas-notes");
    assert.equal(it.state, "draft");
    assert.equal([...p.active, ...p.history].some(s => s.ws === "atlas-notes"), false);
  } finally {
    await d.close();
  }
});

test("plans in the list: five states, review while a review-plan session is active, fields and order", async () => {
  const { d, fx, pl, root } = await servePlans();
  try {
    // within a group, the newest change first
    const t = Date.now() / 1000;
    fs.utimesSync(pl.files.draft, t - 500, t - 500);
    fs.utimesSync(pl.files.pending, t - 100, t - 100);
    let p = await getJson(d, "/api/sessions");
    const key = it => `${it.ws}/${it.file}`;
    assert.deepEqual(p.plans.map(key), [
      "harbor-app/export-formats-plan.md",
      "services/orchard-api/shared-notebooks-plan.md",
      "atlas-notes/kế-hoạch.md",
      "harbor-app/sync-offline-plan.md",
      "inkwell/search-by-date-plan.md",
      "harbor-app/sync notes.md",
    ]);
    assert.deepEqual(p.plans.map(it => it.state), ["progress", "ready", "draft", "draft", "done", "doc"]);
    const ex = planOf(p, "harbor-app", "export-formats-plan.md");
    assert.deepEqual(ex.progress, { phasesDone: 2, phasesTotal: 5, acsMet: 9, acsTotal: 16, current: 3 });
    assert.deepEqual(ex.bar, [1, 1, 0.5, 0, 0]);
    assert.equal(ex.format, "loop-plan");
    assert.equal(ex.planReview.session, "review-plan-20261012-002");
    assert.equal(ex.reviewSession, null);
    assert.equal(ex.tracked, null); // the fixture root is not a git repo
    assert.match(ex.searchText, /csv and json export/);
    assert.equal(ex.changedAt, Math.floor(fs.statSync(pl.files.progress).mtimeMs / 1000));
    assert.equal(ex.fileSig, `${fs.statSync(pl.files.progress).size}:${fs.statSync(pl.files.progress).mtimeMs}`);
    const doc = planOf(p, "harbor-app", "sync notes.md");
    assert.deepEqual([doc.format, doc.title, doc.progress, doc.planReview, doc.tracked, doc.bar], ["markdown", "Notes on the sync protocol", null, null, null, null]);
    assert.match(doc.searchText, /merge by paragraph/);
    for (const it of p.plans) for (const k of ["ws", "wsName", "file", "format", "title", "state", "progress", "planReview", "reviewSession", "tracked", "searchText", "changedAt", "fileSig", "sig"]) assert.ok(k in it, `${key(it)}: ${k}`);

    // a running review-plan session whose PLAN_PATH reaches the plan through a symlinked parent
    fs.symlinkSync(pl.atlas, path.join(root, "atlas-link"));
    const elsewhere = path.join(root, "elsewhere");
    writePlan(elsewhere, "kế-hoạch.md", "# Not this one\n");
    reviewPlanOn(fx.workspaces.orchard, "review-plan-20261016-001", path.join(root, "atlas-link", ".cross-review", "plans", "kế-hoạch.md"));
    reviewPlanOn(fx.workspaces.orchard, "review-plan-20261016-002", path.join(elsewhere, ".cross-review", "plans", "kế-hoạch.md"));
    p = await getJson(d, "/api/sessions");
    let it = planOf(p, "atlas-notes", "kế-hoạch.md");
    assert.equal(it.state, "review");
    assert.deepEqual(it.reviewSession, { id: "review-plan-20261016-001", round: 1 });
    assert.equal(p.plans[1].file, "kế-hoạch.md", "review sorts with progress");
    // the session ends: the plan's own state again
    reviewPlanOn(fx.workspaces.orchard, "review-plan-20261016-001", path.join(root, "atlas-link", ".cross-review", "plans", "kế-hoạch.md"), { running: false, meta: "REVISE" });
    p = await getJson(d, "/api/sessions");
    it = planOf(p, "atlas-notes", "kế-hoạch.md");
    assert.deepEqual([it.state, it.reviewSession], ["draft", null]);
  } finally {
    await d.close();
  }
});

test("plans live: a ticked criterion, review rounds, a session's result and phase commits change sig", async () => {
  const { d, fx, pl } = await servePlans({ tickMs: 150, rescanMs: 300 });
  const harbor = fx.workspaces.harbor;
  git(harbor, "init", "-q");
  const s = sse(d.port, "/api/stream?view=list", bearer(d));
  const item = (e, file) => planOf(e.json, "harbor-app", file);
  try {
    let cur = item(await s.next(e => e.event === "sessions"), "export-formats-plan.md");
    // tick AC-3.3: progress, fileSig and sig all change on the next tick
    fs.writeFileSync(pl.files.progress, fs.readFileSync(pl.files.progress, "utf8").replace("- [ ] AC-3.3", "- [x] AC-3.3"));
    let next = item(await s.next(e => e.event === "sessions" && item(e, "export-formats-plan.md").progress.acsMet === 10, 2000), "export-formats-plan.md");
    assert.notEqual(next.fileSig, cur.fileSig);
    assert.notEqual(next.sig, cur.sig);
    cur = next;

    // the plan file stays the same from here on
    const draft = () => item({ json: s.events[s.events.length - 1].json }, "sync-offline-plan.md");
    const sigChange = async (file, pred) => {
      const before = item({ json: s.events[s.events.length - 1].json }, file);
      const ev = await s.next(e => e.event === "sessions" && item(e, file).sig !== before.sig && pred(item(e, file)), 3000);
      const after = item(ev, file);
      assert.equal(after.fileSig, before.fileSig, `${file}: the file did not change`);
      return after;
    };
    const syncPath = pl.files.draft;
    reviewPlanOn(harbor, "review-plan-20261016-003", syncPath);
    let it = await sigChange("sync-offline-plan.md", x => x.state === "review");
    assert.deepEqual(it.reviewSession, { id: "review-plan-20261016-003", round: 1 });
    reviewPlanOn(harbor, "review-plan-20261016-003", syncPath, { rounds: 2 });
    it = await sigChange("sync-offline-plan.md", x => x.reviewSession && x.reviewSession.round === 2);
    reviewPlanOn(harbor, "review-plan-20261016-003", syncPath, { rounds: 2, running: false, meta: "REVISE" });
    it = await sigChange("sync-offline-plan.md", x => x.state === "draft");
    assert.ok(draft());

    // a review-impl session named in the Progress Log changes its result
    implSession(harbor, "review-impl-20261013-004", false);
    await sigChange("export-formats-plan.md", () => true);
    implSession(harbor, "review-impl-20261013-004", true);
    await sigChange("export-formats-plan.md", () => true);

    // a commit whose subject is phase 1's planned message: its SHA after the rescan
    git(harbor, "commit", "-q", "--allow-empty", "-m", "feat(export): one row model behind CSV and JSON");
    const sha = git(harbor, "log", "-1", "--format=%h").stdout.trim();
    await sigChange("export-formats-plan.md", () => true);
    let detail = await getJson(d, planUrl("harbor-app", "export-formats-plan.md"));
    assert.equal(detail.phases[0].commit.sha, sha);
    assert.equal(detail.phases[1].commit.sha, null);
    git(harbor, "commit", "-q", "--allow-empty", "-m", "feat(export): one row model behind CSV and JSON");
    await sigChange("export-formats-plan.md", () => true);
    detail = await getJson(d, planUrl("harbor-app", "export-formats-plan.md"));
    assert.equal(detail.phases[0].commit.sha, null, "a subject in two commits has no SHA");
  } finally {
    s.close();
    await d.close();
  }
});

test("/api/plan: the plan, its real sessions, markdown documents, and 404 for anything outside the plans folder", async () => {
  const { d, fx, pl } = await servePlans();
  const harbor = fx.workspaces.harbor;
  const plans = path.join(harbor, ".cross-review", "plans");
  implSession(harbor, "review-impl-20261013-004", true);
  fs.symlinkSync(pl.files.draft, path.join(plans, "linked-plan.md"));
  fs.mkdirSync(path.join(plans, "folder.md"));
  fs.writeFileSync(path.join(harbor, ".cross-review", "x.md"), "# Outside\n");
  writePlan(harbor, "scratch.md", "Just a line, no headings.\n");
  try {
    const p = await getJson(d, "/api/sessions");
    const x = await getJson(d, planUrl("harbor-app", "export-formats-plan.md"));
    assert.equal(x.format, "loop-plan");
    assert.deepEqual([x.ws, x.wsName, x.file, x.path, x.tracked], ["harbor-app", "harbor-app", "export-formats-plan.md", pl.files.progress, null]);
    assert.equal(x.sig, planOf(p, "harbor-app", "export-formats-plan.md").sig);
    assert.equal(typeof x.changedAt, "number");
    assert.equal(x.title, "CSV and JSON export");
    assert.equal(x.phases.length, 5);
    assert.deepEqual(x.progress, { phasesDone: 2, phasesTotal: 5, acsMet: 9, acsTotal: 16, current: 3 });
    assert.equal(x.state, "progress");
    assert.equal(x.reviewSession, null);
    assert.ok(x.sections.some(sec => sec.id === "phase-3") && x.log.length && x.planReview.verdict === "APPROVE");
    // review-plan-20261012-002 is named in the plan but has no session here
    assert.deepEqual(x.sessions, [{ id: "review-impl-20261013-004", skill: "review-impl", state: "approve", verdict: "APPROVE", href: "#/s/harbor-app/review-impl-20261013-004" }]);

    for (const [ws, file] of [["atlas-notes", "kế-hoạch.md"], ["harbor-app", "sync notes.md"]]) assert.equal((await request(d.port, planUrl(ws, file), { headers: bearer(d) })).status, 200, file);
    const doc = await getJson(d, planUrl("harbor-app", "sync notes.md"));
    assert.equal(doc.format, "markdown");
    assert.equal(doc.title, "Notes on the sync protocol");
    assert.deepEqual(doc.sections.map(sec => sec.title), [null, "Options"]);
    for (const k of ["phases", "progress", "log", "planReview"]) assert.equal(k in doc, false, k);
    const one = await getJson(d, planUrl("harbor-app", "scratch.md"));
    assert.equal(one.sections.length, 1);
    assert.equal(one.title, "scratch.md");

    for (const [ws, file] of [["nowhere", "export-formats-plan.md"], ["harbor-app", "../x.md"], ["harbor-app", "a/b.md"], ["harbor-app", "%2e%2e%2fx.md"], ["harbor-app", "linked-plan.md"], ["harbor-app", "folder.md"], ["harbor-app", "missing-plan.md"]]) {
      assert.equal((await request(d.port, planUrl(ws, file), { headers: bearer(d) })).status, 404, `${ws} ${file}`);
    }
    assert.equal((await request(d.port, "/api/plan?ws=harbor-app", { headers: bearer(d) })).status, 400);
    assert.equal((await request(d.port, "/api/plan?file=x.md", { headers: bearer(d) })).status, 400);
  } finally {
    await d.close();
  }
});

test("/api/plan: a checkpoint session's verdict is the one its sessions row shows, even before anyone polled it", async () => {
  const { d, fx } = await servePlans();
  const url = planUrl("services/orchard-api", "result-plan.md");
  try {
    writePlan(fx.workspaces.orchard, "result-plan.md", `${PLANS.ready}\n## Progress Log\n- 2026-10-16 Phase 1 checkpoint: review-impl-20261015-009\n`);
    // the reviewer finished and nobody polled: only its event log has the verdict
    let x = await getJson(d, url);
    assert.deepEqual(x.sessions.map(s => [s.id, s.verdict]), [["review-impl-20261015-009", "APPROVE"]]);
    // the runner's own result arrives later and disagrees: the page and its sig follow it
    fs.writeFileSync(path.join(fx.sessions.deadPid, "final.txt"), JSON.stringify({ status: "completed", round: 1, review: { verdict: { status: "REVISE" } } }));
    const before = x.sig;
    x = await getJson(d, url);
    assert.equal(x.sessions[0].verdict, "REVISE");
    assert.notEqual(x.sig, before);
  } finally {
    await d.close();
  }
});

test("settings keep each workspace's .gitignore in step with Plans in git; custom files and parent rules are reported", async () => {
  const { d, fx, pl } = await servePlans({ catalog: CATALOG });
  const gi = ws => path.join(ws, ".cross-review", ".gitignore");
  const read = ws => (fs.existsSync(gi(ws)) ? fs.readFileSync(gi(ws), "utf8") : null);
  const post = body => request(d.port, "/api/settings", { method: "POST", headers: { ...originOf(d), "Content-Type": "application/json" }, body });
  const { harbor, orchard, inkwell } = fx.workspaces;
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  try {
    for (const ws of [harbor, orchard, inkwell, pl.atlas]) fs.writeFileSync(gi(ws), "*\n");
    let r = await post({ scope: "workspace", ws: "harbor-app", config: { track_plans: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(r.text).gitignore, { "harbor-app": { result: "updated", blocked_by: null, warning: null } });
    assert.equal(read(harbor), GITIGNORE.track);
    assert.equal(read(inkwell), "*\n");

    // global on: every workspace without its own value; harbor set to false stays ignored
    assert.equal((await post({ scope: "workspace", ws: "harbor-app", config: { track_plans: false } })).status, 200);
    assert.equal(read(harbor), GITIGNORE.ignore);
    fs.writeFileSync(gi(orchard), "custom\n");
    git(inkwell, "init", "-q");
    fs.writeFileSync(path.join(inkwell, ".gitignore"), ".cross-review/\n");
    const atlasDir = path.join(pl.atlas, ".cross-review");
    const canLock = process.getuid && process.getuid() !== 0;
    if (canLock) fs.chmodSync(atlasDir, 0o500);
    try {
      r = await post({ scope: "global", config: { track_plans: true } });
    } finally {
      if (canLock) fs.chmodSync(atlasDir, 0o755);
    }
    assert.equal(r.status, 200, r.text);
    const out = JSON.parse(r.text).gitignore;
    assert.deepEqual(out["harbor-app"], { result: "unchanged", blocked_by: null, warning: null });
    assert.deepEqual(out["services/orchard-api"], { result: "custom", blocked_by: null, warning: null });
    assert.deepEqual(out.inkwell, {
      result: "updated", blocked_by: ".gitignore:1:.cross-review/",
      warning: "Plans in git is on, but .gitignore:1:.cross-review/ ignores new plans in .cross-review/plans/. Change it to .cross-review/* and add !.cross-review/plans/.",
    });
    if (canLock) assert.equal(out["atlas-notes"].result, "error");
    assert.equal(read(harbor), GITIGNORE.ignore);
    assert.equal(read(orchard), "custom\n");
    assert.equal(read(inkwell), GITIGNORE.track);
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { track_plans: true });
    // what git says, not the setting: the parent rule still ignores the plan
    assert.equal(git(inkwell, "check-ignore", "-q", ".cross-review/plans/search-by-date-plan.md").status, 0);
    const p = await getJson(d, "/api/sessions");
    assert.equal(planOf(p, "inkwell", "search-by-date-plan.md").tracked, false);
  } finally {
    fs.rmSync(globalFile, { force: true });
    await d.close();
  }
});
