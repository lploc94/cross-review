// Finding and starting a command-line program without a shell. POSIX runs the name as given.
// Windows cannot spawn a .cmd without cmd.exe, and npm installs CLIs as .cmd shims, so the name is
// looked up on PATH (with PATHEXT) and an npm shim is run as what it points at: node + its script,
// or its .exe. Any other batch file needs cmd.exe, only where the caller allows it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

// npm's cmd-shim runs `"%dp0%\<target>" %*` (older versions `"%~dp0\<target>" %*`)
const SHIM_TARGET = /"%(?:dp0%|~dp0)\\([^"]+)"\s+%\*/;

/** The target of an npm cmd-shim, relative to the shim's folder; null for any other batch file. */
export function parseNpmShim(text) {
  const m = SHIM_TARGET.exec(text || "");
  return m ? m[1] : null;
}

/** A variable from env, matched as Windows does: case-insensitively, the first key in sort order. */
function envValue(env, name) {
  const key = Object.keys(env).filter(k => k.toUpperCase() === name).sort()[0];
  return key === undefined ? undefined : env[key];
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first file on PATH that Windows would run for name, or null. */
function findOnPath(name, env) {
  // PATHEXT is upper case; the file system is not, and npm writes lower-case names
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean);
  const hasExt = exts.some(e => name.toLowerCase().endsWith(e));
  const dirs = (envValue(env, "PATH") || "").split(";").map(d => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of hasExt ? [""] : exts) {
      const file = path.join(dir, name + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** Windows: how to start name without a shell, or null when it cannot be started that way. */
function resolveWindows(name, args, env, allowCmdShell) {
  const file = findOnPath(name, env);
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { cmd: file, args };
  if (ext !== ".cmd" && ext !== ".bat") return null;

  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const rel = parseNpmShim(text);
  const target = rel ? path.join(path.dirname(file), rel) : null;
  if (target && isFile(target)) {
    return /\.[cm]?js$/i.test(target) ? { cmd: process.execPath, args: [target, ...args] } : { cmd: target, args };
  }

  // cmd.exe expands %VAR% and ends a quoted argument at `"` even inside quotes: refuse those
  if (!allowCmdShell || args.some(a => /["%]/.test(a))) return null;
  const line = [file, ...args].map(a => `"${a}"`).join(" ");
  return {
    cmd: envValue(env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * {cmd, args[, windowsVerbatimArguments]} to pass to spawn/execFile for the program `name`.
 * When it cannot be resolved the name is returned as is, so the spawn fails with ENOENT.
 */
export function resolveSpawn(name, args = [], { env = process.env, allowCmdShell = false } = {}) {
  if (!IS_WIN) return { cmd: name, args };
  return resolveWindows(name, args, env, allowCmdShell) || { cmd: name, args };
}

/** True when `name` can be started: on PATH (POSIX), or resolvable by resolveSpawn (Windows). */
export function commandAvailable(name, { env = process.env, allowCmdShell = false } = {}) {
  if (IS_WIN) return resolveWindows(name, [], env, allowCmdShell) !== null;
  return spawnSync("which", [name], { encoding: "utf8", env }).status === 0;
}

/** Splits a process command line into words; double quotes group (Windows paths with spaces). */
function splitCommandLine(cmdline) {
  const words = [];
  let word = "";
  let quoted = false;
  let open = false;
  for (const ch of cmdline) {
    if (ch === "\"") {
      quoted = !quoted;
      open = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (open) words.push(word);
      word = "";
      open = false;
    } else {
      word += ch;
      open = true;
    }
  }
  if (open) words.push(word);
  return words;
}

const NODE_HOSTS = new Set(["node", "node.exe", "nodejs"]);

/**
 * The program a process runs, from its command line: {program, words}, program being the
 * lower-cased file name (either separator) and words its arguments. A node host is skipped,
 * with its options, so a node-hosted script is the program.
 */
export function programOf(cmdline) {
  const words = splitCommandLine(cmdline);
  const base = w => (w || "").split(/[\\/]/).pop().toLowerCase();
  let i = 0;
  if (NODE_HOSTS.has(base(words[0]))) {
    i = 1;
    while (i < words.length && words[i].startsWith("-")) i++;
  }
  return { program: base(words[i]), words: words.slice(i + 1) };
}
