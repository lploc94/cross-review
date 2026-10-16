#!/usr/bin/env node
// The landing page's live dashboard demo: the real dashboard UI (ui/) with a recorded data
// layer. It writes the invented projects of story.mjs under a temporary HOME, runs the real
// dashboard server on them, plays the story's steps (a review's round 3 to its approval, then
// the plan's phase 3 criteria and commit), records every API answer at each step, and writes
// a static folder: the UI files, data.json and demo.js, which answers the UI's requests from
// data.json in the browser and plays the steps again.
//
//   node demo/build.mjs [out dir]      (default demo/out/demo; copy it to the site's public/demo/)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const UI = path.join(REPO, "skill-packs/cross-review/scripts/lib/dashboard/ui");
const OUT = path.resolve(process.argv[2] || path.join(HERE, "out", "demo"));

const story = await import(pathToFileURL(path.join(HERE, "story.mjs")).href);
const { T0, LIVE_PID, LIVE_ORCHARD_PID, LIVE_START, LIVE_TOTAL, ORCH_START, ORCH_TOTAL, LIVE_ID, liveSeconds } = story;

// ---------- the steps ----------

/**
 * Each step: how long it shows (ms), the view the demo opens on it, and the story's state:
 * acts of the live round done, approved, acts of the orchard review done, plan criteria
 * ticked, phase 3 committed.
 */
function timeline() {
  const steps = [];
  let s = { live: LIVE_START, approved: false, orch: ORCH_START, ticked: 0, committed: false };
  const add = (ms, view, change = {}) => {
    s = { ...s, ...change };
    steps.push({ ms, view, ...s });
  };
  const orch = () => Math.min(ORCH_TOTAL, s.orch + 1);
  // Sessions: both running reviews move in the list
  add(2200, "sessions");
  for (let i = 0; i < 4; i++) add(1600, "sessions", { live: s.live + 1, orch: orch() });
  // the review: round 3's activity streams in, then the verdict
  add(1600, "session");
  while (s.live < LIVE_TOTAL) add(s.live % 5 === 4 ? 1700 : 1150, "session", { live: s.live + 1, orch: s.live % 2 ? orch() : s.orch });
  add(3200, "session");
  add(5200, "session", { approved: true });
  // the plan: phase 3's criteria are ticked, then its commit lands
  add(1800, "plan");
  add(1300, "plan", { ticked: 1 });
  add(1300, "plan", { ticked: 2 });
  add(1500, "plan", { ticked: 3 });
  add(5200, "plan", { committed: true });
  // the plans: where every plan stands
  add(6000, "plans");
  // The clock moves with the step's time, or, while the live round works, by the time its act
  // took: a test run takes 40 s on the page, not one step's second.
  let now = T0;
  steps.forEach((step, i) => {
    step.now = Math.round(now);
    const next = steps[i + 1];
    now += next && next.live > step.live ? Math.max(step.ms / 1000, liveSeconds(next.live - 1)) : step.ms / 1000;
  });
  return steps;
}

/** ends[i]: the clock when act i completed — the first step with more than i acts done. */
function endsOf(steps, key) {
  const ends = [];
  for (const st of steps) for (let i = 0; i < st[key]; i++) if (ends[i] === undefined) ends[i] = st.now;
  return ends;
}

// ---------- recording ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cr-demo-")));
  process.env.HOME = path.join(tmp, "home");
  const root = path.join(process.env.HOME, "projects");
  const ws = story.buildTree(root);
  const steps = timeline();
  const liveEnds = endsOf(steps, "live");
  const orchEnds = endsOf(steps, "orch");
  // the steps before the demo starts: the acts done at step 0 ended before T0
  for (let i = 0; i < LIVE_START; i++) liveEnds[i] = undefined;
  for (let i = 0; i < ORCH_START; i++) orchEnds[i] = undefined;

  let clock = T0;
  let alive = new Set([LIVE_PID, LIVE_ORCHARD_PID]);
  const apply = st => {
    clock = st.now;
    story.writeLive(ws.harbor, { done: st.live, approved: st.approved, now: st.now, ends: liveEnds });
    story.writeOrchard(ws.orchard, { done: st.orch, ends: orchEnds });
    story.writePlan(ws.harbor, "export-formats-plan.md", story.exportPlan({ ticked: st.ticked }), st.ticked ? st.now : T0 - 52 * 60);
    if (st.committed && !committed) {
      story.commit(ws.harbor, "feat(export): stream large exports in pages", st.now);
      committed = true;
    }
    alive = new Set(st.approved ? [LIVE_ORCHARD_PID] : [LIVE_PID, LIVE_ORCHARD_PID]);
  };
  let committed = false;
  apply(steps[0]);

  // imported after HOME is set: settings and avatars are read from it
  const { startDashboard } = await import(pathToFileURL(path.join(REPO, "skill-packs/cross-review/scripts/lib/dashboard/server.js")).href);
  const catalog = {
    listModels: async () => [
      { slug: "gpt-5-codex", name: "GPT-5-Codex", description: "Tuned for coding work.", efforts: ["low", "medium", "high"] },
      { slug: "gpt-5", name: "GPT-5", description: "General reasoning.", efforts: ["minimal", "low", "medium", "high"] },
    ],
    defaultModel: () => "gpt-5-codex",
    cliInfo: async () => ({ version: "codex-cli", loggedIn: true }),
  };
  // Claude Code lists its aliases; agy groups its models into families with their levels
  const otherCatalogs = {
    claude: {
      listModels: async () => [
        { slug: "opus", name: "Opus", description: "The latest Opus model.", efforts: ["low", "medium", "high", "xhigh", "max"] },
        { slug: "sonnet", name: "Sonnet", description: "The latest Sonnet model.", efforts: ["low", "medium", "high", "xhigh", "max"] },
      ],
      defaultModel: () => null,
      cliInfo: async () => ({ version: "claude-code", loggedIn: true }),
    },
    agy: {
      listModels: async () => [
        { slug: "gemini-flash", name: "Gemini Flash", description: "", efforts: ["low", "high"] },
        { slug: "gemini-pro", name: "Gemini Pro", description: "", efforts: ["low", "high"] },
      ],
      defaultModel: () => "Gemini Flash (High)",
      cliInfo: async () => ({ version: "agy", loggedIn: null }),
    },
  };
  const d = await startDashboard({
    root, port: 0, open: false, discoveryFile: null, catalogs: { codex: catalog, ...otherCatalogs }, latestVersion: async () => null,
    now: () => clock, isAlive: pid => alive.has(pid), tickMs: 100, rescanMs: 100,
  });
  const base = new URL(d.url).origin;
  const get = async (route, asText = false) => {
    const res = await fetch(base + route, { headers: { Authorization: `Bearer ${d.token}` } });
    if (!res.ok) throw new Error(`${route}: ${res.status} ${await res.text()}`);
    return asText ? res.text() : res.json();
  };
  const strip = body => {
    if (body && typeof body === "object") delete body.serverTime;
    return body;
  };

  // url → [[step, body], ...], a new entry only when the answer changed
  const res = {};
  const keep = (url, i, body) => {
    const list = (res[url] ||= []);
    const text = JSON.stringify(body);
    if (!list.length || JSON.stringify(list[list.length - 1][1]) !== text) list.push([i, body]);
  };
  const q = params => new URLSearchParams(params).toString();
  try {
    for (const [i, st] of steps.entries()) {
      if (i > 0) apply(st);
      // the watcher re-reads changed files on its next look
      await sleep(250);
      const list = strip(await get("/api/sessions"));
      keep("/api/sessions", i, list);
      for (const s of [...list.active, ...list.history]) {
        const key = q({ ws: s.ws, id: s.id });
        const detail = strip(await get(`/api/session?${key}`));
        keep(`/api/session?${key}`, i, detail);
        for (let round = 1; round <= detail.currentRound; round++) {
          const page = await get(`/api/activity?${key}&round=${round}&limit=100000`);
          keep(`/api/activity?${key}&round=${round}`, i, page.items);
          if (i === 0 || s.id === LIVE_ID) keep(`/api/prompt?${key}&round=${round}`, i, await get(`/api/prompt?${key}&round=${round}`, true).catch(() => null));
        }
      }
      for (const p of list.plans) {
        if (!p.file) continue;
        const key = q({ ws: p.ws, file: p.file });
        keep(`/api/plan?${key}`, i, strip(await get(`/api/plan?${key}`)));
      }
      if (i === 0) {
        for (const route of ["/api/settings", "/api/avatars", "/api/update", "/api/overview", ...["codex", "claude", "agy"].map(r => `/api/models?reviewer=${r}`)]) keep(route, 0, strip(await get(route)));
      }
      process.stdout.write(`step ${i + 1}/${steps.length}\r`);
    }
    process.stdout.write("\n");

    const first = res["/api/sessions"][0][1];
    const live = [...first.active, ...first.history].find(s => s.id === LIVE_ID);
    const plan = first.plans.find(p => p.file === "export-formats-plan.md");
    const views = {
      sessions: "#/",
      session: `#/s/${encodeURIComponent(live.ws)}/${live.id}`,
      plan: `#/p/${encodeURIComponent(plan.ws)}/${encodeURIComponent(plan.file)}`,
      plans: "#/plans",
    };
    const data = { steps: steps.map(({ ms, view, now }) => ({ ms, view, now })), views, res };
    writeOut(data, process.env.HOME);
  } finally {
    await d.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Writes the static folder; the temporary HOME in the recorded paths becomes an invented one. */
function writeOut(data, home) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "avatars"), { recursive: true });
  for (const f of ["app.js", "app.css", "icons.js", "feed.js", "settings.js", "markdown.js", "LICENSE-lucide.txt"]) fs.copyFileSync(path.join(UI, f), path.join(OUT, f));
  for (const who of ["reviewer", "agent", "you"]) for (const size of ["", "-full"]) fs.copyFileSync(path.join(UI, "avatars", `${who}${size}.png`), path.join(OUT, "avatars", `${who}${size}.png`));
  const html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  const tag = `<script type="module" src="app.js"></script>`;
  if (!html.includes(tag)) throw new Error(`ui/index.html no longer loads app.js as ${tag}`);
  fs.writeFileSync(path.join(OUT, "index.html"), html.replace(tag, `<script src="demo.js"></script>\n${tag}`).replace(/<title>[^<]*<\/title>/, "<title>cross-review dashboard demo</title>"));
  fs.copyFileSync(path.join(HERE, "demo.js"), path.join(OUT, "demo.js"));
  fs.writeFileSync(path.join(OUT, "data.json"), JSON.stringify(data).split(home).join("/Users/demo"));
  const size = fs.statSync(path.join(OUT, "data.json")).size;
  console.log(`wrote ${OUT} (data.json ${(size / 1024).toFixed(0)} KB, ${data.steps.length} steps)`);
}

main().catch(err => {
  console.error(`demo: ${err.message}`);
  process.exit(1);
});
