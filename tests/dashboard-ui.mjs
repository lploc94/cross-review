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

import { buildFixture, writeSession } from "./helpers/dashboard-fixture.js";
import { findChrome, launchChrome } from "./helpers/chrome.js";
import { startDashboard } from "../skill-packs/cross-review/scripts/lib/dashboard/server.js";

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
const browser = await launchChrome(bin, path.join(tmp, "profile"));
try {
  const sessions = await (await fetch(`http://127.0.0.1:${d.port}/api/sessions`, { headers: { Authorization: `Bearer ${d.token}` } })).json();
  const page = await browser.newPage(1400, 1300);
  await page.goto(`${d.url}#/`);
  await page.waitFor(`document.querySelectorAll("#history tr[data-go]").length > 0`);
  assert.equal(await page.evaluate("location.search"), "", "the token left the address bar");

  const dom = await page.evaluate(`(() => ({
    logo: !!document.querySelector(".top .wrap .name svg"),
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

  // header: logo, two nav entries with icons, Sessions on
  assert.ok(dom.logo, "logo icon in .name");
  assert.deepEqual(dom.nav, [{ nav: "sessions", svg: true, on: true }, { nav: "settings", svg: true, on: false }]);
  assert.match(dom.where, /scanned 3 levels down · 3 workspaces · pack \d+\.\d+\.\d+$/);

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
    save: document.getElementById("save").textContent,
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
  assert.equal(set.save, "Save global");
  assert.equal(set.avatars, true);
  assert.equal(set.model, "Codex default (Model A)");
  assert.equal(set.models, 3);
  assert.equal(set.help, "codex-cli 9.9.9-invented, signed in");
  assert.match(set.explain, /\.cross-review\/config\.json/);
  assert.equal(set.inlineStyle, 0);
  await page.screenshot(path.join(shots, "settings-1400.png"));

  // Save global: Follow reviews on, review-impl on Model B; the file holds only those
  await page.evaluate(`(() => {
    const f = document.getElementById("f-follow"); f.value = "on"; f.dispatchEvent(new Event("change", { bubbles: true }));
    const m = document.querySelector('#per-skill select[data-path="skills.review-impl.model"]'); m.value = "model-b"; m.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.match(await page.evaluate(`document.querySelectorAll("#per-skill tr")[1].textContent`), /set here[\s\S]*Model B · high/);
  await page.evaluate(`document.getElementById("save").click()`);
  const globalFile = path.join(process.env.HOME, ".cross-review", "config.json");
  for (let i = 0; i < 50 && !fs.existsSync(globalFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(globalFile, "utf8")), { open_dashboard: true, skills: { "review-impl": { model: "model-b" } } });

  // A workspace: inherits the global values, no avatars, saves to its own file
  await page.evaluate(`location.hash = "#/settings/harbor-app"`);
  await page.waitFor(`document.getElementById("save").textContent === "Save for harbor-app"`);
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
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "low"; e.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("save").click(); })()`);
  const wsFile = path.join(fx.workspaces.harbor, ".cross-review", "config.json");
  for (let i = 0; i < 50 && !fs.existsSync(wsFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf8")), { effort: "low" });
  await page.screenshot(path.join(shots, "settings-workspace-1400.png"));

  // One save at a time: a second Save while the first is in flight does nothing, and an
  // edit made meanwhile stays in the form for the next Save
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("save").textContent === "Save global"`);
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
    document.getElementById("save").click();
  })()`);
  await page.waitFor(`typeof window.releaseSave2 === "function"`);
  assert.equal(await page.evaluate(`document.getElementById("save").disabled`), true);
  await page.evaluate(`(() => { const e = document.getElementById("f-effort-set"); e.value = "xhigh"; e.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("save").click(); })()`);
  await page.evaluate(`window.releaseSave2()`);
  await page.waitFor(`!document.getElementById("save").disabled`);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "low", "only the first save was sent");
  assert.match(await page.evaluate(`document.getElementById("preview").textContent`), /"effort": "xhigh"/, "the later edit is kept");
  await page.evaluate(`document.getElementById("save").click()`);
  for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(globalFile, "utf8")).effort !== "xhigh"; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "xhigh");

  // Switching to a workspace while a global save is in flight: the answer goes to the global
  // level only, and the workspace form starts from the workspace's own (empty) file
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("save").textContent === "Save global"`);
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
    document.getElementById("save").click();
  })()`);
  await page.waitFor(`typeof window.releaseSave === "function"`);
  await page.evaluate(`location.hash = "#/settings/inkwell"`);
  await page.evaluate(`window.releaseSave()`);
  await page.waitFor(`document.getElementById("save").textContent === "Save for inkwell"`);
  await page.waitFor(`document.getElementById("preview").textContent.trim() === "{}" && document.querySelector("#f-effort-set option").textContent === "Inherit — medium"`);
  assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).effort, "medium");
  await page.evaluate(`(() => { const f = document.getElementById("f-follow"); f.value = "off"; f.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("save").click(); })()`);
  const inkFile = path.join(fx.workspaces.inkwell, ".cross-review", "config.json");
  for (let i = 0; i < 50 && !fs.existsSync(inkFile); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(inkFile, "utf8")), { open_dashboard: false });

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

  // Nothing in progress: the empty state with the full-body avatars
  const empty = await browser.newPage(1400, 900);
  const emptyRoot = path.join(tmp, "empty");
  fs.mkdirSync(path.join(emptyRoot, ".cross-review", "sessions"), { recursive: true });
  const d2 = await startDashboard({ root: emptyRoot, port: 0, open: false, discoveryFile: null });
  try {
    await empty.goto(`${d2.url}#/`);
    await empty.waitFor(`document.querySelector("#active .empty-state")`);
    assert.equal(await empty.evaluate(`document.querySelector("#active .empty-state").textContent.trim()`), "Nothing in progress.");
    assert.equal(await empty.evaluate(`[...document.querySelectorAll("#active .empty-state img")].every(i => i.complete && i.naturalWidth > 0)`), true);
  } finally {
    await d2.close();
  }

  console.log(`dashboard-ui: ok (${dom.active.length} in progress, ${dom.history} of ${sessions.history.length} in history on the first page)`);
  console.log(`screenshots: ${shots}`);
} finally {
  await browser.close();
  await d.close();
  // Chrome helpers can still be writing into the profile for a moment after the kill
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
