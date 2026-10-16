// Headless Chrome over the DevTools Protocol, for the dashboard UI checks. A page with an
// open EventSource never goes idle, so --dump-dom/--virtual-time-budget cannot be used;
// here the test waits for a condition in the page instead. Uses Node's built-in WebSocket.

import { spawn } from "node:child_process";
import fs from "node:fs";

export function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

/** Start Chrome; resolves to { newPage(width, height), close() }. */
export async function launchChrome(bin, userDataDir) {
  const child = spawn(bin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    // never touch the system keychain or password store (tests run with a temporary HOME,
    // where macOS would ask for a "Chrome" keychain that does not exist)
    "--use-mock-keychain", "--password-store=basic",
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${err}`)), 20000);
    child.stderr.on("data", d => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", code => reject(new Error(`Chrome exited ${code}: ${err}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function newPage(width = 1400, height = 1000) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const evaluate = async expression => {
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    return {
      /** A DevTools Protocol command to this page. */
      call,
      goto: url => call("Page.navigate", { url }),
      evaluate,
      /** Poll an expression until it is truthy. */
      async waitFor(expression, ms = 10000) {
        const end = Date.now() + ms;
        for (;;) {
          try {
            const v = await evaluate(expression);
            if (v) return v;
          } catch {}
          if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
          await new Promise(r => setTimeout(r, 100));
        }
      },
      /** The whole page, or with fullPage false only what the window shows. */
      async screenshot(file, { fullPage = true } = {}) {
        const { data } = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
        fs.writeFileSync(file, Buffer.from(data, "base64"));
      },
    };
  }

  return {
    newPage,
    /** Resolves once Chrome has exited, so its profile dir can be removed. */
    close() {
      try { ws.close(); } catch {}
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      const exited = new Promise(r => child.once("exit", r));
      child.kill("SIGKILL");
      return exited;
    },
  };
}
