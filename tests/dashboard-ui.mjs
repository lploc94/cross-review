#!/usr/bin/env node
// Sessions page in headless Chrome: builds the invented fixture in a temp dir, serves it,
// opens the printed link (Chrome follows the 303 and keeps the cookie), checks the DOM,
// and writes a 1400px screenshot outside the repo for a side-by-side look with the mock.
//
//   node tests/dashboard-ui.mjs        (CHROME=<path> to pick the browser)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";

import { PLANS, buildFixture, buildPlans, writePlan, writeSession } from "./helpers/dashboard-fixture.js";
import { findChrome, launchChrome } from "./helpers/chrome.js";
import { startDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";
import { GITIGNORE } from "../skill-packs/cross-review/scripts/lib/config.js";
import { parsePlan } from "../skill-packs/cross-review/scripts/lib/plans.js";

const bin = findChrome();
if (!bin) {
  console.error("dashboard-ui: no Chrome found; set CHROME=<path>");
  process.exit(1);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-ui-")));
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-shots-"));
const root = path.join(tmp, "root");
const fx = buildFixture(root, { now: Math.floor(Date.now() / 1000), livePid: process.pid });
// Settings and avatars live under HOME: never the real one
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME);
// An invented model catalog instead of asking the codex CLI
const catalog = {
  listModels: async () => [
    { slug: "model-a", name: "Model A", description: "An invented model.", efforts: ["low", "medium", "high", "xhigh"] },
    { slug: "model-b", name: "Model B", description: "Another invented model.", efforts: ["low", "high"] },
  ],
  defaultModel: () => "model-a",
  cliInfo: async () => ({ version: "codex-cli 9.9.9-invented", loggedIn: true }),
};
const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog });
// Settings save as they change; this note says when every save is done
const SAVED = `document.getElementById("save-state").classList.contains("saved")`;
const browser = await launchChrome(bin, path.join(tmp, "profile"));
try {
  const sessions = await (await fetch(`http://127.0.0.1:${d.port}/api/sessions`, { headers: { Authorization: `Bearer ${d.token}` } })).json();
  const page = await browser.newPage(1400, 1300);
  await page.goto(`${d.url}#/`);
  await page.waitFor(`document.querySelectorAll("#history tr[data-go]").length > 0`);
  assert.equal(await page.evaluate("location.search"), "", "the token left the address bar");

  const dom = await page.evaluate(`(() => ({
    logo: (() => { const i = document.querySelector(".top .wrap .name img.logo"); return i && i.complete && i.naturalWidth > 0 ? i.getAttribute("src") : null; })(),
    icon: document.querySelector("link[rel=icon]")?.getAttribute("href"),
    foot: document.querySelector(".site-foot").textContent.replace(/\\s+/g, " ").trim(),
    links: [...document.querySelectorAll(".site-foot a")].map(a => [a.textContent, a.href, a.target, a.rel]),
    nav: [...document.querySelectorAll(".top nav a")].map(a => ({ nav: a.dataset.nav, svg: !!a.querySelector("svg"), on: a.classList.contains("on") })),
    where: document.getElementById("where").textContent,
    active: [...document.querySelectorAll("#active tr")].map(tr => ({
      st: !!tr.querySelector(".st svg"), skill: !!tr.querySelector(".skill svg"), warn: !!tr.querySelector(".warn"),
      go: tr.dataset.go, forText: tr.querySelector("[data-since]")?.textContent,
    })),
    history: document.querySelectorAll("#history tr[data-go]").length,
    demo: !!document.getElementById("demo"),
    inlineStyle: document.querySelectorAll("[style]").length,
  }))()`);

  // header: the owl as logo and tab icon, three nav entries with icons, Sessions on
  assert.equal(dom.logo, "avatars/reviewer.png");
  assert.equal(dom.icon, "avatars/reviewer.png");
  assert.deepEqual(dom.nav, [{ nav: "sessions", svg: true, on: true }, { nav: "plans", svg: true, on: false }, { nav: "settings", svg: true, on: false }]);
  assert.match(dom.where, /scanned 3 levels down · 3 workspaces$/);
  // footer: the pack's version and the project's links, opened in a new tab
  assert.match(dom.foot, /^cross-review \d+\.\d+\.\d+ · GitHub · Update · Report a problem$/);
  const repo = "https://github.com/lploc94/cross-review";
  assert.deepEqual(dom.links, [["GitHub", repo, "_blank", "noopener noreferrer"], ["Update", `${repo}#reinstall--update`, "_blank", "noopener noreferrer"], ["Report a problem", `${repo}/issues`, "_blank", "noopener noreferrer"]]);

  // In progress: one row per active session, each with a state mark and a skill icon
  assert.equal(dom.active.length, sessions.active.length);
  for (const row of dom.active) {
    assert.ok(row.st && row.skill, JSON.stringify(row));
    assert.match(row.forText, /^\d+:\d\d$|^\d+h \d+m$/);
  }
  assert.equal(dom.active.filter(r => r.warn).length, sessions.active.filter(s => s.warn).length);
  assert.ok(dom.active.some(r => r.warn), "the fixture has a warned session");

  // History: the newest finished sessions, a page that fits the window; filters work in the page
  const pagerText = await page.evaluate(`document.getElementById("h-pager").textContent`);
  if (dom.history < sessions.history.length) assert.equal(pagerText, `‹ Newer1–${dom.history} of ${sessions.history.length}Older ›`);
  else assert.equal(pagerText, "");
  assert.ok(dom.history >= 3);
  assert.equal(dom.demo, false);
  assert.equal(dom.inlineStyle, 0);
  const noReply = sessions.history.filter(s => s.label === "no reply").length;
  assert.equal(await page.evaluate(`(() => { const f = document.getElementById("f-result"); f.value = "no reply"; f.dispatchEvent(new Event("change")); return document.querySelectorAll("#history tr[data-go]").length; })()`), noReply);
  assert.equal(await page.evaluate(`(() => { document.getElementById("f-result").value = ""; const q = document.getElementById("f-search"); q.value = "Model list cached"; q.dispatchEvent(new Event("input")); return document.querySelectorAll("#history tr[data-go]").length; })()`),
    sessions.history.filter(s => s.searchText.includes("model list cached")).length);
  await page.evaluate(`(() => { const q = document.getElementById("f-search"); q.value = ""; q.dispatchEvent(new Event("input")); })()`);
  await page.screenshot(path.join(shots, "sessions-1400.png"));

  // A shorter window: History shows a page that fits, no scrolling; In progress rows keep one line per field
  const short = await browser.newPage(1400, 1000);
  await short.goto(`${d.url}#/`);
  await short.waitFor(`document.querySelectorAll("#history tr[data-go]").length > 0`);
  const fit = await short.evaluate(`({
    rows: document.querySelectorAll("#history tr[data-go]").length,
    pager: document.getElementById("h-pager").textContent,
    scrolls: document.documentElement.scrollHeight > window.innerHeight + 1, sh: document.documentElement.scrollHeight, ih: window.innerHeight, pagerBottom: document.getElementById("h-pager").getBoundingClientRect().bottom,
    heights: [...document.querySelectorAll("#active tr")].map(tr => Math.round(tr.getBoundingClientRect().height)),
    first: document.querySelector("#history tr[data-go]").dataset.go,
  })`);
  assert.ok(fit.rows >= 3 && fit.rows < sessions.history.length, JSON.stringify(fit));
  assert.equal(fit.pager, `‹ Newer1–${fit.rows} of ${sessions.history.length}Older ›`);
  assert.equal(fit.scrolls, false, `the Sessions page fits the window: ${JSON.stringify(fit)}`);
  assert.equal(new Set(fit.heights).size, 1, `one height for every In progress row: ${fit.heights}`);
  await short.evaluate(`document.querySelector('#h-pager a[data-hpage="1"]').click()`);
  const next = await short.evaluate(`({ first: document.querySelector("#history tr[data-go]").dataset.go, pager: document.getElementById("h-pager").textContent })`);
  assert.notEqual(next.first, fit.first);
  assert.match(next.pager, new RegExp(`^‹ Newer${fit.rows + 1}–\\d+ of ${sessions.history.length}Older ›$`));
  await short.screenshot(path.join(shots, "sessions-1000.png"));

  // Routes: a row opens its session with the Sessions tab lit; an unknown hash goes home
  const waitingId = path.basename(fx.sessions.waiting);
  await page.evaluate(`document.querySelector('#active tr[data-go$="${waitingId}"] td').click()`);
  await page.waitFor(`location.hash === "#/s/harbor-app/${waitingId}" && document.getElementById("detail").classList.contains("on")`);
  assert.equal(await page.evaluate(`document.querySelector('.top nav a[data-nav="sessions"]').classList.contains("on")`), true);
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("settings").classList.contains("on") && document.querySelector('.top nav a.on').dataset.nav === "settings"`);
  await page.evaluate(`location.hash = "#/no/such/place"`);
  await page.waitFor(`location.hash === "#/" && document.getElementById("sessions").classList.contains("on")`);

  // ---------- session pages ----------
  const open = async (key, suffix = "") => {
    const id = path.basename(fx.sessions[key]);
    const ws = encodeURIComponent(path.relative(root, path.dirname(path.dirname(path.dirname(fx.sessions[key])))));
    await page.evaluate(`location.hash = "#/s/${ws}/${id}${suffix}"`);
    await page.waitFor(`document.getElementById("detail").classList.contains("on") && document.querySelector("#d-meta > .mono")?.textContent === "${id}" && document.querySelector("#status .what")`);
  };
  const statusOf = () => page.evaluate(`({ cls: document.getElementById("status").className, what: document.querySelector("#status .what").textContent.trim() })`);

  // Running: status, five steps ending "Round 3 in progress", both sides, the finding, 20 live events
  await open("running");
  await page.waitFor(`document.querySelectorAll("#acts .act").length > 0`);
  const run = await page.evaluate(`(() => ({
    status: document.getElementById("status").className,
    spin: !!document.querySelector("#status .what svg"),
    steps: [...document.querySelectorAll("#steps .s")].map(s => s.textContent.trim()),
    you: document.querySelector("#thread .m.r.us .mark")?.title,
    rvLeft: [...document.querySelectorAll("#thread .m")].some(m => !m.classList.contains("r") && m.querySelector(".mark.rv")),
    finding3: !!document.querySelector('#thread .finding[data-issue="3"]'),
    lines: document.querySelectorAll("#acts .act").length,
    events: [...document.querySelectorAll("#acts .act")].reduce((n, a) => n + Number(a.dataset.n), 0),
    earlier: document.getElementById("earlier").textContent,
    count: document.getElementById("act-count").textContent,
    ledger: document.getElementById("ledger").textContent,
    avatars: [...document.querySelectorAll("#thread .mark img")].every(i => i.complete && i.naturalWidth > 0),
    clock: document.querySelector("#status .next .run-clock")?.textContent,
    rounds: [...document.querySelectorAll("#thread .round-label")].map(l => l.textContent),
    liveFirst: document.querySelector("#thread .m")?.id === "s-live",
    firstLabel: document.getElementById("thread").firstElementChild?.textContent,
    lastIsAsk: [...document.querySelectorAll("#thread .m")].pop()?.classList.contains("us"),
    askInRound1: (() => {
      const r1 = [...document.querySelectorAll("#thread .round-label")].find(l => l.textContent === "ROUND 1");
      const us = document.querySelector("#thread .m.us");
      return Boolean(r1 && us && (r1.compareDocumentPosition(us) & Node.DOCUMENT_POSITION_FOLLOWING));
    })(),
    inlineStyle: document.querySelectorAll("[style]").length,
  }))()`);
  assert.equal(run.status, "status running");
  // newest round first; the user's request closes the oldest round at the bottom
  assert.deepEqual(run.rounds, ["ROUND 3", "ROUND 2", "ROUND 1"]);
  assert.ok(run.askInRound1, "the user's request sits in round 1, at the bottom");
  assert.ok(run.liveFirst, "the reviewer working is the first message");
  assert.equal(run.firstLabel, "ROUND 3");
  assert.ok(run.lastIsAsk, "the user's request is the last message");
  assert.ok(run.spin);
  assert.equal(run.steps.length, 5);
  assert.equal(run.steps[4], "Round 3 in progress");
  assert.equal(run.you, "You");
  assert.ok(run.rvLeft, "the reviewer speaks from the left");
  assert.ok(run.finding3);
  assert.equal(run.events, 20, "the window holds the latest 20 events");
  assert.ok(run.lines <= 20 && run.lines > 0);
  assert.equal(run.earlier, "show 20 earlier");
  assert.equal(run.count, "latest 20 of 45 events");
  assert.match(run.ledger, /checking now/);
  assert.ok(run.avatars, "default avatars load");
  assert.match(run.clock, /^\d+:\d\d$/);
  assert.equal(run.inlineStyle, 0);
  await page.screenshot(path.join(shots, "detail-running-1400.png"));

  // A new event arrives live; "show 20 earlier" grows the window; a line opens its raw command
  fs.appendFileSync(path.join(fx.sessions.running, "output.jsonl"), JSON.stringify({ type: "item.completed", item: { id: "ui_new", type: "reasoning", text: "Invented live thought." } }) + "\n");
  await page.waitFor(`document.getElementById("act-count").textContent === "latest 20 of 46 events"`);
  assert.match(await page.evaluate(`document.querySelector("#acts .act").textContent`), /Invented live thought/, "the newest line is on top");
  await page.evaluate(`document.getElementById("earlier").click()`);
  await page.waitFor(`document.getElementById("act-count").textContent === "latest 40 of 46 events"`);
  await page.evaluate(`document.querySelector("#acts .act[data-raw]").click()`);
  assert.equal(await page.evaluate(`document.querySelector("#acts .act[data-raw]").classList.contains("open")`), true);
  fs.appendFileSync(path.join(fx.sessions.running, "output.jsonl"), JSON.stringify({ type: "item.completed", item: { id: "ui_new2", type: "reasoning", text: "Second live thought." } }) + "\n");
  await page.waitFor(`document.getElementById("act-count").textContent === "latest 40 of 47 events"`);
  assert.equal(await page.evaluate(`document.querySelector("#acts .act[data-raw]").classList.contains("open")`), true, "an open line stays open");

  // A finished round: activity (N) and prompt sent open in place
  await page.evaluate(`document.querySelector('#thread [data-past="1"]').click()`);
  await page.waitFor(`document.querySelectorAll('#past-1 .act').length > 0`);
  await page.evaluate(`document.querySelector('#thread [data-prompt="1"]').click()`);
  await page.waitFor(`document.querySelector('#prompt-1')?.textContent === "Invented prompt for round 1.\\n"`);

  // Approved, deep link to ISSUE-2: the finding flashes
  await open("approved", "/ISSUE-2");
  await page.waitFor(`document.querySelector('#thread .finding[data-issue="2"]')?.classList.contains("flash")`);
  await page.screenshot(path.join(shots, "detail-approve-1400.png"));

  // The other states read like the mock
  const expect = {
    approved: ["status approve", "Approved in round 3."],
    waiting: ["status waiting", "Round 2 left one issue open. The agent has to fix or dispute it."],
    stopped: ["status stopped", /^Stopped in round 3: /],
    stalemate: ["status stalemate", "Stalemate on ISSUE-3. You decide."],
    think: ["status consensus", "Consensus in round 2."],
  };
  for (const [key, [cls, what]] of Object.entries(expect)) {
    await open(key);
    const s = await statusOf();
    assert.equal(s.cls, cls, key);
    if (what instanceof RegExp) assert.match(s.what, what, key); else assert.equal(s.what, what, key);
    await page.screenshot(path.join(shots, `detail-${key}-1400.png`));
  }
  // The peer session: the reviewer's text as written, the agent's own analysis, no ledger
  const think = await page.evaluate(`({
    h3: document.querySelector("#thread .bubble h3")?.textContent,
    analysis: [...document.querySelectorAll("#thread .m.r .who")].some(w => /independent analysis/.test(w.textContent)),
    ledger: document.getElementById("issues-box").classList.contains("on"),
    last: document.querySelector("#thread .who .st")?.textContent,
  })`);
  assert.equal(think.last, "consensus");
  assert.equal(think.h3, "Position");
  assert.ok(think.analysis);
  assert.equal(think.ledger, false);

  // ---------- settings ----------
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.querySelectorAll("#per-skill tr").length === 4 && document.querySelectorAll("#avatars tr").length >= 2`);
  const set = await page.evaluate(`({
    follow: !!document.querySelector(".form #f-follow"),
    buttons: [...document.querySelectorAll("#settings button")].map(b => b.id),
    avatars: document.getElementById("avatars-block").classList.contains("on"),
    model: document.querySelector("#f-model-set option").textContent,
    models: document.querySelectorAll("#f-model-set option").length,
    help: document.getElementById("reviewer-help").textContent,
    explain: document.getElementById("explain").textContent,
    inlineStyle: document.querySelectorAll("[style]").length,
    gutter: getComputedStyle(document.documentElement).scrollbarGutter,
  })`);
  assert.equal(set.gutter, "stable", "Sessions and Settings keep the same width");
  assert.ok(set.follow);
  assert.deepEqual(set.buttons, ["check-update", "clear-ws"], "no Save or Discard: a change saves by itself");
  assert.equal(set.avatars, true);
  assert.equal(set.model, "Codex default (Model A)");
  assert.equal(set.models, 3);
  assert.equal(set.help, "codex-cli 9.9.9-invented, signed in");
  assert.match(set.explain, /\.cross-review\/config\.json/);
  assert.equal(set.inlineStyle, 0);
  await page.screenshot(path.join(shots, "settings-1400.png"));

  // Each change saves at once: Follow reviews on, review-impl on Model B; the file holds only
  // those, and the note says Saved
  await page.evaluate(`(() => {
    const f = document.getElementById("f-follow"); f.value = "on"; f.dispatchEvent(new Event("change", { bubbles: true }));
    const m = document.querySelector('#per-skill select[data-path="skills.review-impl.model"]'); m.value = "model-b"; m.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.match(await page.evaluate(`document.querySelectorAll("#per-skill tr")[1].textContent`), /set here[\s\S]*Model B · high/);
  await page.waitFor(SAVED);
  assert.equal(await page.evaluate(`document.getElementById("save-state").textContent`), "Saved");
  await page.screenshot(path.join(shots, "settings-saved-1400.png"));
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { open_dashboard: true, skills: { "review-impl": { model: "model-b" } } });

  // A workspace: inherits the global values, no avatars, saves to its own file
  await page.evaluate(`location.hash = "#/settings/harbor-app"`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show harbor-app/.cross-review/config.json"`);
  const ws = await page.evaluate(`({
    avatars: document.getElementById("avatars-block").classList.contains("on"),
    follow: document.querySelector("#f-follow option").textContent,
    impl: document.querySelectorAll("#per-skill tr")[1].querySelector("td:last-child").textContent,
    scope: document.querySelector("#settings input[value=workspace]").checked,
  })`);
  assert.equal(ws.avatars, false);
  assert.equal(ws.follow, "Inherit — on");
  assert.match(ws.impl, /^Model B · high/);
  assert.equal(ws.scope, true);
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const wsFile = path.join(fx.workspaces.harbor, ".cross-review", "config.json");
  for (let i = 0; i < 50 && !fs.existsSync(wsFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf8")), { effort: "low" });
  await page.screenshot(path.join(shots, "settings-workspace-1400.png"));
  // Clear this workspace asks first, then saves the empty level (which removes the file)
  await page.evaluate(`(() => { window.confirm = () => false; document.getElementById("clear-ws").click(); })()`);
  assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"effort": "low"/, "cancelled: nothing changes");
  await page.evaluate(`(() => { window.confirm = () => true; document.getElementById("clear-ws").click(); })()`);
  await page.waitFor(SAVED);
  assert.equal(fs.existsSync(wsFile), false);
  assert.equal(await page.evaluate(`document.getElementById("preview").textContent.trim()`), "{}");

  // One save at a time: a change made while a save is out is saved after it, in order
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show ~/.cross-review/config.json"`);
  await page.evaluate(`(() => {
    const native = window.fetch;
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (args[0] === "/api/settings" && args[1] && args[1].method === "POST" && !window.held2) {
        window.held2 = true;
        await new Promise(r => { window.releaseSave2 = r; });
      }
      return res;
    };
    const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`typeof window.releaseSave2 === "function"`);
  assert.equal(await page.evaluate(`document.getElementById("save-state").textContent`), "Saving…");
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "xhigh"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "low", "the second change waits for the first save");
  await page.evaluate(`window.releaseSave2()`);
  await page.waitFor(SAVED);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "xhigh");
  assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"effort": "xhigh"/);

  // A save whose answer cannot be read does not strand the change queued behind it; a last
  // save that fails says so
  await page.evaluate(`(() => {
    const native = window.fetch;
    window.posts = 0;
    window.breakSaves = true;
    window.fetch = async (...args) => {
      if (window.breakSaves && args[0] === "/api/settings" && args[1] && args[1].method === "POST" && ++window.posts !== 2) {
        await native(...args);
        await new Promise(r => { window.breakBody = r; });
        return { ok: true, json: () => Promise.reject(new TypeError("invented body failure")) };
      }
      return native(...args);
    };
    const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`typeof window.breakBody === "function"`);
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "high"; e.dispatchEvent(new Event("change", { bubbles: true })); const b = window.breakBody; window.breakBody = null; b(); })()`);
  await page.waitFor(SAVED);
  assert.equal(await page.evaluate(`window.posts`), 2);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "high");
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "xhigh"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.waitFor(`typeof window.breakBody === "function"`);
  await page.evaluate(`(() => { const b = window.breakBody; window.breakBody = null; b(); })()`);
  await page.waitFor(`document.getElementById("save-state").classList.contains("failed")`);
  assert.match(await page.evaluate(`document.getElementById("save-state").textContent`), /^Not saved: /);
  await page.evaluate(`(() => { window.breakSaves = false; })()`);

  // Switching to a workspace while a global save is in flight: the answer goes to the global
  // level only, and the workspace form starts from the workspace's own (empty) file
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show ~/.cross-review/config.json"`);
  await page.evaluate(`(() => {
    const native = window.fetch;
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (args[0] === "/api/settings" && args[1] && args[1].method === "POST" && !window.held) {
        window.held = true;
        await new Promise(r => { window.releaseSave = r; });
      }
      return res;
    };
    const e = document.getElementById("f-effort-set"); e.value = "medium"; e.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`typeof window.releaseSave === "function"`);
  await page.evaluate(`location.hash = "#/settings/inkwell"`);
  await page.evaluate(`window.releaseSave()`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show inkwell/.cross-review/config.json"`);
  await page.waitFor(`document.getElementById("preview").textContent.trim() === "{}" && document.querySelector("#f-effort-set option").textContent === "Inherit — medium"`);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "medium");
  await page.evaluate(`(() => { const f = document.getElementById("f-follow"); f.value = "off"; f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const inkFile = path.join(fx.workspaces.inkwell, ".cross-review", "config.json");
  for (let i = 0; i < 50 && !fs.existsSync(inkFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(inkFile, "utf8")), { open_dashboard: false });

  // Settings loads that answer out of order: the older load is dropped, the newer page and
  // its edits stay
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show ~/.cross-review/config.json"`);
  await page.evaluate(`(() => {
    const native = window.fetch;
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (args[0] === "/api/settings" && !args[1] && !window.held3) {
        window.held3 = true;
        await new Promise(r => { window.releaseLoad = r; });
      }
      return res;
    };
    location.hash = "#/settings/harbor-app";
  })()`);
  await page.waitFor(`typeof window.releaseLoad === "function"`);
  await page.evaluate(`location.hash = "#/settings/inkwell"`);
  await page.waitFor(`document.getElementById("preview-title").textContent === "Show inkwell/.cross-review/config.json"`);
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.evaluate(`(async () => { window.releaseLoad(); await new Promise(r => setTimeout(r, 300)); })()`);
  assert.equal(await page.evaluate(`document.getElementById("preview-title").textContent`), "Show inkwell/.cross-review/config.json");
  assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"effort": "low"/);
  // ... and a load that answers after the user left Settings does not pull them back
  await page.evaluate(`(() => { window.held3 = false; window.releaseLoad = null; location.hash = "#/settings/no-such-workspace"; })()`);
  await page.waitFor(`typeof window.releaseLoad === "function"`);
  await page.evaluate(`location.hash = "#/"`);
  await page.evaluate(`(async () => { window.releaseLoad(); await new Promise(r => setTimeout(r, 300)); })()`);
  assert.equal(await page.evaluate(`location.hash`), "#/");

  // An uploaded avatar replaces the default picture in the session thread
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("avatars-block").classList.contains("on") && document.querySelector('#avatars input[data-av="you"]')`);
  await page.evaluate(`(async () => {
    const blob = await (await fetch("avatars/agent.png")).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "me.png", { type: "image/png" }));
    const input = document.querySelector('#avatars input[data-av="you"]');
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.waitFor(`[...document.querySelectorAll("#avatars a[data-av-clear]")].some(a => a.dataset.avClear === "you")`);
  assert.ok(fs.existsSync(path.join(process.env.HOME, ".cross-review", "avatars", "you.png")));
  await open("running");
  await page.waitFor(`document.querySelector("#thread .m.us .mark img")`);
  assert.match(await page.evaluate(`document.querySelector("#thread .m.us .mark img").getAttribute("src")`), /^avatars\/you\?v=\d+$/);
  assert.match(await page.evaluate(`document.querySelector("#thread .mark.rv img").getAttribute("src")`), /^avatars\/reviewer\.png$/);
  // each avatar in the thread sits in a 40px rounded square frame
  for (const who of ["rv", "ag", "us"]) {
    const frame = await page.evaluate(`(() => { const s = getComputedStyle(document.querySelector("#thread .mark.${who}")); return [s.width, s.height, s.borderRadius, s.borderTopWidth, s.borderTopStyle]; })()`);
    assert.deepEqual(frame, ["40px", "40px", "8px", "1px", "solid"], who);
  }

  // Many finished sessions whose titles wrap differently: every page fits the window, Older
  // always moves forward, Newer comes back to the same rows
  const manyRoot = path.join(tmp, "many");
  const manyNow = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 40; i++) {
    const long = i % 3 === 0 ? " Then explain how the invented workspace settings interact with the invented global defaults across every skill." : "";
    writeSession(path.join(manyRoot, "atlas", ".cross-review", "sessions"), `review-impl-20261015-${String(400 + i).padStart(3, "0")}`, {
      skill: "review-impl", mode: "branch", created: manyNow - 1000 - i * 60, meta: "APPROVE",
      inputs: [`## USER_REQUEST\nInvented request number ${i}.${long}\n`],
      rounds: [{ status: "completed", started: manyNow - 1000 - i * 60, elapsed: 1, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented approval.\n" }],
    });
  }
  const d3 = await startDashboard({ root: manyRoot, port: 0, open: false, discoveryFile: null, catalog });
  const many = await browser.newPage(1400, 1200);
  try {
    await many.goto(`${d3.url}#/`);
    await many.waitFor(`/ of 40/.test(document.getElementById("h-pager").textContent)`);
    const pageOf = () => many.evaluate(`({
      range: document.getElementById("h-pager").querySelector("span").textContent,
      scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      older: !document.querySelector('#h-pager a[data-hpage="1"]').classList.contains("off"),
    })`);
    const seen = [];
    for (let guard = 0; guard < 40; guard++) {
      const p = await pageOf();
      assert.equal(p.scrolls, false, `page ${p.range} fits the window`);
      const [from, to] = p.range.replace(/ of 40$/, "").split("–").map(Number);
      assert.equal(from, seen.length ? seen[seen.length - 1][1] + 1 : 1, `pages continue: ${JSON.stringify(seen)} then ${p.range}`);
      seen.push([from, to]);
      if (!p.older) break;
      await many.evaluate(`document.querySelector('#h-pager a[data-hpage="1"]').click()`);
    }
    assert.equal(seen[seen.length - 1][1], 40);
    assert.ok(seen.length >= 3, JSON.stringify(seen));
    await many.evaluate(`document.querySelector('#h-pager a[data-hpage="-1"]').click()`);
    const back = await pageOf();
    assert.equal(back.range, `${seen[seen.length - 2][0]}–${seen[seen.length - 2][1]} of 40`);
  } finally {
    await d3.close();
  }

  // Odd names from session data: a caller with a blank name and title falls back to "AG"; a
  // caller named "constructor" and a workspace named "__proto__" are plain keys, not
  // properties every object inherits
  const blankRoot = path.join(tmp, "blank");
  for (const [ws, id, caller] of [["quill", "review-impl-20261015-500", { name: "  ", title: "   ", version: "1.0.0" }], ["__proto__", "review-impl-20261015-501", { name: "constructor", title: "Invented Agent", version: "1.0.0" }]]) writeSession(path.join(blankRoot, ws, ".cross-review", "sessions"), id, {
    skill: "review-impl", mode: "branch", created: manyNow - 600, meta: "APPROVE",
    state: { caller },
    inputs: ["## USER_REQUEST\nInvented request with a blank caller.\n", "## FIXED_ITEMS\nISSUE-1: Invented defect — fixed in src/a.js:1\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n"],
    rounds: [
      { status: "completed", started: manyNow - 600, elapsed: 1, review: "### ISSUE-1: Invented defect\n- Category: bug\n- Severity: low\n- Location: `src/a.js:1`\n- Problem: Invented.\n- Suggested fix: Invented.\n\n### VERDICT\n- Status: REVISE\n- Reason: Invented.\n" },
      { status: "completed", started: manyNow - 300, elapsed: 1, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented approval.\n" },
    ],
  });
  // A session without stored inputs (no ask, no replies): each reviewer round still gets its
  // own label, newest on top
  writeSession(path.join(blankRoot, "quill", ".cross-review", "sessions"), "review-impl-20261015-502", {
    skill: "review-impl", mode: "branch", created: manyNow - 900, meta: "APPROVE",
    state: { caller: { name: "  ", title: "   ", version: "1.0.0" } },
    rounds: [
      { status: "completed", started: manyNow - 900, elapsed: 1, review: "### ISSUE-1: Invented defect\n- Category: bug\n- Severity: low\n- Location: `src/a.js:1`\n- Problem: Invented.\n- Suggested fix: Invented.\n\n### VERDICT\n- Status: REVISE\n- Reason: Invented.\n" },
      { status: "completed", started: manyNow - 800, elapsed: 1, review: "### ISSUE-2: Another invented defect\n- Category: bug\n- Severity: low\n- Location: `src/b.js:2`\n- Problem: Invented.\n- Suggested fix: Invented.\n\n### VERDICT\n- Status: REVISE\n- Reason: Invented.\n" },
      { status: "completed", started: manyNow - 700, elapsed: 1, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented approval.\n" },
    ],
  });
  const d4 = await startDashboard({ root: blankRoot, port: 0, open: false, discoveryFile: null, catalog });
  const blank = await browser.newPage(1400, 900);
  try {
    await blank.goto(`${d4.url}#/s/quill/review-impl-20261015-500`);
    await blank.waitFor(`document.querySelectorAll("#thread .m").length > 0 && document.querySelector("#thread .mark.ag")`);
    assert.equal(await blank.evaluate(`document.querySelector("#thread .mark.ag img").alt`), "AG");
    await blank.evaluate(`location.hash = "#/s/quill/review-impl-20261015-502"`);
    await blank.waitFor(`document.querySelectorAll("#thread .m").length === 3`);
    assert.deepEqual(await blank.evaluate(`[...document.querySelectorAll("#thread .round-label")].map(e => e.textContent)`), ["ROUND 3", "ROUND 2", "ROUND 1"]);
    await blank.evaluate(`location.hash = "#/s/__proto__/review-impl-20261015-501"`);
    await blank.waitFor(`document.querySelector("#thread .mark.ag img")?.alt === "I"`);
    await blank.evaluate(`location.hash = "#/settings"`);
    await blank.waitFor(`document.querySelectorAll("#avatars tr").length === 4`);
    assert.deepEqual(await blank.evaluate(`[...document.querySelectorAll("#avatars tr")].slice(2).map(tr => tr.querySelector("img").alt).sort()`), ["AG", "I"]);
    fs.writeFileSync(path.join(blankRoot, "__proto__", ".cross-review", "config.json"), JSON.stringify({ effort: "low" }));
    await blank.evaluate(`location.hash = "#/settings/__proto__"`);
    await blank.waitFor(`document.getElementById("preview-title").textContent === "Show __proto__/.cross-review/config.json"`);
    assert.equal(await blank.evaluate(`document.getElementById("settings-error").textContent`), "");
    assert.match(await blank.evaluate(`document.getElementById("preview").textContent`), /"effort": "low"/);
    // A broken file shows its error until a save replaces it
    const quillFile = path.join(blankRoot, "quill", ".cross-review", "config.json");
    fs.writeFileSync(quillFile, "{ broken");
    await blank.evaluate(`location.hash = "#/settings/quill"`);
    await blank.waitFor(`document.getElementById("preview-title").textContent === "Show quill/.cross-review/config.json"`);
    assert.match(await blank.evaluate(`document.getElementById("settings-error").textContent`), /not valid JSON/);
    await blank.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    for (let i = 0; i < 50 && fs.readFileSync(quillFile, "utf8").includes("broken"); i++) await new Promise(r => setTimeout(r, 100));
    await blank.waitFor(SAVED);
    assert.deepEqual(JSON.parse(fs.readFileSync(quillFile, "utf8")), { effort: "low" });
    assert.equal(await blank.evaluate(`document.getElementById("settings-error").textContent`), "");
  } finally {
    await d4.close();
  }

  // Nothing in progress: the words alone
  const empty = await browser.newPage(1400, 900);
  const emptyRoot = path.join(tmp, "empty");
  fs.mkdirSync(path.join(emptyRoot, ".cross-review", "sessions"), { recursive: true });
  const d2 = await startDashboard({ root: emptyRoot, port: 0, open: false, discoveryFile: null, catalog });
  try {
    await empty.goto(`${d2.url}#/`);
    await empty.waitFor(`document.querySelector("#active .empty-state")`);
    assert.equal(await empty.evaluate(`document.querySelector("#active .empty-state").textContent.trim()`), "Nothing in progress.");
    assert.equal(await empty.evaluate(`document.querySelectorAll("#active .empty-state img").length`), 0, "the words alone, no pictures");
  } finally {
    await d2.close();
  }

  await settingsAtOnceChecks(browser);
  await otherModelChecks(browser);
  await updateChecks(browser);

  await plansChecks(browser);

  console.log(`dashboard-ui: ok (${dom.active.length} in progress, ${dom.history} of ${sessions.history.length} in history on the first page)`);
  console.log(`screenshots: ${shots}`);
} finally {
  await browser.close();
  await d.close();
  // Chrome helpers can still be writing into the profile for a moment after the kill
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------- Settings without waiting ----------

/**
 * Settings show at once: from the model list an earlier run saved while the reviewer is asked
 * again, and on a later visit from what the page loaded before; what the server answers then
 * replaces every field the user did not touch.
 */
async function settingsAtOnceChecks(browser) {
  const cacheFile = path.join(tmp, "models-cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: "model-old", name: "Model Old", description: "An invented saved model.", efforts: ["high"] }], reviewer: { version: "codex-cli 9.9.8-invented", loggedIn: true }, fetchedAt: Math.floor(Date.now() / 1000) - 3600 }));
  let release;
  const slow = { ...catalog, listModels: () => new Promise(r => { release = () => r(catalog.listModels()); }) };
  const d8 = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: slow, catalogCache: cacheFile });
  const options = `[...document.querySelectorAll("#f-model-set option")].map(o => o.textContent)`;
  const holdLoad = `(() => {
    const native = window.fetch;
    window.fetch = async (...args) => {
      const res = await native(...args);
      if (args[0] === "/api/settings" && !args[1] && !window.held) {
        window.held = true;
        await new Promise(r => { window.releaseLoad = r; });
      }
      return res;
    };
  })()`;
  const page = await browser.newPage(1400, 1000);
  try {
    // The saved list shows while Codex is still being asked; a field touched meanwhile stays
    await page.goto(`${d8.url}#/settings`);
    await page.waitFor(`${options}.includes("Model Old")`);
    assert.equal(await page.evaluate(`document.getElementById("reviewer-help").textContent`), "codex-cli 9.9.8-invented, signed in");
    await page.evaluate(`(() => { const f = document.getElementById("f-showplans"); f.value = "on"; f.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    release();
    await page.waitFor(`${options}.includes("Model A")`);
    assert.equal((await page.evaluate(options)).includes("Model Old"), false);
    assert.equal(await page.evaluate(`document.getElementById("reviewer-help").textContent`), "codex-cli 9.9.9-invented, signed in");
    assert.equal(await page.evaluate(`document.getElementById("f-showplans").value`), "on");
    assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"open_plans": true/);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).models[0].slug, "model-a", "the new list replaced the saved one");

    // A new page loads Settings in the background, so Settings opens filled in before its own
    // load answers; that answer then brings a change made outside the page, and keeps the
    // field touched meanwhile
    const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
    const before = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    const fresh = await browser.newPage(1400, 1000);
    try {
      await fresh.goto(`${d8.url}#/`);
      await fresh.waitFor(`performance.getEntriesByType("resource").some(e => e.name.endsWith("/api/settings") && e.responseEnd > 0)`);
      fs.writeFileSync(globalFile, JSON.stringify({ ...before, effort: "xhigh" }));
      await fresh.evaluate(holdLoad);
      await fresh.evaluate(`location.hash = "#/settings"`);
      await fresh.waitFor(`typeof window.releaseLoad === "function"`);
      assert.equal(await fresh.evaluate(`document.querySelectorAll("#per-skill tr").length`), 4, "the form is filled while the load is held");
      assert.equal(await fresh.evaluate(`document.getElementById("preview-title").textContent`), "Show ~/.cross-review/config.json");
      assert.match(await fresh.evaluate(`document.getElementById("preview").textContent`), new RegExp(`"effort": "${before.effort}"`));
      assert.ok(await fresh.evaluate(`${options}.includes("Model A")`));
      await fresh.evaluate(`(() => { const f = document.getElementById("f-showplans"); f.value = "on"; f.dispatchEvent(new Event("change", { bubbles: true })); window.releaseLoad(); })()`);
      await fresh.waitFor(`/"effort": "xhigh"/.test(document.getElementById("preview").textContent)`);
      assert.equal(await fresh.evaluate(`document.getElementById("f-showplans").value`), "on");
      assert.match(await fresh.evaluate(`document.getElementById("preview").textContent`), /"open_plans": true/);
    } finally {
      fs.writeFileSync(globalFile, JSON.stringify(before));
    }

    // A save made while the page's own load is held: the load that answers afterwards predates
    // the save, so it is asked again and the saved value stays
    try {
      await page.evaluate(`location.hash = "#/"`);
      await page.waitFor(`document.getElementById("sessions").classList.contains("on")`);
      await page.evaluate(holdLoad);
      await page.evaluate(`location.hash = "#/settings"`);
      await page.waitFor(`typeof window.releaseLoad === "function"`);
      await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(globalFile, "utf8")).effort !== "low"; i++) await new Promise(r => setTimeout(r, 100));
      await page.waitFor(SAVED);
      await page.evaluate(`(async () => { window.releaseLoad(); await new Promise(r => setTimeout(r, 400)); })()`);
      assert.equal(await page.evaluate(`document.getElementById("f-effort-set").value`), "low");
      assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"effort": "low"/);
    } finally {
      fs.writeFileSync(globalFile, JSON.stringify(before));
    }
  } finally {
    await d8.close();
  }

  // A session page opened first names its model once the background load and the reviewer's
  // new list arrive
  let release2;
  const slow2 = { ...catalog, listModels: () => new Promise(r => { release2 = () => r(catalog.listModels()); }) };
  fs.writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: "model-old", name: "Model Old", description: "An invented saved model.", efforts: ["high"] }], reviewer: null, fetchedAt: 1000 }));
  const d9 = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog: slow2, catalogCache: cacheFile });
  try {
    const id = path.basename(fx.sessions.waiting);
    const ws = encodeURIComponent(path.relative(root, path.dirname(path.dirname(path.dirname(fx.sessions.waiting)))));
    const detail = await browser.newPage(1400, 1000);
    await detail.goto(`${d9.url}#/s/${ws}/${id}`);
    await detail.waitFor(`/^model-a · /.test(document.getElementById("f-model").textContent)`);
    release2();
    await detail.waitFor(`/^Model A · /.test(document.getElementById("f-model").textContent)`);
  } finally {
    await d9.close();
  }
}

/** A model name typed under Other… stays while an earlier change finishes saving, and saves when the field is left. */
async function otherModelChecks(browser) {
  const otherRoot = path.join(tmp, "other");
  fs.mkdirSync(path.join(otherRoot, ".cross-review", "sessions"), { recursive: true });
  const d10 = await startDashboard({ root: otherRoot, port: 0, open: false, discoveryFile: null, catalog: { ...catalog, listModels: async () => null } });
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  const before = fs.readFileSync(globalFile, "utf8");
  const page = await browser.newPage(1400, 1000);
  try {
    await page.goto(`${d10.url}#/settings`);
    await page.waitFor(`[...document.querySelectorAll("#f-model-set option")].some(o => o.value === "__other__")`);
    await page.evaluate(`(() => {
      const native = window.fetch;
      window.fetch = async (...args) => {
        const res = await native(...args);
        if (args[0] === "/api/settings" && args[1] && args[1].method === "POST" && !window.held) {
          window.held = true;
          await new Promise(r => { window.releaseSave = r; });
        }
        return res;
      };
      const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true }));
      const m = document.getElementById("f-model-set"); m.value = "__other__"; m.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("f-model-other").value = "model-half";
    })()`);
    await page.waitFor(`typeof window.releaseSave === "function"`);
    await page.evaluate(`window.releaseSave()`);
    await page.waitFor(SAVED);
    const other = await page.evaluate(`(() => { const o = document.getElementById("f-model-other"); return { on: o.classList.contains("on"), value: o.value, focused: document.activeElement === o }; })()`);
    assert.deepEqual(other, { on: true, value: "model-half", focused: true });
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).model, undefined, "the half-typed name is not saved");
    await page.evaluate(`(() => { const o = document.getElementById("f-model-other"); o.value = "model-whole"; o.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await page.waitFor(SAVED);
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).model, "model-whole");
  } finally {
    fs.writeFileSync(globalFile, before);
    await d10.close();
  }
}

/** Check for updates: the footer link, Settings' Check now, and the global tick. */
async function updateChecks(browser) {
  const updRoot = path.join(tmp, "updates");
  fs.mkdirSync(path.join(updRoot, "quarry", ".cross-review", "sessions"), { recursive: true });
  let answer;
  const latestVersion = () => new Promise(r => { answer = r; });
  const d11 = await startDashboard({ root: updRoot, port: 0, open: false, discoveryFile: null, catalog, latestVersion, updateCache: path.join(tmp, "update-cache.json") });
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  const before = fs.readFileSync(globalFile, "utf8");
  const page = await browser.newPage(1400, 1000);
  const help = () => page.evaluate(`document.getElementById("update-help").textContent`);
  try {
    await page.goto(`${d11.url}#/settings`);
    await page.waitFor(`document.getElementById("updates-block").classList.contains("on") && /Not checked yet/.test(document.getElementById("update-help").textContent)`);
    assert.equal(await page.evaluate(`document.getElementById("f-updates").checked`), false, "off by default");
    assert.equal(await page.evaluate(`document.getElementById("update-link").textContent`), "Update");
    // Check now: Checking… while GitHub is asked, then the newer version, here and in the footer
    await page.evaluate(`document.getElementById("check-update").click()`);
    await page.waitFor(`document.getElementById("update-help").textContent === "Checking…" && document.getElementById("check-update").disabled`);
    answer("99.0.0");
    await page.waitFor(`/Version 99\\.0\\.0 is out/.test(document.getElementById("update-help").textContent)`);
    assert.match(await help(), /you have \d+\.\d+\.\d+\. Run npx github:lploc94\/cross-review to update\.$/);
    assert.deepEqual(await page.evaluate(`(() => { const a = document.getElementById("update-link"); return [a.textContent, a.classList.contains("new")]; })()`), ["Update available: 99.0.0", true]);
    await page.screenshot(path.join(shots, "settings-updates-1400.png"));
    // the tick saves to the global file; a workspace has no Updates block
    await page.evaluate(`(() => { const c = document.getElementById("f-updates"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await page.waitFor(SAVED);
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).check_updates, true);
    await page.evaluate(`location.hash = "#/settings/quarry"`);
    await page.waitFor(`document.getElementById("preview-title").textContent === "Show quarry/.cross-review/config.json"`);
    assert.equal(await page.evaluate(`document.getElementById("updates-block").classList.contains("on")`), false);
    // another page opened later shows the kept answer in its footer at once
    const other = await browser.newPage(1400, 900);
    await other.goto(`${d11.url}#/`);
    await other.waitFor(`document.getElementById("update-link").textContent === "Update available: 99.0.0"`);
  } finally {
    fs.writeFileSync(globalFile, before);
    await d11.close();
  }
}

// ---------- Plans (dashboard-plans plan, Phase 4) ----------

async function plansChecks(browser) {
  const GIT_ENV = { GIT_AUTHOR_NAME: "Invented", GIT_AUTHOR_EMAIL: "invented@example.invalid", GIT_COMMITTER_NAME: "Invented", GIT_COMMITTER_EMAIL: "invented@example.invalid" };
  const git = (ws, ...args) => {
    const r = spawnSync("git", ["-C", ws, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // scrolled to the element, or as far as the page goes
  const reached = id => `(Math.abs(document.getElementById("${id}").getBoundingClientRect().top) < 40 || (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2))`;
  const t = Math.floor(Date.now() / 1000);
  const planRoot = path.join(tmp, "plans");
  const pfx = buildFixture(planRoot, { now: t, livePid: process.pid });
  const ppl = buildPlans(pfx);
  const { harbor, orchard, inkwell } = pfx.workspaces;
  // harbor: a repo that keeps its plans, with phase 1's commit; orchard: a repo that ignores them
  git(harbor, "init", "-q");
  git(harbor, "commit", "-q", "--allow-empty", "-m", "feat(export): one row model behind CSV and JSON");
  const sha1 = git(harbor, "log", "-1", "--format=%h");
  git(orchard, "init", "-q");
  fs.writeFileSync(path.join(orchard, ".cross-review", ".gitignore"), "*\n");
  // the checkpoint session the Progress Log names
  writeSession(path.join(harbor, ".cross-review", "sessions"), "review-impl-20261013-004", {
    skill: "review-impl", mode: "branch", created: t - 9000, meta: "APPROVE", state: { ended_at: t - 8000, end_outcome: "finalized" },
    inputs: ["BASE_BRANCH: a1b2c3d\n\n## USER_REQUEST\nInvented checkpoint after phase 1.\n"],
    rounds: [{ status: "completed", started: t - 9000, elapsed: 60, review: "### VERDICT\n- Status: APPROVE\n- Reason: Invented.\n", acts: [] }],
  });
  // fallback documents: one with an intro, a table and two sections; one without a title
  const notes = writePlan(pl(ppl), "notes.md", "# Sync notes\n\nAn invented opening line.\n\n## Options\n\n| Option | Cost |\n|---|---|\n| Merge | A diff |\n\n## Open questions\n\n- Tombstones?\n");
  writePlan(pl(ppl), "untitled.md", "Only a line of invented text.\n");
  function pl(x) {
    return x.atlas;
  }
  const d5 = await startDashboard({ root: planRoot, port: 0, open: false, discoveryFile: null, catalog, tickMs: 300, rescanMs: 1000 });
  const page = await browser.newPage(1400, 1300);
  try {
    const api = async p => (await fetch(`http://127.0.0.1:${d5.port}${p}`, { headers: { Authorization: `Bearer ${d5.token}` } })).json();
    const list = await api("/api/sessions");
    await page.goto(`${d5.url}#/plans`);
    await page.waitFor(`document.getElementById("plans").classList.contains("on") && document.querySelectorAll("#plan-list tr[data-go]").length > 0`);
    assert.equal(await page.evaluate(`document.querySelector('.top nav a.on').dataset.nav`), "plans");
    const rows = await page.evaluate(`[...document.querySelectorAll("#plan-list tr[data-go]")].map(tr => ({
      go: tr.dataset.go, st: tr.querySelector(".st").textContent.trim(), plan: tr.cells[1].textContent, prog: tr.cells[2].textContent,
      bars: tr.querySelectorAll(".pbar i").length, done: tr.querySelectorAll(".pbar i.done").length, part: [...tr.querySelectorAll(".pbar i.part")].map(i => i.style.getPropertyValue("--p")),
      review: tr.cells[3].textContent,
    }))`);
    assert.equal(rows.length, list.plans.length);
    const row = file => rows.find(r => r.go.endsWith(`/${encodeURIComponent(file)}`));
    const ex = row("export-formats-plan.md");
    assert.equal(ex.st, "phase 3 of 5");
    assert.deepEqual([ex.bars, ex.done, ex.part], [5, 2, ["50%"]]);
    assert.match(ex.prog, /2 of 5 phases · 9 of 16 criteria/);
    assert.match(ex.plan, /harbor-app · export-formats-plan\.md · in git/);
    assert.match(ex.review, /approved.*review-plan-20261012-002/);
    assert.equal(row("shared-notebooks-plan.md").st, "ready to start");
    assert.match(row("shared-notebooks-plan.md").plan, /local only/);
    assert.match(row("shared-notebooks-plan.md").prog, /2 phases · not started/);
    assert.match(row("shared-notebooks-plan.md").review, /approved by you.*14 Oct/);
    assert.equal(row("sync-offline-plan.md").st, "draft");
    assert.match(row("sync-offline-plan.md").review, /not reviewed/);
    assert.equal(row("search-by-date-plan.md").st, "done");
    assert.match(row("search-by-date-plan.md").plan, /no git/);
    const doc = row("sync notes.md");
    assert.equal(doc.st, "document");
    assert.match(doc.prog, /—\s*not a loop-plan file/);
    assert.equal(doc.review.trim(), "—");
    assert.equal(row("notes.md").st, "document");
    // filters: state, and words only in the Target, only in a phase name, only in a document's body
    const count = async (state, q) => page.evaluate(`(() => {
      const s = document.getElementById("pf-state"); s.value = ${JSON.stringify(state)}; s.dispatchEvent(new Event("change"));
      const q = document.getElementById("pf-search"); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event("input"));
      return [...document.querySelectorAll("#plan-list tr[data-go]")].map(tr => decodeURIComponent(tr.dataset.go.split("/").pop()));
    })()`);
    assert.deepEqual(await count("done", ""), ["search-by-date-plan.md"]);
    assert.deepEqual((await count("doc", "")).sort(), ["notes.md", "sync notes.md", "untitled.md"]);
    assert.deepEqual(await count("", "toolbar"), ["export-formats-plan.md"]);
    assert.deepEqual(await count("", "streaming"), ["export-formats-plan.md"]);
    assert.deepEqual(await count("", "paragraph"), ["sync notes.md"]);
    await count("", "");
    await page.screenshot(path.join(shots, "plans-1400.png"));

    // a row opens its plan; the Plans tab stays lit
    await page.evaluate(`document.querySelector('#plan-list tr[data-go$="export-formats-plan.md"] td').click()`);
    await page.waitFor(`location.hash === "#/p/harbor-app/export-formats-plan.md" && document.querySelector("#phases .phase")`);
    assert.equal(await page.evaluate(`document.querySelector('.top nav a.on').dataset.nav`), "plans");
    const exportText = fs.readFileSync(ppl.files.progress, "utf8");
    const metInFile = parsePlan(exportText).phases.reduce((n, p) => n + p.acs.filter(a => a.met).length, 0);
    const prog = await page.evaluate(`({
      title: document.getElementById("p-title").textContent, status: document.getElementById("p-status").className,
      what: document.querySelector("#p-status .what").textContent.trim(), target: document.getElementById("p-target").textContent,
      open: [...document.querySelectorAll("#phases .phase.open")].map(p => p.dataset.phase), met: document.querySelectorAll("#phases li.met").length,
      steps: document.querySelectorAll("#p-steps .s[data-jump]").length,
      foot1: document.querySelector('#phases .phase[data-phase="1"] .ph-foot').textContent, foot3: document.querySelector('#phases .phase[data-phase="3"] .ph-foot').textContent,
      log: [...document.querySelectorAll("#plog > div")].map(e => ({ d: e.querySelector(".d")?.textContent || "", k: e.querySelector(".k")?.className || "" })),
      link: document.querySelector('#plog a[href="#/s/harbor-app/review-impl-20261013-004"]')?.textContent,
      acs: document.getElementById("p-acs").textContent, git: document.getElementById("p-git").textContent,
      doneWhen: document.querySelectorAll("#p-done li").length,
    })`);
    assert.equal(prog.title, "CSV and JSON export");
    assert.equal(prog.status, "status progress");
    assert.match(prog.what, /^Phase 3 of 5 — Streaming large exports: 2 of 4 criteria met\.$/);
    assert.match(prog.target, /toolbar/);
    assert.deepEqual(prog.open, ["3"]);
    assert.equal(prog.met, metInFile);
    assert.equal(prog.steps, 5);
    assert.match(prog.foot1, new RegExp(`commit ${sha1}`));
    assert.match(prog.foot1, /review-impl-20261013-004/);
    assert.doesNotMatch(prog.foot3, /commit/);
    assert.equal(prog.log[0].d, "15 Oct");
    assert.ok(prog.log.some(l => /decision/.test(l.k)) && prog.log.some(l => /discovery/.test(l.k)));
    assert.equal(prog.link, "review-impl-20261013-004");
    assert.equal(prog.acs, `${metInFile} of 16 met`);
    assert.match(prog.git, /in git/);
    assert.equal(prog.doneWhen, 2);
    // the phase strip jumps to its phase; a closed phase opens on click
    await page.evaluate(`document.querySelector('#p-steps .s[data-jump="ph5"]').click()`);
    await page.waitFor(reached("ph5"));
    await page.evaluate(`document.querySelector('#phases .phase[data-phase="1"] .ph-head').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#phases .phase[data-phase="1"]').classList.contains("open")`), true);
    await page.screenshot(path.join(shots, "plan-progress-1400.png"));

    // live: tick AC-3.3 on disk; the tab, the open phases and the scroll stay
    await page.evaluate(`window.scrollTo(0, 260)`);
    await sleep(800);
    const y = await page.evaluate(`window.scrollY`);
    assert.ok(y > 0);
    fs.writeFileSync(ppl.files.progress, exportText.replace("- [ ] AC-3.3", "- [x] AC-3.3"));
    await page.waitFor(`document.getElementById("p-acs").textContent === "${metInFile + 1} of 16 met"`);
    assert.deepEqual(await page.evaluate(`({ open: [...document.querySelectorAll("#phases .phase.open")].map(p => p.dataset.phase), tab: document.querySelector(".ptabs a.on").dataset.ptab, y: window.scrollY })`),
      { open: ["1", "3"], tab: "progress", y });
    // live: phase 3 completes and its checkpoint asks for changes; phase 3 stays open, phase 4 opens as the new current one
    writeSession(path.join(harbor, ".cross-review", "sessions"), "review-impl-20261016-007", {
      skill: "review-impl", mode: "branch", created: t - 600, inputs: ["BASE_BRANCH: a1b2c3d\n\n## USER_REQUEST\nInvented checkpoint after phase 3.\n"],
      rounds: [{ status: "completed", started: t - 600, elapsed: 60, review: "### VERDICT\n- Status: REVISE\n- Reason: Invented.\n", acts: [] }],
    });
    fs.writeFileSync(ppl.files.progress, `${exportText.replace("- [ ] AC-3.3", "- [x] AC-3.3").replace("- [ ] AC-3.4", "- [x] AC-3.4").trimEnd()}\n- 2026-10-16 Phase 3 checkpoint: review-impl-20261016-007 asked for changes.\n`);
    await page.waitFor(`document.getElementById("p-acs").textContent === "${metInFile + 2} of 16 met" && /review-impl-20261016-007/.test(document.querySelector('#phases .phase[data-phase="3"] .ph-foot').textContent)`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll("#phases .phase.open")].map(p => p.dataset.phase)`), ["1", "3", "4"]);
    assert.match(await page.evaluate(`document.querySelector('#phases .phase[data-phase="3"] .ph-foot').textContent`), /^Checkpoint: review-impl · agent's turn · changes asked · review-impl-20261016-007/);
    assert.match(prog.foot1, /^Checkpoint: review-impl · approved · review-impl-20261013-004/, "an approved checkpoint says it once");

    // the Plan tab: every H2 in order, contents, "read phase N", and the /plan route
    await page.evaluate(`document.querySelector('.ptabs a[data-ptab="doc"]').click()`);
    const sections = parsePlan(fs.readFileSync(ppl.files.progress, "utf8")).sections.filter(x => x.title);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll("#doc h2")].map(h => h.textContent)`), sections.map(x => x.title));
    assert.equal(await page.evaluate(`document.querySelectorAll("#toc a").length`), sections.length);
    assert.equal(await page.evaluate(`document.querySelectorAll("#toc a.sub").length`), 5);
    await page.evaluate(`document.querySelector('#toc a[data-toc="d-capacity"]').click()`);
    await page.waitFor(reached("d-capacity"));
    await page.screenshot(path.join(shots, "plan-doc-1400.png"));
    await page.evaluate(`document.querySelector('.ptabs a[data-ptab="progress"]').click()`);
    await page.evaluate(`document.querySelector('#phases .phase[data-phase="3"] [data-read]').click()`);
    await page.waitFor(`document.querySelector(".ptabs a.on").dataset.ptab === "doc" && location.hash.endsWith("/plan") && ${reached("d-phase-3")}`);
    await page.evaluate(`location.hash = "#/p/inkwell/search-by-date-plan.md/plan"`);
    await page.waitFor(`document.getElementById("p-title").textContent === "Search by date" && document.querySelector(".ptabs a.on").dataset.ptab === "doc" && document.querySelector("#doc h2")`);

    // live with the file unchanged: a review-plan session on the draft plan, round 1 → 2 → ended
    await page.evaluate(`location.hash = "#/p/harbor-app/sync-offline-plan.md"`);
    await page.waitFor(`document.getElementById("p-title").textContent === "Offline drafts" && document.getElementById("p-status").className === "status draft"`);
    await page.evaluate(`document.querySelector('.ptabs a[data-ptab="doc"]').click(); window.scrollTo(0, 200)`);
    // a smooth scroll from the steps before can still land; the mark is where the page settles
    await sleep(800);
    const y2 = await page.evaluate(`window.scrollY`);
    assert.ok(y2 > 0);
    const review = (rounds, end) => writeSession(path.join(harbor, ".cross-review", "sessions"), "review-plan-20261016-009", {
      skill: "review-plan", created: t - 300, inputs: [`PLAN_PATH: ${ppl.files.draft}\n`],
      state: { pid: process.pid, pgid: process.pid, ...(end ? { ended_at: Math.floor(Date.now() / 1000), end_outcome: "finalized" } : {}) }, meta: end ? "REVISE" : null,
      rounds: Array.from({ length: rounds }, (_, i) => (i === rounds - 1 && !end
        ? { status: "running", started: t - 60, elapsed: 0, acts: [] }
        : { status: "completed", started: t - 300 + i * 60, elapsed: 30, review: "### VERDICT\n- Status: REVISE\n- Reason: Invented.\n", acts: [] })),
    });
    review(1, false);
    await page.waitFor(`document.getElementById("p-status").className === "status running" && /round 1/.test(document.getElementById("p-review").textContent)`);
    review(2, false);
    await page.waitFor(`/round 2/.test(document.getElementById("p-review").textContent)`);
    review(2, true);
    await page.waitFor(`document.getElementById("p-status").className === "status draft"`);
    assert.deepEqual(await page.evaluate(`({ tab: document.querySelector(".ptabs a.on").dataset.ptab, y: window.scrollY })`), { tab: "doc", y: y2 });

    // fallback documents
    await page.evaluate(`location.hash = "#/p/atlas-notes/notes.md"`);
    await page.waitFor(`document.getElementById("p-title").textContent === "Sync notes" && document.getElementById("plan").classList.contains("fallback")`);
    const fb = await page.evaluate(`({
      tabs: getComputedStyle(document.querySelector(".ptabs")).display, target: getComputedStyle(document.getElementById("p-target")).display,
      note: !document.getElementById("p-note").hidden, kind: document.getElementById("p-kind").textContent,
      first: document.querySelector("#doc").firstElementChild.tagName, intro: document.querySelector("#doc p").textContent,
      h2: [...document.querySelectorAll("#doc h2")].map(h => h.textContent), toc: document.querySelectorAll("#toc a").length, table: !!document.querySelector("#doc table"),
    })`);
    assert.deepEqual(fb, { tabs: "none", target: "none", note: true, kind: "markdown", first: "P", intro: "An invented opening line.", h2: ["Options", "Open questions"], toc: 2, table: true });
    await page.screenshot(path.join(shots, "plan-fallback-1400.png"));
    await page.evaluate(`location.hash = "#/p/atlas-notes/untitled.md/plan"`);
    await page.waitFor(`document.getElementById("p-title").textContent === "untitled.md"`);
    await page.evaluate(`location.hash = "#/p/atlas-notes/notes.md"`);
    await page.waitFor(`document.getElementById("p-title").textContent === "Sync notes"`);
    fs.appendFileSync(notes, "\n## Plan schema\nloop-plan/v1\n\n## Phase 1: Write it down\n### Acceptance criteria\n- [ ] AC-1.1: The notes exist\n");
    await page.waitFor(`!document.getElementById("plan").classList.contains("fallback") && getComputedStyle(document.querySelector(".ptabs")).display !== "none" && document.querySelector("#phases .phase")`);
    // a plan that disappears, and a plan that never existed
    fs.rmSync(notes);
    await page.waitFor(`!document.getElementById("p-gone").hidden && document.getElementById("p-body").hidden`);
    assert.match(await page.evaluate(`document.getElementById("p-gone").textContent`), /^This plan is no longer in \.cross-review\/plans\/\. Back to Plans$/);
    await page.evaluate(`location.hash = "#/p/atlas-notes/never-plan.md"`);
    await page.waitFor(`location.hash === "#/plans"`);

    // no inline style but --p
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll("[style]")].map(e => e.getAttribute("style")).filter(s => !/^--p: ?[0-9]+%;?$/.test(s))`), []);

    // Settings: Plans in git and Follow plans
    fs.writeFileSync(path.join(orchard, ".cross-review", ".gitignore"), "custom\n");
    git(inkwell, "init", "-q");
    fs.writeFileSync(path.join(inkwell, ".gitignore"), ".cross-review/\n");
    await page.evaluate(`location.hash = "#/settings"`);
    await page.waitFor(`document.getElementById("preview-title").textContent === "Show ~/.cross-review/config.json" && document.getElementById("f-plans").options.length === 2`);
    await page.evaluate(`(() => {
      for (const [id, v] of [["f-plans", "on"], ["f-showplans", "on"]]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); }
    })()`);
    await page.waitFor(`/edited by hand/.test(document.getElementById("plans-warn").textContent)`);
    const warn = await page.evaluate(`document.getElementById("plans-warn").textContent`);
    assert.match(warn, /services\/orchard-api|orchard-api/);
    assert.match(warn, /\.gitignore:1:\.cross-review\/.*Change it to \.cross-review\/\* and add !\.cross-review\/plans\//);
    const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
    const saved = JSON.parse(fs.readFileSync(globalFile, "utf8"));
    assert.deepEqual([saved.open_plans, saved.track_plans], [true, true]);
    assert.equal(fs.readFileSync(path.join(harbor, ".cross-review", ".gitignore"), "utf8"), GITIGNORE.track);
    assert.equal(fs.readFileSync(path.join(orchard, ".cross-review", ".gitignore"), "utf8"), "custom\n");
    await page.screenshot(path.join(shots, "settings-plans-1400.png"));
    // a workspace inherits; choosing On and then Inherit again removes the key from its file
    await page.evaluate(`location.hash = "#/settings/harbor-app"`);
    await page.waitFor(`document.getElementById("preview-title").textContent === "Show harbor-app/.cross-review/config.json"`);
    assert.deepEqual(await page.evaluate(`[document.getElementById("f-plans").selectedOptions[0].text, document.getElementById("f-showplans").selectedOptions[0].text]`), ["Inherit — on", "Inherit — on"]);
    const wsFile = path.join(harbor, ".cross-review", "config.json");
    const pick = async (id, v) => page.evaluate(`(() => { const s = document.getElementById("${id}"); s.value = "${v}"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await pick("f-showplans", "off");
    for (let i = 0; i < 50 && !fs.existsSync(wsFile); i++) await sleep(100);
    await page.waitFor(SAVED);
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf8")), { open_plans: false });
    await pick("f-showplans", "");
    for (let i = 0; i < 50 && fs.existsSync(wsFile); i++) await sleep(100);
    assert.equal(fs.existsSync(wsFile), false, "Inherit removes the key (and the empty file)");
    fs.rmSync(globalFile, { force: true });
  } finally {
    await d5.close();
  }

  // Thirty plans: pages fit a short window, Next and Previous; a tall window has no pager
  const manyPlans = path.join(tmp, "many-plans");
  for (let i = 0; i < 30; i++) {
    const f = writePlan(path.join(manyPlans, "atlas"), `invented-${String(i).padStart(2, "0")}-plan.md`, PLANS.draft.replace(/^# .*$/m, `# Invented plan ${i}${i % 4 === 0 ? " with a much longer title that wraps onto a second line in the plan column of the list" : ""}`));
    fs.utimesSync(f, t - i * 60, t - i * 60);
  }
  const d6 = await startDashboard({ root: manyPlans, port: 0, open: false, discoveryFile: null, catalog });
  try {
    const short = await browser.newPage(1400, 700);
    await short.goto(`${d6.url}#/plans`);
    await short.waitFor(`/ of 30/.test(document.getElementById("p-pager").textContent)`);
    const p1 = await short.evaluate(`({ rows: document.querySelectorAll("#plan-list tr[data-go]").length, pager: document.getElementById("p-pager").textContent,
      scrolls: document.documentElement.scrollHeight > window.innerHeight + 1, first: document.querySelector("#plan-list tr[data-go]").dataset.go })`);
    assert.ok(p1.rows >= 3 && p1.rows < 30, JSON.stringify(p1));
    assert.equal(p1.pager, `‹ Previous1–${p1.rows} of 30Next ›`);
    assert.equal(p1.scrolls, false);
    await short.evaluate(`document.querySelector('#p-pager a[data-ppage="1"]').click()`);
    assert.match(await short.evaluate(`document.getElementById("p-pager").textContent`), new RegExp(`^‹ Previous${p1.rows + 1}–\\d+ of 30Next ›$`));
    await short.evaluate(`document.querySelector('#p-pager a[data-ppage="-1"]').click()`);
    assert.equal(await short.evaluate(`document.querySelector("#plan-list tr[data-go]").dataset.go`), p1.first);
    const tall = await browser.newPage(1400, 4000);
    await tall.goto(`${d6.url}#/plans`);
    await tall.waitFor(`document.querySelectorAll("#plan-list tr[data-go]").length === 30`);
    assert.equal(await tall.evaluate(`document.getElementById("p-pager").textContent`), "");
  } finally {
    await d6.close();
  }

  // No plans: the empty line
  const noPlans = path.join(tmp, "no-plans");
  fs.mkdirSync(path.join(noPlans, ".cross-review", "sessions"), { recursive: true });
  const d7 = await startDashboard({ root: noPlans, port: 0, open: false, discoveryFile: null, catalog });
  try {
    const p = await browser.newPage(1400, 900);
    await p.goto(`${d7.url}#/plans`);
    await p.waitFor(`document.querySelector("#plan-list .empty")`);
    assert.equal(await p.evaluate(`document.querySelector("#plan-list .empty").textContent.trim()`), "No plans yet. loop-plan writes them to .cross-review/plans/.");
  } finally {
    await d7.close();
  }
}
