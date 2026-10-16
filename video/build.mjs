#!/usr/bin/env node
// The landing page's promo video, built end to end (script: video/script.md):
//   text cards (cards.html) that explain each step, each followed by what it looks like:
//   a terminal scene (terminal.html) and the dashboard demo (demo/build.mjs: the real dashboard
//   UI on recorded, invented sessions) playing the same review's last round to its approval.
// Text is drawn with OFL fonts (fonts.mjs); every name and file in
// the story is invented. Needs Chrome (CHROME=<path>) and ffmpeg; no npm dependencies.
//
//   node video/build.mjs   → video/out/cross-review-promo.{mp4,webm}, video/out/poster.png

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { oflFontCss, checkFonts } from "./fonts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const OUT = path.join(HERE, "out");
const WORK = path.join(OUT, "work");
const PAPER = "#f8f7f3";
const FADE = 0.4;
/** The dashboard demo plays at this share of its landing-page step times. */
const DEMO_SPEED = 0.45;

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
          await checkFonts(call, label);
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

// ---------- the dashboard demo ----------

/** Serve a built demo folder at /demo/ on 127.0.0.1; resolves to { url, close }. */
async function serveDemo(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".txt": "text/plain" };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(dir, p.replace(/^\/demo\//, "") || "index.html");
    if (!p.startsWith("/demo/") || !file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/demo/`, close: () => server.close() };
}

// ---------- build ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    try { execFileSync(tool, ["-version"], { stdio: "ignore" }); } catch { throw new Error(`${tool} not found in PATH`); }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const css = await oflFontCss();

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "promo-")));
  // the dashboard demo, as the landing page shows it, played faster: the video shows its review
  const demoDir = path.join(WORK, "demo");
  execFileSync(process.execPath, [path.join(REPO, "demo/build.mjs"), demoDir], { stdio: "inherit" });
  const demoData = JSON.parse(fs.readFileSync(path.join(demoDir, "data.json"), "utf8"));
  for (const step of demoData.steps) step.ms = Math.round(step.ms * DEMO_SPEED);
  fs.writeFileSync(path.join(demoDir, "data.json"), JSON.stringify(demoData));
  const demo = await serveDemo(demoDir);
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

    // terminal scene, cut into the three steps it shows (times follow terminal.html's SCRIPT)
    const term = await browser.newPage({ width: 1280, height: 627, scale: 1.5, css });
    await term.goto(pathToFileURL(path.join(HERE, "terminal.html")).href, `typeof window.play === "function"`);
    const termClip = await term.record("terminal", () => term.evaluate("window.play()"));
    const termAsk = captioned("t-ask", cut("t1", termClip, 0, 3.3), [{ png: png("cap-ask"), from: 0, to: 99 }]);
    const termCheck = captioned("t-check", cut("t2", termClip, 3.3, 13.3), [{ png: png("cap-check"), from: 0, to: 99 }]);
    const termAnswer = captioned("t-answer", cut("t3", termClip, 13.3, 99), [{ png: png("cap-answer"), from: 0, to: 99 }]);

    // dashboard scene: the same review in the demo, round 3 streaming in, then approved
    const dash = await browser.newPage({ width: 1100, height: 539, scale: 1920 / 1100, css });
    await dash.goto(`${demo.url}?paused#/`, `document.querySelectorAll("#active tr").length > 1`);
    await dash.evaluate(`window.postMessage({ demo: "view", view: "session" }, location.origin)`);
    await dash.waitFor(`document.querySelector("#status .what") && document.querySelectorAll("#acts > *").length > 3`);
    await sleep(600);
    const dashClip = await dash.record("dashboard", async () => {
      await sleep(1200);
      await dash.evaluate(`window.postMessage({ demo: "play" }, location.origin)`);
      await dash.waitFor(`/Approved/.test(document.querySelector("#status .what")?.textContent || "")`, 60000);
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
    demo.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(err => {
  console.error(`build: ${err.message}`);
  process.exit(1);
});
