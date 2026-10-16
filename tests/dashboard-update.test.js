// Check for updates: the version check behind the footer note and Settings' "Check for updates".
// Every dashboard here uses an invented version source; one test reads a local HTTP server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../skill-packs/cross-review/scripts/lib/config.js";
import { startDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";
import { fetchLatestVersion, isNewer, UPDATE_TTL_S } from "../skill-packs/cross-review/scripts/lib/dashboard/update.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLED = JSON.parse(fs.readFileSync(path.join(REPO, "skill-packs", "cross-review", "manifest.json"), "utf8")).version;
const CATALOG = { listModels: async () => null, defaultModel: () => null, cliInfo: async () => null };

let tmp;
const savedHome = process.env.HOME;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-update-")));
  // Settings live under HOME: never the real one
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const mk = name => fs.mkdirSync(path.join(tmp, `${name}-${++n}`), { recursive: true });
const globalFile = () => path.join(process.env.HOME, ".cross-review", "config.json");
const setGlobal = obj => {
  fs.mkdirSync(path.dirname(globalFile()), { recursive: true });
  fs.writeFileSync(globalFile(), JSON.stringify(obj));
};
const nowS = () => Math.floor(Date.now() / 1000);

/** A version source that answers from `answers` in turn (an Error is thrown); `calls` counts asks. */
function source(...answers) {
  const s = async () => {
    const a = answers[Math.min(s.calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  s.calls = 0;
  return s;
}

async function serve(opts) {
  const root = mk("root");
  fs.mkdirSync(path.join(root, ".cross-review", "sessions"), { recursive: true });
  const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: CATALOG, ...opts });
  const call = async (p, method = "GET", body) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${p}`, { method, headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(r.status, 200, `${p}: ${await r.clone().text()}`);
    return r.json();
  };
  return { d, call, root };
}

test("isNewer: compares x.y.z part by part; anything else is not newer", () => {
  assert.equal(isNewer("10.3.0", "10.2.9"), true);
  assert.equal(isNewer("10.10.0", "10.9.0"), true);
  assert.equal(isNewer("11.0.0", "10.99.99"), true);
  assert.equal(isNewer("10.2.0", "10.2.0"), false);
  assert.equal(isNewer("10.1.9", "10.2.0"), false);
  assert.equal(isNewer("10.3", "10.2.0"), false);
  assert.equal(isNewer(null, "10.2.0"), false);
});

test("check_updates: a config key that must be true or false", () => {
  assert.deepEqual(validateConfig({ check_updates: true }), []);
  assert.deepEqual(validateConfig({ check_updates: "yes" }), ["check_updates: must be true or false"]);
});

test("fetchLatestVersion: the manifest's version; a bad answer throws a short reason", async () => {
  const answers = { "/ok": [200, JSON.stringify({ name: "cross-review", version: "10.9.1" })], "/missing": [404, "Not Found"], "/odd": [200, JSON.stringify({ version: "latest" })] };
  const server = http.createServer((req, res) => {
    const [status, body] = answers[req.url];
    res.writeHead(status, { "Content-Type": "application/json" }).end(body);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await fetchLatestVersion({ url: `${base}/ok` }), "10.9.1");
    await assert.rejects(fetchLatestVersion({ url: `${base}/missing` }), /GitHub answered 404/);
    await assert.rejects(fetchLatestVersion({ url: `${base}/odd` }), /no version/);
    await assert.rejects(fetchLatestVersion({ url: "http://127.0.0.1:1/none" }), /could not be reached/);
  } finally {
    server.close();
  }
});

test("updates off: nothing is asked at start; Check now asks, keeps the answer on disk, and reports a newer version", async () => {
  fs.rmSync(globalFile(), { force: true });
  const cache = path.join(mk("cache"), "update.json");
  const latestVersion = source("99.0.0");
  const { d, call } = await serve({ latestVersion, updateCache: cache });
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.equal(latestVersion.calls, 0);
    assert.deepEqual(await call("/api/update"), { current: INSTALLED, latest: null, available: false, checked_at: null, error: null, checking: false, auto: false });
    const u = await call("/api/update/check", "POST", {});
    assert.equal(latestVersion.calls, 1);
    assert.equal(u.latest, "99.0.0");
    assert.equal(u.available, true);
    assert.ok(u.checked_at >= nowS() - 5);
    assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")), { latest: "99.0.0", error: null, checked_at: u.checked_at });
  } finally {
    await d.close();
  }
});

test("updates on: a missing, stale or failed answer is checked at start, a fresh one is not; a failed check keeps the last version", async () => {
  setGlobal({ check_updates: true });
  const cache = path.join(mk("cache"), "update.json");
  try {
    // no answer yet
    let latestVersion = source("99.0.0");
    let { d, call } = await serve({ latestVersion, updateCache: cache });
    let u = await call("/api/update?wait=1");
    await d.close();
    assert.equal(latestVersion.calls, 1);
    assert.deepEqual([u.latest, u.available, u.auto, u.checking], ["99.0.0", true, true, false]);

    // a day-old answer is fresh
    fs.writeFileSync(cache, JSON.stringify({ latest: "1.0.0", checked_at: nowS() - 24 * 3600, error: null }));
    latestVersion = source("99.0.0");
    ({ d, call } = await serve({ latestVersion, updateCache: cache }));
    u = await call("/api/update?wait=1");
    await d.close();
    assert.equal(latestVersion.calls, 0);
    assert.deepEqual([u.latest, u.available], ["1.0.0", false]);

    // past the few days: asked again, and the failure keeps the version found before
    fs.writeFileSync(cache, JSON.stringify({ latest: "1.0.0", checked_at: nowS() - UPDATE_TTL_S - 60, error: null }));
    latestVersion = source(new Error("GitHub could not be reached"));
    ({ d, call } = await serve({ latestVersion, updateCache: cache }));
    u = await call("/api/update?wait=1");
    await d.close();
    assert.equal(latestVersion.calls, 1);
    assert.deepEqual([u.latest, u.error], ["1.0.0", "GitHub could not be reached"]);

    // a failed answer is asked again at the next start
    latestVersion = source("99.0.0");
    ({ d, call } = await serve({ latestVersion, updateCache: cache }));
    u = await call("/api/update?wait=1");
    await d.close();
    assert.equal(latestVersion.calls, 1);
    assert.deepEqual([u.latest, u.error, u.available], ["99.0.0", null, true]);
  } finally {
    fs.rmSync(globalFile(), { force: true });
  }
});

test("updates: turning Check for updates on in Settings checks at once; a workspace cannot turn it on", async () => {
  fs.rmSync(globalFile(), { force: true });
  const cache = path.join(mk("cache"), "update.json");
  const latestVersion = source("99.0.0");
  const { d, call, root } = await serve({ latestVersion, updateCache: cache });
  try {
    // the setting is read from the global file only
    await call("/api/settings", "POST", { scope: "workspace", ws: ".", config: { check_updates: true }, touched: ["check_updates"] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".cross-review", "config.json"), "utf8")), { check_updates: true });
    assert.equal((await call("/api/update?wait=1")).auto, false);
    assert.equal(latestVersion.calls, 0);
    await call("/api/settings", "POST", { scope: "global", config: { check_updates: true }, touched: ["check_updates"] });
    const u = await call("/api/update?wait=1");
    assert.equal(latestVersion.calls, 1);
    assert.deepEqual([u.auto, u.available], [true, true]);
    assert.deepEqual(JSON.parse(fs.readFileSync(globalFile(), "utf8")), { check_updates: true });
  } finally {
    fs.rmSync(globalFile(), { force: true });
    await d.close();
  }
});
