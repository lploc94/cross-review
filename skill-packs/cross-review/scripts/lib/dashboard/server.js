// Local dashboard server: one page and a small JSON/SSE API over node:http, bound to
// 127.0.0.1 and guarded by a per-run token, a Host check and an Origin check on writes.
// It only reads session files; the one thing it writes is ~/.cross-review/dashboard.json.
//
//   startDashboard({root, port, open, idleExitSeconds}) → {url, port, token, root, close(), closed}
//   runDashboardCli(argv) → exit code (the `dashboard` command)

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { classify, readSession } from "./model.js";
import { findWorkspaces, isWorkspace, listSessions, sessionsDir, SCAN_DEPTH, SESSION_ID_RE } from "./scan.js";
import { discoveryFile, removeDiscoveryIfOwn, writeDiscovery } from "./discovery.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, "ui");
const MANIFEST = path.resolve(HERE, "..", "..", "..", "manifest.json");

export const PORT_MIN = 20000;
export const PORT_MAX = 30000;
export const PORT_TRIES = 50;
const PING_MS = 15000;
const REQUEST_SCAN_AGE_MS = 5000;
const COOKIE = "cr_token";

// The only files the server hands out; a request path is a key here or a 404
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/icons.js": ["icons.js", "text/javascript; charset=utf-8"],
  "/LICENSE-lucide.txt": ["LICENSE-lucide.txt", "text/plain; charset=utf-8"],
};
for (const who of ["reviewer", "agent", "you"]) {
  for (const size of ["", "-full"]) STATIC[`/avatars/${who}${size}.png`] = [`avatars/${who}${size}.png`, "image/png"];
}

const CSP = "default-src 'self'; img-src 'self' data:";
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer" };

function packVersion() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function tildePath(p) {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Stat of every file the session's parse depends on; equal strings mean nothing changed. */
function signature(dir) {
  const parts = [];
  for (const sub of ["", "inputs", "outputs", "prompts"]) {
    let names;
    try {
      names = fs.readdirSync(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      try {
        const s = fs.statSync(path.join(dir, sub, name));
        if (s.isFile()) parts.push(`${sub}/${name}:${s.size}:${s.mtimeMs}`);
      } catch {}
    }
  }
  return parts.join("|");
}

// ---------- the live list ----------

/**
 * Sessions of every followed workspace, grouped and sorted. Each tick re-reads the session
 * folders, re-parses a session only when its files changed, and re-classifies everything
 * with now(), since warn, "no reply" and the 24-hour window change with the clock alone.
 * Subscribers get the full list on subscribe and again whenever it differs from what they
 * were last sent.
 */
export function createListWatcher({ root, now = () => Math.floor(Date.now() / 1000), rescanMs = 10000, tickMs = 1000, isAlive = pidAlive, depth = SCAN_DEPTH } = {}) {
  const realRoot = fs.realpathSync(root);
  const version = packVersion();
  const scanned = new Map(); // ws key → absolute path
  const registered = new Map();
  const cache = new Map(); // session dir → { sig, parsed }
  const subs = new Set();
  let lastScan = 0;
  let timer = null;

  function wsKey(abs) {
    const rel = path.relative(realRoot, abs);
    if (!rel) return ".";
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return abs;
    return rel.split(path.sep).join("/");
  }

  function rescan() {
    scanned.clear();
    for (const ws of findWorkspaces(realRoot, depth)) scanned.set(wsKey(ws), ws);
    lastScan = Date.now();
  }

  function workspaces() {
    if (!lastScan) rescan();
    const all = new Map(scanned);
    for (const [k, v] of registered) if (!all.has(k)) all.set(k, v);
    return all;
  }

  function parsedFor(dir) {
    const sig = signature(dir);
    const hit = cache.get(dir);
    if (hit && hit.sig === sig) return hit.parsed;
    let parsed = null;
    try {
      parsed = readSession(dir);
    } catch {}
    cache.set(dir, { sig, parsed });
    return parsed;
  }

  function build() {
    const t = now();
    const wsMap = workspaces();
    const names = new Map();
    for (const abs of wsMap.values()) names.set(path.basename(abs), (names.get(path.basename(abs)) || 0) + 1);
    const list = [];
    const active = [];
    const history = [];
    const seen = new Set();
    for (const [ws, abs] of wsMap) {
      const name = names.get(path.basename(abs)) > 1 ? ws : path.basename(abs);
      list.push({ ws, name, path: abs });
      for (const dir of listSessions(abs)) {
        seen.add(dir);
        const parsed = parsedFor(dir);
        if (!parsed) continue;
        let summary;
        try {
          ({ summary } = classify(parsed, { now: t, isAlive }));
        } catch {
          continue;
        }
        (summary.group === "active" ? active : history).push({ ...summary, ws, wsName: name });
      }
    }
    for (const dir of cache.keys()) if (!seen.has(dir)) cache.delete(dir);
    const byId = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    active.sort((a, b) => (b.since || 0) - (a.since || 0) || byId(a, b));
    history.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || byId(a, b));
    list.sort((a, b) => a.ws.localeCompare(b.ws));
    return { root: realRoot, rootDisplay: tildePath(realRoot), depth, version, workspaces: list, active, history };
  }

  function send(sub, payload, json) {
    if (sub.last === json) return;
    sub.last = json;
    try {
      sub.fn({ ...payload, serverTime: now() });
    } catch {}
  }

  function tick() {
    if (Date.now() - lastScan >= rescanMs) rescan();
    const payload = build();
    const json = JSON.stringify(payload);
    for (const sub of subs) send(sub, payload, json);
  }

  return {
    root: realRoot,
    /** The current list; rescans the tree when the last scan is older than maxScanAgeMs. */
    snapshot({ maxScanAgeMs = REQUEST_SCAN_AGE_MS } = {}) {
      if (Date.now() - lastScan > maxScanAgeMs) rescan();
      return { ...build(), serverTime: now() };
    },
    subscribe(fn) {
      const sub = { fn, last: null };
      subs.add(sub);
      const payload = build();
      send(sub, payload, JSON.stringify(payload));
      if (!timer) timer = setInterval(tick, tickMs);
      return () => {
        subs.delete(sub);
        if (!subs.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    /** Follow a workspace outside the scan; returns its key. Throws when it has no sessions folder. */
    addWorkspace(p) {
      if (typeof p !== "string" || !path.isAbsolute(p)) throw new Error("path must be absolute");
      let abs;
      try {
        abs = fs.realpathSync(p);
      } catch {
        throw new Error("no such folder");
      }
      if (!isWorkspace(abs)) throw new Error("the folder has no .cross-review/sessions");
      const key = wsKey(abs);
      registered.set(key, abs);
      return key;
    },
    /** Session dir for (ws, id), or null when either is unknown. */
    resolve(ws, id) {
      if (typeof id !== "string" || !SESSION_ID_RE.test(id) || typeof ws !== "string") return null;
      let abs = workspaces().get(ws);
      if (!abs && Date.now() - lastScan > REQUEST_SCAN_AGE_MS) {
        rescan();
        abs = workspaces().get(ws);
      }
      if (!abs) return null;
      // Only what the list shows: a real folder in the sessions dir, never a symlink
      const dir = path.join(sessionsDir(abs), id);
      return listSessions(abs).includes(dir) && fs.existsSync(path.join(dir, "state.json")) ? dir : null;
    },
    parsedFor,
    now,
    isAlive,
    close() {
      subs.clear();
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ---------- ports ----------

const randomPort = () => crypto.randomInt(PORT_MIN, PORT_MAX + 1);

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = e => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** An exact port when given; otherwise random ports in [PORT_MIN, PORT_MAX] until one is free. */
async function listenOnFreePort(server, { port, pickPort, host }) {
  if (port !== undefined && port !== null) return listenOnce(server, port, host);
  for (let i = 0; i < PORT_TRIES; i++) {
    try {
      return await listenOnce(server, pickPort(), host);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`No free port between ${PORT_MIN} and ${PORT_MAX} after ${PORT_TRIES} tries; pass --port <n>.`);
}

// ---------- browser ----------

export function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// ---------- the 401 page ----------

const DENIED_CSS = "body{margin:0;background:#f8f7f3;color:#1c1b19;font:15px/1.55 -apple-system,BlinkMacSystemFont,\"Helvetica Neue\",Helvetica,Arial,sans-serif}"
  + "main{max-width:520px;margin:12vh auto;padding:0 24px;text-align:center}"
  + "img{height:220px;display:block;margin:0 auto 18px}"
  + "h1{font:600 22px \"Iowan Old Style\",\"Palatino Linotype\",Palatino,Georgia,serif;margin:0 0 8px}p{color:#4a4843;margin:0}";
const DENIED_CSP = `default-src 'none'; img-src data:; style-src 'sha256-${crypto.createHash("sha256").update(DENIED_CSS).digest("base64")}'`;
let deniedPage = null;
function deniedHtml() {
  if (deniedPage) return deniedPage;
  let img = "";
  try {
    img = `<img src="data:image/png;base64,${fs.readFileSync(path.join(UI_DIR, "avatars", "reviewer-full.png")).toString("base64")}" alt="">`;
  } catch {}
  deniedPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cross-review</title><style>${DENIED_CSS}</style></head>`
    + `<body><main>${img}<h1>This page needs its link</h1><p>Open the dashboard from the link printed in the terminal.</p></main></body></html>`;
  return deniedPage;
}

// ---------- server ----------

/**
 * Start the dashboard. Options besides the documented four are for tests: pickPort,
 * discoveryFile (null: none), now, tickMs, rescanMs, isAlive.
 */
export async function startDashboard({
  root = process.cwd(), port = null, open = false, idleExitSeconds = null,
  pickPort = randomPort, discoveryFile: discFile = discoveryFile(), host = "127.0.0.1",
  now, tickMs, rescanMs, isAlive,
} = {}) {
  const watcher = createListWatcher({ root, now, tickMs, rescanMs, isAlive });
  const token = crypto.randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);
  const streams = new Set();
  let idleSince = Date.now();
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const tokenOk = candidate => {
    if (typeof candidate !== "string") return false;
    const b = Buffer.from(candidate);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };
  const bearerOk = req => {
    const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/);
    return Boolean(m && tokenOk(m[1]));
  };
  const cookieOk = req => String(req.headers.cookie || "").split(";").some(part => {
    const [k, ...v] = part.trim().split("=");
    return k === COOKIE && tokenOk(v.join("="));
  });

  const send = (res, status, body, type, extra = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8", { "Cache-Control": "no-store" });
  const fail = (res, status, message) => json(res, status, { error: message });
  const denied = (req, res) => {
    if (String(req.headers.accept || "").includes("text/html")) {
      res.writeHead(401, { ...BASE_HEADERS, "Content-Security-Policy": DENIED_CSP, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(deniedHtml());
    } else {
      send(res, 401, "Open the dashboard from the link printed in the terminal.\n", "text/plain; charset=utf-8", { "Cache-Control": "no-store" });
    }
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function serveStatic(res, file, type) {
    fs.readFile(path.join(UI_DIR, file), (err, data) => {
      if (err) return fail(res, 404, "not found");
      send(res, 200, data, type, { "Cache-Control": "no-cache" });
    });
  }

  function stream(req, res, url) {
    if (url.searchParams.get("view") !== "list") return fail(res, 400, "unknown view");
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const entry = { res };
    streams.add(entry);
    const unsubscribe = watcher.subscribe(payload => res.write(`event: sessions\ndata: ${JSON.stringify(payload)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(entry);
      if (!streams.size) idleSince = Date.now();
    });
  }

  async function handle(req, res) {
    if (!allowedHosts.has(String(req.headers.host || ""))) return send(res, 403, "Forbidden host.\n", "text/plain; charset=utf-8");
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return fail(res, 400, "bad request");
    }
    // The printed link: trade the token in the URL for a cookie, then drop it from the address bar
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("t")) {
      if (!tokenOk(url.searchParams.get("t"))) return denied(req, res);
      res.writeHead(303, { ...BASE_HEADERS, "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    const viaBearer = bearerOk(req);
    if (!viaBearer && !cookieOk(req)) return denied(req, res);

    const route = url.pathname;
    if (req.method === "POST") {
      if (!viaBearer && !allowedOrigins.has(String(req.headers.origin || ""))) return fail(res, 403, "cross-origin request");
      if (route === "/api/workspaces") {
        let body;
        try {
          body = JSON.parse((await readBody(req)).toString("utf8"));
        } catch {
          return fail(res, 400, "body must be JSON");
        }
        try {
          return json(res, 200, { ws: watcher.addWorkspace(body && body.path) });
        } catch (e) {
          return fail(res, 400, e.message);
        }
      }
      return fail(res, 404, "not found");
    }
    if (req.method !== "GET") return fail(res, 405, "method not allowed");

    if (STATIC[route]) return serveStatic(res, ...STATIC[route]);
    switch (route) {
      case "/api/health":
        return json(res, 200, { ok: true, root: watcher.root, pid: process.pid });
      case "/api/overview": {
        const p = watcher.snapshot();
        return json(res, 200, { root: p.root, rootDisplay: p.rootDisplay, depth: p.depth, version: p.version, workspaces: p.workspaces });
      }
      case "/api/sessions":
        return json(res, 200, watcher.snapshot());
      case "/api/session": {
        const ws = url.searchParams.get("ws");
        const dir = watcher.resolve(ws, url.searchParams.get("id"));
        const parsed = dir && watcher.parsedFor(dir);
        if (!parsed) return fail(res, 404, "no such session");
        const { detail } = classify(parsed, { now: watcher.now(), isAlive: watcher.isAlive });
        return json(res, 200, { ...detail, ws, serverTime: watcher.now() });
      }
      case "/api/stream":
        return stream(req, res, url);
      default:
        return fail(res, 404, "not found");
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) fail(res, 500, "internal error");
      else res.end();
    });
  });
  try {
    port = await listenOnFreePort(server, { port, pickPort, host });
  } catch (e) {
    watcher.close();
    throw e;
  }
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  let resolveClosed;
  const closed = new Promise(r => { resolveClosed = r; });
  let idleTimer = null;
  let closing = null;
  function close() {
    if (closing) return closing;
    if (idleTimer) clearInterval(idleTimer);
    watcher.close();
    if (discFile) removeDiscoveryIfOwn(process.pid, { file: discFile, token });
    closing = new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }).then(() => resolveClosed());
    return closing;
  }

  if (discFile) writeDiscovery({ pid: process.pid, port, token, root: watcher.root, started_at: Math.floor(Date.now() / 1000) }, discFile);
  if (idleExitSeconds) {
    idleTimer = setInterval(() => {
      if (!streams.size && Date.now() - idleSince >= idleExitSeconds * 1000) close();
    }, 250);
  }
  if (open) openBrowser(url);
  return { url, port, token, root: watcher.root, close, closed };
}

// ---------- the `dashboard` command ----------

const USAGE = "Usage: dashboard [--root <dir>] [--port <n>] [--no-open] [--idle-exit <seconds>]\n";

export async function runDashboardCli(argv, { out = process.stdout, err = process.stderr } = {}) {
  let root = process.cwd();
  let port = null;
  let open = true;
  let idleExitSeconds = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i];
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--no-open") open = false;
    else if (a === "--idle-exit") idleExitSeconds = Number(argv[++i]);
    else {
      err.write(`cross-review dashboard: unknown argument ${a}\n${USAGE}`);
      return 1;
    }
  }
  if (typeof root !== "string" || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    err.write(`cross-review dashboard: --root is not a folder: ${root}\n`);
    return 1;
  }
  if (port !== null && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    err.write(`cross-review dashboard: --port must be a port number\n${USAGE}`);
    return 1;
  }
  if (idleExitSeconds !== null && !(idleExitSeconds > 0)) {
    err.write(`cross-review dashboard: --idle-exit must be a number of seconds\n${USAGE}`);
    return 1;
  }
  let d;
  try {
    d = await startDashboard({ root: path.resolve(root), port, open, idleExitSeconds });
  } catch (e) {
    err.write(`cross-review dashboard: ${e.message}\n`);
    return 1;
  }
  out.write(`cross-review dashboard: ${d.url}  (scanning ${d.root}, ${SCAN_DEPTH} levels down)\n`);
  const stop = () => d.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await d.closed;
  return 0;
}
