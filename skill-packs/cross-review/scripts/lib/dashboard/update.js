// Check for updates: the version in the pack's manifest on GitHub's main branch, compared with
// the installed one. The dashboard asks only when the user turns "Check for updates" on (at most
// once every UPDATE_TTL_S, the answer kept in ~/.cross-review/update.json) or presses Check now.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UPDATE_URL = "https://raw.githubusercontent.com/lploc94/cross-review/main/skill-packs/cross-review/manifest.json";
/** How long an answer stays fresh: a few days, so starting the dashboard rarely goes online. */
export const UPDATE_TTL_S = 3 * 24 * 3600;
const FETCH_TIMEOUT_MS = 8000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const updateCachePath = () => path.join(os.homedir(), ".cross-review", "update.json");

/** The latest pack version on GitHub; throws with a short reason. */
export async function fetchLatestVersion({ url = UPDATE_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? "GitHub did not answer in time" : "GitHub could not be reached");
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const version = (await res.json().catch(() => ({}))).version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) throw new Error("GitHub's manifest has no version");
  return version;
}

/** True when version `a` is newer than `b` (x.y.z, compared part by part). */
export function isNewer(a, b) {
  if (!VERSION_RE.test(String(a)) || !VERSION_RE.test(String(b))) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The last answer kept on disk: { latest, checked_at, error } or null. */
export function readUpdateCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!c || typeof c.checked_at !== "number") return null;
    return { latest: VERSION_RE.test(String(c.latest)) ? c.latest : null, checked_at: c.checked_at, error: typeof c.error === "string" ? c.error : null };
  } catch {
    return null;
  }
}

export function writeUpdateCache(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
