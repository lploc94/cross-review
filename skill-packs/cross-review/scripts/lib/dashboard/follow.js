// Follow reviews: when `open_dashboard` is on, `begin` shows the new session in the
// browser. It reuses the dashboard named in ~/.cross-review/dashboard.json when that one
// answers, otherwise starts a detached one that exits after 30 minutes with no page open,
// registers the session's workspace with it, and opens the session's page.
//
// Never throws: any failure comes back as { error } and the review goes on.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoveryFile, readDiscovery } from "./discovery.js";
import { openBrowser as defaultOpenBrowser } from "./server.js";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "review-runner.js");
export const FOLLOW_WAIT_MS = 5000;
export const FOLLOW_IDLE_EXIT_S = 1800;
const HEALTH_TIMEOUT_MS = 1000;
const POLL_MS = 100;

function defaultSpawnDashboard({ root, idleExitSeconds }) {
  const child = spawn(process.execPath, [RUNNER, "dashboard", "--root", root, "--no-open", "--idle-exit", String(idleExitSeconds)], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
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

/** The dashboard in the discovery file when its process lives and /api/health answers. */
async function liveDashboard(file, fetchFn) {
  const info = readDiscovery(file);
  if (!info || !pidAlive(info.pid) || !info.port || !info.token) return null;
  try {
    const res = await fetchFn(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok ? info : null;
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Show `sessionDir` (started in `workingDir`) in the dashboard. Options besides the two
 * paths are for tests. Returns { url } or { error } (plus url when only the browser did not
 * open; the error names the link).
 */
export async function followInDashboard({
  sessionDir, workingDir,
  spawnDashboard = defaultSpawnDashboard, openBrowser = defaultOpenBrowser, fetch: fetchFn = globalThis.fetch,
  waitMs = FOLLOW_WAIT_MS, idleExitSeconds = FOLLOW_IDLE_EXIT_S, file = discoveryFile(),
}) {
  try {
    let info = await liveDashboard(file, fetchFn);
    if (!info) {
      spawnDashboard({ root: workingDir, idleExitSeconds });
      const end = Date.now() + waitMs;
      while (!info && Date.now() < end) {
        await sleep(POLL_MS);
        info = await liveDashboard(file, fetchFn);
      }
      if (!info) return { error: `dashboard did not start within ${Math.round(waitMs / 1000)} s` };
    }
    const res = await fetchFn(`http://127.0.0.1:${info.port}/api/workspaces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: workingDir }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.ws !== "string") return { error: `the dashboard did not take the workspace: ${body.error || res.status}` };
    const url = `http://127.0.0.1:${info.port}/?t=${info.token}#/s/${encodeURIComponent(body.ws)}/${path.basename(sessionDir)}`;
    const opened = await openBrowser(url);
    if (opened && opened.ok === false) return { url, error: `could not open the browser: ${opened.error}; open ${url}` };
    return { url };
  } catch (e) {
    return { error: `could not open the dashboard: ${e.message}` };
  }
}
