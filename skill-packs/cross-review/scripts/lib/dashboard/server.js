// Local dashboard server: one page and a small JSON/SSE API over node:http, bound to
// 127.0.0.1 and guarded by a per-run token, a Host check and an Origin check on writes.
// It only reads session and plan files (its git commands are read-only); it writes
// ~/.cross-review/dashboard.json, the settings (~/.cross-review/config.json,
// <workspace>/.cross-review/config.json), <workspace>/.cross-review/.gitignore when Plans in git
// is saved, and the avatars in ~/.cross-review/avatars/.
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

import { classify, inputValues, readSession, roundActivity } from "./model.js";
import { findWorkspaces, isWorkspace, listSessions, sessionsDir, SCAN_DEPTH, SESSION_ID_RE } from "./scan.js";
import { discoveryFile, removeDiscoveryIfOwn, writeDiscovery } from "./discovery.js";
import { AvatarError, avatarFile, listAvatars, removeAvatar, saveAvatar, AVATAR_MAX_BYTES } from "./avatars.js";
import { ensureCrossReviewDir, globalConfigPath, readConfig, resolvePlanSettings, syncGitignore, validateConfig, workspaceConfigPath, writeConfig } from "../config.js";
import { fillCommits, gitPlanFacts, listPlans, parsePlan, planProgress, planState, plansDir, summarizePlanText } from "../plans.js";
import { getReviewer } from "../reviewers/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, "ui");
const MANIFEST = path.resolve(HERE, "..", "..", "..", "manifest.json");

export const PORT_MIN = 20000;
export const PORT_MAX = 30000;
export const PORT_TRIES = 50;
const PING_MS = 15000;
const REQUEST_SCAN_AGE_MS = 5000;
const ACTIVITY_PAGE = 20;
const SETTINGS_BODY_MAX = 64 * 1024;
const COOKIE = "cr_token";

// The only files the server hands out; a request path is a key here or a 404
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/icons.js": ["icons.js", "text/javascript; charset=utf-8"],
  "/feed.js": ["feed.js", "text/javascript; charset=utf-8"],
  "/settings.js": ["settings.js", "text/javascript; charset=utf-8"],
  "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
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

/** Stat of every file the session's parse depends on, one string per file. */
function signatureParts(dir) {
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
  return parts;
}

/** Equal strings mean nothing the parse reads has changed. */
const signature = dir => signatureParts(dir).join("|");

// The reviewer's event log and its line times change with every activity item; the rest
// (state, rounds, final, meta, review, inputs, analysis) is what a `session` event is about
const ACTIVITY_FILE = /^(\/output\.jsonl|outputs\/(?:output|times)-round-\d+\.jsonl):/;
const sessionFiles = dir => signatureParts(dir).filter(p => !ACTIVITY_FILE.test(p)).join("|");

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
  const planCache = new Map(); // plan file → { fileSig, changedAt, parsed, summary }
  const gitCache = new Map(); // workspace path → { key, scan, facts }
  const subs = new Set();
  let planIndex = new Map(); // `${ws}\0${file}` → what /api/plan needs, from the last build
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

  /** The plan's parsed text, re-read only when its size or mtime changed; null when unreadable. */
  function planFor(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      planCache.delete(file);
      return null;
    }
    const fileSig = `${st.size}:${st.mtimeMs}`;
    const hit = planCache.get(file);
    if (hit && hit.fileSig === fileSig) return hit;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      planCache.delete(file);
      return null;
    }
    const entry = { fileSig, changedAt: Math.floor(st.mtimeMs / 1000), parsed: parsePlan(text), summary: summarizePlanText(path.dirname(path.dirname(path.dirname(file))), path.basename(file), text) };
    planCache.set(file, entry);
    return entry;
  }

  /** Git facts of a workspace's plans: again on each rescan, when its plan files change, or after a settings save. */
  function gitFor(abs, files, entries) {
    const key = files.map((f, i) => `${f}:${entries[i] ? entries[i].fileSig : "-"}`).join("|");
    const hit = gitCache.get(abs);
    if (hit && hit.key === key && hit.scan === lastScan) return hit.facts;
    const facts = gitPlanFacts(abs, files);
    gitCache.set(abs, { key, scan: lastScan, facts });
    return facts;
  }

  /** realpath of each plan an active review-plan session works on → { id, round, status }. */
  function plansUnderReview(sessions) {
    const out = new Map();
    for (const { parsed, summary, abs } of sessions) {
      if (parsed.skill !== "review-plan" || summary.group !== "active") continue;
      const v = inputValues(parsed.rounds[0] && parsed.rounds[0].input, parsed.skill, parsed.state.skills_dir);
      if (!v.PLAN_PATH) continue;
      let real;
      try {
        real = fs.realpathSync(path.resolve(parsed.state.working_dir || abs, String(v.PLAN_PATH).trim()));
      } catch {
        continue;
      }
      const had = out.get(real);
      if (!had || (summary.since || 0) > had.since) out.set(real, { id: summary.id, round: summary.round, status: summary.state, since: summary.since || 0 });
    }
    return out;
  }

  const PLAN_ORDER = { progress: 0, review: 0, ready: 1, draft: 2, done: 3, doc: 4 };

  function buildPlans(wsMap, names, sessionsByWs) {
    const all = [...sessionsByWs.values()].flatMap(m => [...m.values()]);
    const reviewing = plansUnderReview(all);
    const plans = [];
    const index = new Map();
    const seen = new Set();
    for (const [ws, abs] of wsMap) {
      const files = listPlans(abs);
      if (!files.length) {
        gitCache.delete(abs);
        continue;
      }
      const entries = files.map(f => planFor(path.join(plansDir(abs), f)));
      const facts = gitFor(abs, files, entries);
      const here = sessionsByWs.get(ws) || new Map();
      files.forEach((file, i) => {
        const entry = entries[i];
        if (!entry) return;
        const full = path.join(plansDir(abs), file);
        seen.add(full);
        const tracked = facts.repo ? !facts.ignored.has(file) : null;
        const isPlan = entry.summary.format === "loop-plan";
        let real = full;
        try {
          real = fs.realpathSync(full);
        } catch {}
        const review = isPlan ? reviewing.get(real) || null : null;
        const state = isPlan ? planState(entry.parsed, { reviewing: Boolean(review) }) : "doc";
        const reviewSession = review && state === "review" ? { id: review.id, round: review.round } : null;
        const filled = isPlan ? fillCommits(entry.parsed, facts) : null;
        const named = entry.parsed.sessionIds.filter(id => here.has(id)).map(id => here.get(id));
        // everything the plan page shows, so a review or a commit refreshes it with the file unchanged
        const sig = JSON.stringify([
          entry.fileSig, tracked, state,
          reviewSession ? `${review.id}:${review.round}:${review.status}` : null,
          named.map(x => `${x.summary.id}:${x.summary.label}:${x.summary.round}:${x.summary.verdict}`),
          filled ? filled.phases.map(p => p.commit.sha) : null,
        ]);
        const item = {
          ws, wsName: names(abs, ws), file, format: entry.summary.format, title: entry.summary.title, state,
          progress: entry.summary.progress, planReview: entry.summary.planReview, reviewSession, tracked,
          searchText: entry.summary.searchText, changedAt: entry.changedAt, fileSig: entry.fileSig, sig,
        };
        plans.push(item);
        index.set(`${ws}\0${file}`, { item, full, parsed: filled || entry.parsed, named });
      });
    }
    for (const file of planCache.keys()) if (!seen.has(file)) planCache.delete(file);
    plans.sort((a, b) => PLAN_ORDER[a.state] - PLAN_ORDER[b.state] || b.changedAt - a.changedAt || a.ws.localeCompare(b.ws) || a.file.localeCompare(b.file));
    planIndex = index;
    return plans;
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
    const sessionsByWs = new Map(); // ws → id → { parsed, summary, abs }
    const nameOf = (abs, ws) => (names.get(path.basename(abs)) > 1 ? ws : path.basename(abs));
    for (const [ws, abs] of wsMap) {
      const name = nameOf(abs, ws);
      list.push({ ws, name, path: abs });
      const here = new Map();
      sessionsByWs.set(ws, here);
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
        here.set(summary.id, { parsed, summary, abs });
      }
    }
    const plans = buildPlans(wsMap, nameOf, sessionsByWs);
    for (const dir of cache.keys()) if (!seen.has(dir)) cache.delete(dir);
    const byId = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    active.sort((a, b) => (b.since || 0) - (a.since || 0) || byId(a, b));
    history.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || byId(a, b));
    list.sort((a, b) => a.ws.localeCompare(b.ws));
    return { root: realRoot, rootDisplay: tildePath(realRoot), depth, version, workspaces: list, active, history, plans };
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
      if (!isWorkspace(abs)) throw new Error("the folder has no .cross-review/sessions or plans");
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
    /**
     * One plan for /api/plan, or null when the workspace is unknown or the file is not one of
     * its plans (listPlans: plain .md files of the plans folder, never a link or a folder).
     */
    plan(ws, file) {
      if (typeof ws !== "string" || typeof file !== "string") return null;
      let abs = workspaces().get(ws);
      if (!abs && Date.now() - lastScan > REQUEST_SCAN_AGE_MS) {
        rescan();
        abs = workspaces().get(ws);
      }
      if (!abs || !listPlans(abs).includes(file)) return null;
      build();
      const hit = planIndex.get(`${ws}\0${file}`);
      if (!hit) return null;
      const { item, full, parsed, named } = hit;
      const base = { format: item.format, ws, wsName: item.wsName, file, path: full, tracked: item.tracked, changedAt: item.changedAt, sig: item.sig };
      if (item.format !== "loop-plan") return { ...base, title: item.title, sections: parsed.sections };
      return {
        ...base, ...parsed, title: item.title, progress: planProgress(parsed), state: item.state, reviewSession: item.reviewSession,
        sessions: named.map(({ summary }) => ({ id: summary.id, skill: summary.skill, state: summary.state, verdict: summary.verdict, href: `#/s/${encodeURIComponent(ws)}/${summary.id}` })),
      };
    },
    /** Forget a workspace's git facts (after its .gitignore changed). */
    forgetGit(abs) {
      gitCache.delete(abs);
    },
    /** Absolute path of a workspace key, or null. */
    workspacePath(ws) {
      return (typeof ws === "string" && workspaces().get(ws)) || null;
    },
    /** Every followed workspace: key → absolute path. */
    workspaceMap: () => workspaces(),
    /** Display name of a workspace key: its folder name, or the key when two share it. */
    wsName(ws) {
      const all = workspaces();
      const abs = all.get(ws);
      if (!abs) return ws;
      const base = path.basename(abs);
      return [...all.values()].filter(p => path.basename(p) === base).length > 1 ? ws : base;
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

/**
 * Open `url` in the default browser. Resolves { ok } once the launcher exits (ok: exit 0),
 * { ok: false, error } when it cannot start or fails; a launcher still running after 5 s
 * counts as opened. Never rejects.
 */
export function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  return new Promise(resolve => {
    let timer = null;
    const done = r => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", e => done({ ok: false, error: e.message }));
      child.on("exit", code => done(code === 0 ? { ok: true } : { ok: false, error: `${cmd} exited with ${code}` }));
      child.unref();
      // the timer stays referenced: a caller that awaits this (CLI `begin`) must not exit
      // before the launcher answers; it is cleared as soon as it does
      timer = setTimeout(() => done({ ok: true }), 5000);
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}

/** Show a folder in the system's file manager. */
export function revealFolder(dir) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [dir]]
    : process.platform === "win32" ? ["explorer", [dir]]
      : ["xdg-open", [dir]];
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
 * discoveryFile (null: none), now, tickMs, rescanMs, isAlive, reveal, catalog
 * ({listModels, defaultModel, cliInfo}; default: the Codex adapter's).
 */
export async function startDashboard({
  root = process.cwd(), port = null, open = false, idleExitSeconds = null,
  pickPort = randomPort, discoveryFile: discFile = discoveryFile(), host = "127.0.0.1",
  now, tickMs = 1000, rescanMs, isAlive, reveal = revealFolder, catalog = getReviewer("codex"),
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

  /** The request body; rejects with status 413 past `limit` bytes. */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > limit) {
          req.pause();
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // ----- settings -----

  // The model catalog stays in memory; "refresh list" asks Codex again
  let catalogPromise = null;
  const models = refresh => {
    if (!catalogPromise || refresh) {
      catalogPromise = Promise.all([catalog.listModels(), catalog.cliInfo ? catalog.cliInfo() : null])
        .then(([list, info]) => ({ models: list, fetchedAt: Math.floor(Date.now() / 1000), reviewer: info }))
        .catch(() => ({ models: null, fetchedAt: Math.floor(Date.now() / 1000), reviewer: null }));
    }
    return catalogPromise;
  };

  async function settingsPayload() {
    // Keyed by workspace path: no prototype, so a workspace named __proto__ is a plain key
    const errors = { global: undefined, workspaces: Object.create(null) };
    const load = (file, onError) => {
      try {
        return readConfig(file);
      } catch (e) {
        onError(e.message);
        return {};
      }
    };
    const workspacesCfg = Object.create(null);
    const paths = Object.create(null);
    for (const [ws, abs] of watcher.workspaceMap()) {
      workspacesCfg[ws] = load(workspaceConfigPath(abs), m => { errors.workspaces[ws] = m; });
      paths[ws] = tildePath(workspaceConfigPath(abs));
    }
    const m = await models(false);
    let codexDefault = null;
    try {
      codexDefault = catalog.defaultModel();
    } catch {}
    return {
      global: load(globalConfigPath(), m => { errors.global = m; }),
      globalPath: tildePath(globalConfigPath()),
      workspaces: workspacesCfg,
      paths,
      names: Object.fromEntries([...watcher.workspaceMap().keys()].map(ws => [ws, watcher.wsName(ws)])),
      models: m.models,
      modelsFetchedAt: m.fetchedAt,
      codexDefault,
      reviewer: m.reviewer,
      errors,
    };
  }

  function saveSettings(res, body) {
    if (!body || typeof body !== "object") return fail(res, 400, "body must be a JSON object");
    let file;
    if (body.scope === "global") {
      file = globalConfigPath();
    } else if (body.scope === "workspace") {
      const abs = watcher.workspacePath(body.ws);
      if (!abs) return fail(res, 400, "unknown workspace");
      file = workspaceConfigPath(abs);
    } else {
      return fail(res, 400, "scope must be global or workspace");
    }
    const errors = validateConfig(body.config);
    if (errors.length) return fail(res, 400, errors.join("; "));
    if (body.scope === "workspace") ensureCrossReviewDir(watcher.workspacePath(body.ws));
    const config = writeConfig(file, body.config);
    // Plans in git: the saved level's workspaces get the .gitignore their resolved value asks for
    const targets = body.scope === "workspace" ? [[body.ws, watcher.workspacePath(body.ws)]] : [...watcher.workspaceMap()];
    const gitignore = Object.create(null);
    for (const [ws, abs] of targets) {
      let result;
      let track = false;
      try {
        track = resolvePlanSettings(abs).track_plans.value;
        result = syncGitignore(abs, track);
      } catch {
        result = "error";
      }
      watcher.forgetGit(abs);
      let blockedBy = null;
      if (track && result !== "error") {
        const facts = gitPlanFacts(abs, []);
        if (facts.repo && facts.newPlansIgnored) blockedBy = facts.blockedBy || "a .gitignore rule";
      }
      gitignore[ws] = { result, blocked_by: blockedBy };
    }
    return json(res, 200, { ok: true, config, gitignore });
  }

  // ----- avatars -----

  function avatarParties() {
    const p = watcher.snapshot();
    const callers = new Map();
    let without = 0;
    for (const s of [...p.active, ...p.history]) {
      if (!s.caller) {
        without++;
        continue;
      }
      const c = callers.get(s.caller.name) || { title: s.caller.title || s.caller.name, n: 0 };
      c.n++;
      callers.set(s.caller.name, c);
    }
    const seen = n => `${n} ${n === 1 ? "session" : "sessions"}`;
    const parties = [
      { key: "you", who: "us", label: "You", seenIn: "every session" },
      { key: "reviewer:codex", who: "rv", label: "Reviewer · Codex", seenIn: "every session" },
    ];
    for (const [name, c] of [...callers].sort((a, b) => b[1].n - a[1].n)) {
      const key = `agent:${name.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`;
      parties.push({ key, who: "ag", label: `Agent · ${c.title}`, seenIn: seen(c.n), name });
    }
    if (without) parties.push({ key: "agent:unknown", who: "ag", label: "Agent", seenIn: seen(without) });
    return { keys: listAvatars(), parties };
  }

  function serveAvatar(res, key) {
    const hit = avatarFile(key);
    if (!hit) return fail(res, 404, "no such avatar");
    fs.readFile(hit.file, (err, data) => {
      if (err) return fail(res, 404, "no such avatar");
      send(res, 200, data, hit.type, { "Cache-Control": "no-cache" });
    });
  }

  const avatarKey = route => {
    try {
      return decodeURIComponent(route.slice("/api/avatars/".length));
    } catch {
      return null;
    }
  };

  function serveStatic(res, file, type) {
    fs.readFile(path.join(UI_DIR, file), (err, data) => {
      if (err) return fail(res, 404, "not found");
      send(res, 200, data, type, { "Cache-Control": "no-cache" });
    });
  }

  function openStream(req, res) {
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const entry = { res };
    streams.add(entry);
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    const cleanups = [() => clearInterval(ping)];
    req.on("close", () => {
      for (const fn of cleanups) fn();
      streams.delete(entry);
      if (!streams.size) idleSince = Date.now();
    });
    return {
      event: (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`),
      onClose: fn => cleanups.push(fn),
    };
  }

  function stream(req, res, url) {
    const view = url.searchParams.get("view");
    if (view === "list") {
      const s = openStream(req, res);
      s.onClose(watcher.subscribe(payload => s.event("sessions", payload)));
      return;
    }
    if (view !== "session") return fail(res, 400, "unknown view");
    const dir = watcher.resolve(url.searchParams.get("ws"), url.searchParams.get("id"));
    const first = dir && watcher.parsedFor(dir);
    if (!first) return fail(res, 404, "no such session");
    sessionStream(openStream(req, res), dir);
  }

  /**
   * One session, live: `snapshot {round, total}` on connect; `activity` add/update for
   * items of the latest round, by key; `session` when its files or its state change.
   */
  function sessionStream(s, dir) {
    const look = () => {
      const parsed = watcher.parsedFor(dir);
      if (!parsed) return null;
      const round = parsed.rounds.length ? parsed.rounds[parsed.rounds.length - 1].round : 0;
      const { items } = roundActivity(parsed, round) || { items: [] };
      let status = null;
      try {
        const { detail } = classify(parsed, { now: watcher.now(), isAlive: watcher.isAlive });
        status = JSON.stringify([detail.state, detail.group, detail.status, detail.warn]);
      } catch {}
      return { round, items, sig: `${sessionFiles(dir)}\n${status}` };
    };
    let cur = look();
    // an item changes when its event log grows or the watchdog stamps its time
    const version = it => `${it.lastLine}:${it.t}`;
    let known = new Map(cur.items.map(it => [it.key, version(it)]));
    s.event("snapshot", { round: cur.round, total: cur.items.length });
    const timer = setInterval(() => {
      const next = look();
      if (!next) return;
      if (next.round !== cur.round) known = new Map();
      if (next.sig !== cur.sig || next.round !== cur.round) s.event("session", { round: next.round });
      for (const it of next.items) {
        const was = known.get(it.key);
        if (was === undefined) s.event("activity", { op: "add", key: it.key, item: it, total: next.items.length });
        else if (was !== version(it)) s.event("activity", { op: "update", key: it.key, item: it, total: next.items.length });
        known.set(it.key, version(it));
      }
      cur = next;
    }, tickMs);
    s.onClose(() => clearInterval(timer));
  }

  const intParam = (url, name) => {
    const v = url.searchParams.get(name);
    return v === null ? null : /^\d+$/.test(v) ? Number(v) : NaN;
  };

  function activityPage(res, url) {
    const dir = watcher.resolve(url.searchParams.get("ws"), url.searchParams.get("id"));
    const parsed = dir && watcher.parsedFor(dir);
    if (!parsed) return fail(res, 404, "no such session");
    const limit = intParam(url, "limit") ?? ACTIVITY_PAGE;
    const before = intParam(url, "before");
    const asked = intParam(url, "round");
    if (Number.isNaN(limit) || limit < 1 || Number.isNaN(before) || Number.isNaN(asked)) return fail(res, 400, "round, before and limit must be whole numbers");
    const round = asked ?? (parsed.rounds.length ? parsed.rounds[parsed.rounds.length - 1].round : 0);
    const act = roundActivity(parsed, round);
    if (!act) return fail(res, 404, "no such round");
    const older = before === null ? act.items : act.items.filter(it => it.line < before);
    const items = older.slice(-limit);
    return json(res, 200, { round, items, total: act.total, hasEarlier: older.length > items.length });
  }

  function promptText(res, url) {
    const dir = watcher.resolve(url.searchParams.get("ws"), url.searchParams.get("id"));
    const round = intParam(url, "round");
    if (!dir || !Number.isInteger(round) || round < 1) return fail(res, 404, "no such prompt");
    fs.readFile(path.join(dir, "prompts", `round-${String(round).padStart(3, "0")}.txt`), "utf8", (err, text) => {
      if (err) return fail(res, 404, "no such prompt");
      send(res, 200, text, "text/plain; charset=utf-8", { "Cache-Control": "no-store" });
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
    if (req.method === "POST" || req.method === "DELETE") {
      if (!viaBearer && !allowedOrigins.has(String(req.headers.origin || ""))) return fail(res, 403, "cross-origin request");
      if (route.startsWith("/api/avatars/")) {
        try {
          if (req.method === "DELETE") {
            removeAvatar(avatarKey(route));
            return json(res, 200, { ok: true });
          }
          const saved = saveAvatar(avatarKey(route), await readBody(req, AVATAR_MAX_BYTES));
          return json(res, 200, saved);
        } catch (e) {
          if (e instanceof AvatarError || e.status) return fail(res, e.status || 400, e.status === 413 ? "That image is over 1 MB. Pick a smaller one." : e.message);
          throw e;
        }
      }
      if (req.method === "DELETE") return fail(res, 405, "method not allowed");
      let body;
      try {
        body = JSON.parse((await readBody(req, SETTINGS_BODY_MAX)).toString("utf8"));
      } catch (e) {
        if (e.status === 413) return fail(res, 413, "the request is over 64 KB");
        return fail(res, 400, "body must be JSON");
      }
      if (route === "/api/settings") {
        try {
          return saveSettings(res, body);
        } catch (e) {
          return fail(res, 400, e.message);
        }
      }
      if (route === "/api/reveal") {
        const dir = body && watcher.resolve(body.ws, body.id);
        if (!dir) return fail(res, 404, "no such session");
        reveal(dir);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/workspaces") {
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
    if (route.startsWith("/avatars/")) {
      let key;
      try {
        key = decodeURIComponent(route.slice("/avatars/".length));
      } catch {
        return fail(res, 404, "not found");
      }
      return serveAvatar(res, key);
    }
    switch (route) {
      case "/api/settings":
        return json(res, 200, await settingsPayload());
      case "/api/models": {
        const m = await models(url.searchParams.get("refresh") === "1");
        let codexDefault = null;
        try {
          codexDefault = catalog.defaultModel();
        } catch {}
        return json(res, 200, { models: m.models, fetchedAt: m.fetchedAt, codexDefault, reviewer: m.reviewer });
      }
      case "/api/avatars":
        return json(res, 200, avatarParties());
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
        return json(res, 200, { ...detail, ws, wsName: watcher.wsName(ws), serverTime: watcher.now() });
      }
      case "/api/plan": {
        const ws = url.searchParams.get("ws");
        const file = url.searchParams.get("file");
        if (!ws || !file) return fail(res, 400, "ws and file are required");
        const plan = watcher.plan(ws, file);
        if (!plan) return fail(res, 404, "no such plan");
        return json(res, 200, { ...plan, serverTime: watcher.now() });
      }
      case "/api/activity":
        return activityPage(res, url);
      case "/api/prompt":
        return promptText(res, url);
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
