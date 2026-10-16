#!/usr/bin/env node
// The landing page's promo video, built end to end (script: video/script.md):
//   text cards (cards.html) that explain each step, each followed by what it looks like:
//   a terminal scene (terminal.html) and the real dashboard following an invented session
//   that the script writes round by round.
// Text is drawn with OFL fonts (fetched by hash into video/.cache); every name and file in
// the story is invented. Needs Chrome (CHROME=<path>) and ffmpeg; no npm dependencies.
//
//   node video/build.mjs   → video/out/cross-review-promo.{mp4,webm}, video/out/poster.png

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const CACHE = path.join(HERE, ".cache");
const OUT = path.join(HERE, "out");
const WORK = path.join(OUT, "work");
const PAPER = "#f8f7f3";
const FADE = 0.4;

// ---------- fonts (SIL Open Font License 1.1), pinned to one google/fonts commit ----------

const FONT_COMMIT = "1d0e46c7933245c8180fe83e47917961c913bbdb";
const FONTS = [
  { family: "Promo Sans", path: "ofl/sourcesans3/SourceSans3[wght].ttf", sha256: "042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9" },
  { family: "Promo Serif", path: "ofl/sourceserif4/SourceSerif4[opsz,wght].ttf", sha256: "97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b" },
  { family: "Promo Mono", path: "ofl/jetbrainsmono/JetBrainsMono[wght].ttf", sha256: "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda" },
];

async function fontCss() {
  fs.mkdirSync(CACHE, { recursive: true });
  const faces = [];
  for (const f of FONTS) {
    const file = path.join(CACHE, path.basename(f.path));
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== f.sha256) {
      const url = `https://raw.githubusercontent.com/google/fonts/${FONT_COMMIT}/${f.path.replace(/\[/g, "%5B").replace(/\]/g, "%5D")}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font download failed (${res.status}): ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== f.sha256) throw new Error(`font hash mismatch: ${f.path}`);
      fs.writeFileSync(file, buf);
    }
    faces.push(`@font-face { font-family: "${f.family}"; src: url(data:font/ttf;base64,${fs.readFileSync(file).toString("base64")}) format("truetype"); font-weight: 200 900; }`);
  }
  faces.push(`:root { --sans: "Promo Sans", sans-serif !important; --serif: "Promo Serif", serif !important; --mono: "Promo Mono", monospace !important; }`);
  return faces.join("\n");
}
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

// ---------- Chrome over the DevTools Protocol, with events ----------

async function launchChrome(userDataDir) {
  const bin = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find(p => fs.existsSync(p));
  if (!bin) throw new Error("no Chrome found; set CHROME=<path>");
  const child = spawn(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    child.stderr.on("data", c => { err += c; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
    child.on("exit", code => reject(new Error(`Chrome exited ${code}: ${err}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject: e => reject(new Error(`${method}: ${e.message}`)) });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    async newPage({ width, height, scale, css }) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const call = (m, p) => send(m, p, sessionId);
      await call("Page.enable");
      // The dashboard's CSP would refuse the injected fonts; the bypass is for this recording only.
      await call("Page.setBypassCSP", { enabled: true });
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      await call("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(css)}; document.head.append(s); });` });
      const evaluate = async expression => {
        const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      const page = {
        evaluate,
        async goto(url, ready) {
          await call("Page.navigate", { url });
          await page.waitFor(`document.readyState === "complete" && document.fonts.status === "loaded" && (${ready})`);
          await sleep(400);
        },
        async waitFor(expression, ms = 15000) {
          const end = Date.now() + ms;
          for (;;) {
            try { if (await evaluate(expression)) return; } catch {}
            if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
            await sleep(80);
          }
        },
        /** Fail when any text on the page is drawn with a font other than the injected OFL ones. */
        async checkFonts(label) {
          await call("DOM.enable");
          await call("CSS.enable");
          const { root } = await call("DOM.getDocument", { depth: -1 });
          const { nodeIds } = await call("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "*" });
          const system = new Set();
          for (const nodeId of nodeIds) {
            const { fonts } = await call("CSS.getPlatformFontsForNode", { nodeId });
            for (const f of fonts) if (!f.isCustomFont) system.add(f.familyName);
          }
          if (system.size) throw new Error(`${label}: text drawn with system fonts (${[...system].join(", ")}); only the OFL fonts may appear in the video`);
        },
        async screenshot(file) {
          await page.checkFonts(path.basename(file));
          const { data } = await call("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(file, Buffer.from(data, "base64"));
        },
        /** Record the page while `action` runs: frames with their times, then a 30 fps clip. */
        async record(name, action) {
          // The clip is W x H: 1920 x 940 for the scenes, leaving 140 px for the caption bar.
          const W = Math.round(width * scale);
          const H = Math.round(height * scale / 2) * 2;
          const dir = path.join(WORK, `${name}-frames`);
          fs.mkdirSync(dir, { recursive: true });
          const frames = [];
          const onFrame = msg => {
            if (msg.method !== "Page.screencastFrame" || msg.sessionId !== sessionId) return;
            const file = path.join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
            fs.writeFileSync(file, Buffer.from(msg.params.data, "base64"));
            frames.push({ file, t: msg.params.metadata.timestamp });
            call("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
          };
          listeners.add(onFrame);
          await call("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W, maxHeight: Math.ceil(height * scale), everyNthFrame: 1 });
          await sleep(300);
          const start = Date.now() / 1000;
          await action();
          const stop = Date.now() / 1000;
          await call("Page.stopScreencast");
          listeners.delete(onFrame);
          await page.checkFonts(name);
          // Frames come only when the page changes; each one lasts until the next.
          const kept = frames.filter((f, i) => i === frames.length - 1 || frames[i + 1].t > start);
          const list = [];
          kept.forEach((f, i) => {
            const from = Math.max(f.t, start);
            const to = i + 1 < kept.length ? kept[i + 1].t : stop;
            list.push(`file '${f.file}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`);
          });
          list.push(`file '${kept.at(-1).file}'`);
          const listFile = path.join(WORK, `${name}-frames.txt`);
          fs.writeFileSync(listFile, list.join("\n"));
          const clip = path.join(WORK, `${name}-raw.mp4`);
          ffmpeg("-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`, ...ENC, clip);
          return clip;
        },
      };
      return page;
    },
    close() {
      try { ws.close(); } catch {}
      child.kill("SIGKILL");
    },
  };
}

// ---------- ffmpeg ----------

const ENC = ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-an"];
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const duration = file => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

/** A 1920x940 scene clip on paper, with caption bars below it: [{ png, from, to }]. */
function captioned(name, clip, captions) {
  const out = path.join(WORK, `${name}.mp4`);
  const inputs = ["-i", clip, ...captions.flatMap(c => ["-i", c.png])];
  let filter = `[0:v]pad=1920:1080:0:0:color=${PAPER}[v0]`;
  captions.forEach((c, i) => {
    filter += `;[v${i}][${i + 1}:v]overlay=0:940:enable='between(t,${c.from},${c.to})'[v${i + 1}]`;
  });
  ffmpeg(...inputs, "-filter_complex", filter, "-map", `[v${captions.length}]`, ...ENC, out);
  return out;
}

/** Seconds from..to of a clip (to past the end: up to the end). */
function cut(name, clip, from, to) {
  const out = path.join(WORK, `${name}.mp4`);
  ffmpeg("-ss", String(from), "-to", String(Math.min(to, duration(clip))), "-i", clip, ...ENC, out);
  return out;
}

function still(name, png, seconds) {
  const out = path.join(WORK, `${name}.mp4`);
  ffmpeg("-loop", "1", "-t", String(seconds), "-i", png, "-vf", "fps=30,format=yuv420p", ...ENC, out);
  return out;
}

/**
 * Join clips in order, each fading out to paper and the next fading in from it. (A crossfade
 * lays two text cards over each other; through paper, one card's text never overlaps another's.)
 */
function chain(out, clips) {
  const half = FADE / 2;
  const color = `0x${PAPER.slice(1)}`;
  let filter = clips.map((clip, i) => {
    const d = duration(clip);
    return `[${i}:v]setsar=1,format=yuv420p,fade=t=in:st=0:d=${half}:color=${color},fade=t=out:st=${(d - half).toFixed(3)}:d=${half}:color=${color}[f${i}];`;
  }).join("");
  filter += clips.map((_, i) => `[f${i}]`).join("") + `concat=n=${clips.length}:v=1:a=0[v]`;
  ffmpeg(...clips.flatMap(c => ["-i", c]), "-filter_complex", filter, "-map", "[v]", ...ENC, "-movflags", "+faststart", out);
}

// ---------- the invented session ----------

const sh = command => ({ kind: "command", command: `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`, exit: 0, output: "" });
const R1_ACTS = [sh("git diff --stat"), sh("sed -n '1,80p' src/upload/retry.js"), sh("cat tests/upload/retry.test.js"), sh("npm test -- upload"), sh("rg -n 'Retry-After' src")];
const R2_ACTS = [sh("git diff src/upload/retry.js"), sh("sed -n '30,60p' src/upload/retry.js"), sh("nl -ba src/upload/client.js | sed -n '80,95p'"), sh("npm test -- upload")];
const R1 = [
  "### ISSUE-1: Retries never stop on a 4xx",
  "- Category: correctness", "- Severity: high", "- Location: src/upload/retry.js:42",
  "- Problem: `retryUpload()` retries every failed request, including 400 and 413, so a bad upload loops until the attempt limit.",
  "- Suggested fix: Retry only network errors, 429 and 5xx.", "",
  "### ISSUE-2: Backoff ignores Retry-After",
  "- Category: correctness", "- Severity: medium", "- Location: src/upload/retry.js:57",
  "- Problem: The delay doubles from one second even when the server sends `Retry-After`.", "",
  "### VERDICT", "- Status: REVISE", "- Reason: Two defects; the backoff itself is sound.", "",
].join("\n");
const R2 = "### VERDICT\n- Status: APPROVE\n- Reason: ISSUE-1 holds: 4xx responses now fail at once. ISSUE-2 withdrawn: client.js:88 passes Retry-After as the minimum delay. All tests pass.\n";
const IN1 = "## USER_REQUEST\nRetry failed uploads with backoff.\n\n## SESSION_CONTEXT\nInvented context.\n";
const IN2 = "## FIXED_ITEMS\nISSUE-1: Retries never stop on a 4xx — fixed in src/upload/retry.js:42, retries only network errors, 429 and 5xx; test tests/upload/retry.test.js:31\n\n## DISPUTED_ITEMS\nISSUE-2: Backoff ignores Retry-After — src/upload/client.js:88 reads Retry-After and passes it as the minimum delay; test tests/upload/client.test.js:54\n";

// Round 2's event log with fixed item ids: each write only appends lines to the previous one,
// as a real reviewer's log grows (the dashboard reads appended lines only).
function round2Log(r2Acts, approved) {
  const lines = [{ type: "thread.started", thread_id: "thread-orchard-api" }, { type: "turn.started" }];
  R2_ACTS.slice(0, approved ? R2_ACTS.length : r2Acts).forEach((a, i) => {
    const item = { id: `r2_${i}`, type: "command_execution", command: a.command, aggregated_output: "" };
    lines.push({ type: "item.started", item: { ...item, exit_code: null, status: "in_progress" } });
    if (approved || i < r2Acts - 1) lines.push({ type: "item.completed", item: { ...item, exit_code: 0, status: "completed" } });
  });
  if (approved) lines.push({ type: "item.completed", item: { id: "r2_review", type: "agent_message", text: R2 } }, { type: "turn.completed", usage: {} });
  return lines.map(l => JSON.stringify(l)).join("\n") + "\n";
}

function writeStory(writeSession, sessionsDir, id, { r2Start, r2Acts, approved }) {
  const now = Math.floor(Date.now() / 1000);
  writeSession(sessionsDir, id, {
    skill: "review-impl", mode: "working-tree", created: r2Start - 420, inputs: [IN1, IN2],
    threadId: "thread-orchard-api",
    state: { pid: process.pid, pgid: process.pid, caller: { name: "agent" } },
    rounds: [
      { status: "completed", started: r2Start - 420, elapsed: 214, review: R1, acts: R1_ACTS },
      approved
        ? { status: "completed", started: r2Start, elapsed: now - r2Start, review: R2, acts: R2_ACTS }
        : { status: "running", started: r2Start, elapsed: 0, acts: R2_ACTS.slice(0, r2Acts), openLast: true },
    ],
  });
  fs.writeFileSync(path.join(sessionsDir, id, "output.jsonl"), round2Log(r2Acts, approved));
}

// ---------- build ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    try { execFileSync(tool, ["-version"], { stdio: "ignore" }); } catch { throw new Error(`${tool} not found in PATH`); }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const css = await fontCss();

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "promo-")));
  process.env.HOME = path.join(tmp, "home");
  const root = path.join(process.env.HOME, "projects");
  const sessionsDir = path.join(root, "orchard-api", ".cross-review", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const { writeSession } = await import(pathToFileURL(path.join(REPO, "tests/helpers/dashboard-fixture.js")).href);
  const { startDashboard } = await import(pathToFileURL(path.join(REPO, "skill-packs/cross-review/scripts/lib/dashboard/server.js")).href);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const id = `review-impl-${day}-004`;
  const r2Start = Math.floor(Date.now() / 1000) - 5;
  writeStory(writeSession, sessionsDir, id, { r2Start, r2Acts: 1, approved: false });
  const dashboard = await startDashboard({ root, port: 0, open: false, discoveryFile: null, latestVersion: async () => null });
  const browser = await launchChrome(path.join(tmp, "profile"));
  try {
    // cards
    const cards = await browser.newPage({ width: 1920, height: 1080, scale: 1, css });
    const shot = async (query, file, size) => {
      await cards.goto(`${pathToFileURL(path.join(HERE, "cards.html")).href}?${query}`, `document.getElementById("root").firstElementChild && [...document.images].every(i => i.complete)`);
      await cards.screenshot(file);
      if (size) {
        ffmpeg("-i", file, "-vf", `crop=${size}:0:0`, path.join(WORK, "crop.png"));
        fs.renameSync(path.join(WORK, "crop.png"), file);
      }
    };
    const png = name => path.join(WORK, `${name}.png`);
    const CARDS = ["title", "how", "step1", "step2", "step3", "step4", "decide", "skills", "end"];
    for (const name of CARDS) await shot(`kind=${name}`, png(name));
    const CAPTIONS = {
      ask: ["Step 1", "You ask for a review."],
      check: ["Step 2", "A second model checks."],
      answer: ["Step 3", "Your agent answers each issue."],
      watch: ["Step 4", "Every round, live on a local dashboard."],
    };
    for (const [key, [label, text]] of Object.entries(CAPTIONS)) {
      await shot(`kind=caption&label=${encodeURIComponent(label)}&text=${encodeURIComponent(text)}`, png(`cap-${key}`), "1920:140");
    }

    // terminal scene, cut into the three steps it shows (times follow terminal.html)
    const term = await browser.newPage({ width: 1280, height: 627, scale: 1.5, css });
    await term.goto(pathToFileURL(path.join(HERE, "terminal.html")).href, `typeof window.play === "function"`);
    const termClip = await term.record("terminal", () => term.evaluate("window.play()"));
    const termAsk = captioned("t-ask", cut("t1", termClip, 0, 2.7), [{ png: png("cap-ask"), from: 0, to: 99 }]);
    const termCheck = captioned("t-check", cut("t2", termClip, 2.7, 8.5), [{ png: png("cap-check"), from: 0, to: 99 }]);
    const termAnswer = captioned("t-answer", cut("t3", termClip, 8.5, 99), [{ png: png("cap-answer"), from: 0, to: 99 }]);

    // dashboard scene: the same session, round 2 running, then approved
    const dash = await browser.newPage({ width: 1100, height: 539, scale: 1920 / 1100, css });
    await dash.goto(`${dashboard.url}#/s/orchard-api/${id}`, `document.querySelector("#status .what") && document.querySelectorAll("#thread .m").length > 1`);
    const dashClip = await dash.record("dashboard", async () => {
      await sleep(1500);
      for (const n of [2, 3, 4]) {
        writeStory(writeSession, sessionsDir, id, { r2Start, r2Acts: n, approved: false });
        await sleep(1300);
      }
      writeStory(writeSession, sessionsDir, id, { r2Start, r2Acts: 4, approved: true });
      await dash.waitFor(`/approve/i.test(document.querySelector("#thread")?.textContent || "")`);
      await sleep(4500);
    });
    const dashScene = captioned("dashboard", dashClip, [{ png: png("cap-watch"), from: 0, to: 99 }]);

    // assemble: a card stays about one second per 3.5 words on it, plus a second
    const card = (name, seconds) => still(name, png(name), seconds);
    const mp4 = path.join(OUT, "cross-review-promo.mp4");
    chain(mp4, [
      card("title", 5.5), card("how", 7),
      card("step1", 6.5), termAsk,
      card("step2", 6), termCheck,
      card("step3", 5), termAnswer,
      card("step4", 6.5), dashScene,
      card("decide", 9), card("skills", 9), card("end", 5),
    ]);
    ffmpeg("-i", mp4, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1", "-an", path.join(OUT, "cross-review-promo.webm"));
    fs.copyFileSync(png("title"), path.join(OUT, "poster.png"));
    for (const f of ["cross-review-promo.mp4", "cross-review-promo.webm", "poster.png"]) {
      const p = path.join(OUT, f);
      console.log(`${f}: ${(fs.statSync(p).size / 1024 / 1024).toFixed(2)} MB${f.endsWith(".png") ? "" : `, ${duration(p).toFixed(1)} s`}`);
    }
  } finally {
    browser.close();
    await dashboard.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(err => {
  console.error(`build: ${err.message}`);
  process.exit(1);
});
