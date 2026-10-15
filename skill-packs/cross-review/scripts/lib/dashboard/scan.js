// Where the dashboard looks for sessions: the root folder and up to three levels below it.
// A workspace is a folder with `.cross-review/sessions/`. Hidden folders, node_modules and
// symlinks are not followed.

import fs from "node:fs";
import path from "node:path";

export const SCAN_DEPTH = 3;
export const SESSION_ID_RE = /^[a-z]+(-[a-z]+)*-\d{8}-\d{3}$/;

export function sessionsDir(ws) {
  return path.join(ws, ".cross-review", "sessions");
}

export function isWorkspace(dir) {
  try {
    return fs.statSync(sessionsDir(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute paths of the workspaces at depth 0..maxDepth under root, sorted. */
export function findWorkspaces(root, maxDepth = SCAN_DEPTH) {
  const out = [];
  const walk = (dir, depth) => {
    if (isWorkspace(dir)) out.push(dir);
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Dirent.isDirectory() is false for a symlink, so links are never followed
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return out.sort();
}

/** Session directories of one workspace (names matching SESSION_ID_RE), sorted. */
export function listSessions(ws) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name))
    .map(e => path.join(sessionsDir(ws), e.name))
    .sort();
}
