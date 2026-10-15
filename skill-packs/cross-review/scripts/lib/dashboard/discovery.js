// ~/.cross-review/dashboard.json: how `begin` finds a running dashboard. Holds the token,
// so it is written 0600; a dashboard removes it on exit only while it still points at itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function discoveryFile() {
  return path.join(os.homedir(), ".cross-review", "dashboard.json");
}

/** info: { pid, port, token, root, started_at } */
export function writeDiscovery(info, file = discoveryFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readDiscovery(file = discoveryFile()) {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

/** Delete the file when it names this process (and this run's token, when given). */
export function removeDiscoveryIfOwn(pid, { file = discoveryFile(), token = null } = {}) {
  const info = readDiscovery(file);
  if (!info || info.pid !== pid || (token && info.token !== token)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
