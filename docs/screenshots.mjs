#!/usr/bin/env node
// The README's dashboard pictures: the dashboard in headless Chrome on the invented test
// fixture (no real sessions or projects), under a temporary HOME so the path reads ~/projects.
//
//   node docs/screenshots.mjs        (CHROME=<path> to pick the browser)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFixture, buildPlans } from "../tests/helpers/dashboard-fixture.js";
import { findChrome, launchChrome } from "../tests/helpers/chrome.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "images");
const bin = findChrome();
if (!bin) {
  console.error("screenshots: no Chrome found; set CHROME=<path>");
  process.exit(1);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "readme-shots-")));
process.env.HOME = path.join(tmp, "home");
const root = path.join(process.env.HOME, "projects");
const fx = buildFixture(root, { now: Math.floor(Date.now() / 1000), livePid: process.pid });
buildPlans(fx);
// imported after HOME is set: settings and avatars are read from it
const { startDashboard } = await import("../skill-packs/cross-review/scripts/lib/dashboard/server.js");
const catalog = {
  listModels: async () => [
    { slug: "gpt-5-codex", name: "GPT-5-Codex", description: "Tuned for coding work.", efforts: ["low", "medium", "high"] },
    { slug: "gpt-5", name: "GPT-5", description: "General reasoning.", efforts: ["minimal", "low", "medium", "high"] },
  ],
  defaultModel: () => "gpt-5-codex",
  cliInfo: async () => ({ version: "codex-cli", loggedIn: true }),
};
const d = await startDashboard({ root, port: 0, open: false, discoveryFile: null, catalog, latestVersion: async () => null });
const browser = await launchChrome(bin, path.join(tmp, "profile"));
const id = key => path.basename(fx.sessions[key]);
const ws = key => encodeURIComponent(path.relative(root, path.dirname(path.dirname(path.dirname(fx.sessions[key])))));
const SHOTS = [
  ["session.png", `#/s/${ws("waiting")}/${id("waiting")}`, `document.querySelectorAll("#thread .m").length > 2 && document.querySelector("#status .what")`],
  ["sessions.png", "#/", `document.querySelectorAll("#history tr[data-go]").length > 0 && document.querySelectorAll("#active tr").length > 1`],
  ["plan.png", `#/p/harbor-app/${encodeURIComponent("export-formats-plan.md")}`, `document.querySelectorAll("#phases > *").length > 0`],
  ["settings.png", "#/settings", `document.querySelectorAll("#per-skill tr").length === 4`],
];
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, hash, ready] of SHOTS) {
    const page = await browser.newPage(1400, 920);
    await page.goto(`${d.url}${hash}`);
    await page.waitFor(ready);
    // images and the live clock settle
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot(path.join(OUT, file), { fullPage: false });
    console.log(`wrote docs/images/${file}`);
  }
} finally {
  await browser.close();
  await d.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
