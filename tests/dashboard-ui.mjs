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

import { buildFixture } from "./helpers/dashboard-fixture.js";
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
const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null });
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

  // History: one row per finished session; filters work in the page
  assert.equal(dom.history, sessions.history.length);
  assert.equal(dom.demo, false);
  assert.equal(dom.inlineStyle, 0);
  const noReply = sessions.history.filter(s => s.label === "no reply").length;
  assert.equal(await page.evaluate(`(() => { const f = document.getElementById("f-result"); f.value = "no reply"; f.dispatchEvent(new Event("change")); return document.querySelectorAll("#history tr[data-go]").length; })()`), noReply);
  assert.equal(await page.evaluate(`(() => { document.getElementById("f-result").value = ""; const q = document.getElementById("f-search"); q.value = "Model list cached"; q.dispatchEvent(new Event("input")); return document.querySelectorAll("#history tr[data-go]").length; })()`),
    sessions.history.filter(s => s.searchText.includes("model list cached")).length);
  await page.evaluate(`(() => { const q = document.getElementById("f-search"); q.value = ""; q.dispatchEvent(new Event("input")); })()`);
  await page.screenshot(path.join(shots, "sessions-1400.png"));

  // Routes: a row opens its session with the Sessions tab lit; an unknown hash goes home
  const waitingId = path.basename(fx.sessions.waiting);
  await page.evaluate(`document.querySelector('#active tr[data-go$="${waitingId}"] td').click()`);
  await page.waitFor(`location.hash === "#/s/harbor-app/${waitingId}" && document.getElementById("detail").classList.contains("on")`);
  assert.equal(await page.evaluate(`document.querySelector('.top nav a[data-nav="sessions"]').classList.contains("on")`), true);
  await page.evaluate(`location.hash = "#/settings"`);
  await page.waitFor(`document.getElementById("settings").classList.contains("on") && document.querySelector('.top nav a.on').dataset.nav === "settings"`);
  await page.evaluate(`location.hash = "#/no/such/place"`);
  await page.waitFor(`location.hash === "#/" && document.getElementById("sessions").classList.contains("on")`);

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

  console.log(`dashboard-ui: ok (${dom.active.length} in progress, ${dom.history} in history)`);
  console.log(`screenshot: ${path.join(shots, "sessions-1400.png")}`);
} finally {
  await browser.close();
  await d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
