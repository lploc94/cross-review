// Antigravity CLI (`agy`) as the reviewer. agy does not read a plain prompt from stdin (`-p -`
// takes "-" as the prompt, and argv cannot carry a long one), so the turn runs with
// `--input-format stream-json` and stdin holds one NDJSON user message (encodePrompt); `--print=`
// keeps the flags after it from being read as the prompt. Output is stream-json: init,
// step_update and result events; a turn is resumed by its conversation id.
//
// Effort belongs to the model family: `agy models` lists variants (gemini-3.8-flash-low/-medium/
// -high), grouped here into a family (gemini-3.8-flash) whose efforts are the suffixes, run as
// `--model <family> --effort <e>`. A variant slug already names its effort and a model without
// variants has none, so neither gets --effort (agy rejects both combinations).
//
// read-only is `--sandbox --mode plan`: plan mode alone still writes files through the shell.

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable, programOf, resolveSpawn } from "../command.js";

export const name = "agy";
export const label = "Antigravity";
export const installHint = "see https://antigravity.google/docs";

export const sandboxes = ["read-only", "danger-full-access"];
export const defaultSandbox = "read-only";
export const fullAccessSandbox = "danger-full-access";

// The effort levels depend on the model (see the catalog below)
export const efforts = null;

export function isAvailable() {
  return commandAvailable("agy");
}

export function encodePrompt(text) {
  return JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n";
}

// ---------- model catalog: families and their efforts ----------

const CATALOG_TIMEOUT_MS = 15000;
const EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;

/**
 * `agy models` output (`slug\tdisplay name` per line) as families in order of first appearance:
 * [{slug, name, efforts, variants: [{slug, name, effort}]}]; a slug without an effort suffix is
 * a model of its own with no efforts. null when there is no model line.
 */
export function parseCatalog(text) {
  const families = [];
  const bySlug = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim();
    const display = line.slice(tab + 1).trim() || slug;
    const m = slug.match(EFFORT_SUFFIX);
    if (!m) {
      if (!bySlug.has(slug)) {
        const model = { slug, name: display, efforts: [], variants: [] };
        bySlug.set(slug, model);
        families.push(model);
      }
      continue;
    }
    let family = bySlug.get(m[1]);
    if (!family) {
      family = { slug: m[1], name: display.replace(/\s*\([^()]*\)\s*$/, "") || m[1], efforts: [], variants: [] };
      bySlug.set(m[1], family);
      families.push(family);
    }
    if (!family.efforts.includes(m[2])) family.efforts.push(m[2]);
    family.variants.push({ slug, name: display, effort: m[2] });
  }
  return families.length ? families : null;
}

// One `agy models` (about 2 s) answers the check and the launch in the same process; kept for a
// minute only, since the MCP server that runs begin lives as long as the client session.
const CATALOG_TTL_MS = 60000;
let catalogCache = null;

/** The grouped catalog from `agy models`, or null when it cannot be read. */
export function readCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  const { cmd, args } = resolveSpawn("agy", ["models"]);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: CATALOG_TIMEOUT_MS });
  const value = r.status === 0 ? parseCatalog(r.stdout) : null;
  catalogCache = { at: Date.now(), value };
  return value;
}

const findModel = (catalog, slug) => (catalog || []).find(m => m.slug === slug);
const findVariant = (catalog, slug) => {
  for (const m of catalog || []) for (const v of m.variants) if (v.slug === slug) return { family: m, variant: v };
  return null;
};
/** The family or model whose display name is agy's default model (settings store the name). */
const familyOfName = (catalog, displayName) => {
  if (!catalog || !displayName) return null;
  for (const m of catalog) if (m.name === displayName || m.variants.some(v => v.name === displayName)) return m;
  return null;
};

/** --model/--effort for a turn. effort always comes resolved (default high). */
export function resolveFlags({ model, effort, catalog, defaultName }) {
  const withEffort = effort ? ["--effort", effort] : [];
  if (model) {
    if (!catalog) return EFFORT_SUFFIX.test(model) ? ["--model", model] : ["--model", model, ...withEffort];
    if (findVariant(catalog, model)) return ["--model", model];
    const m = findModel(catalog, model);
    if (m && m.efforts.length === 0) return ["--model", model];
    return ["--model", model, ...withEffort];
  }
  const family = familyOfName(catalog, defaultName);
  if (family && family.efforts.length === 0) return [];
  return withEffort;
}

/**
 * Refuse, before anything starts, an effort the model's family lacks or a model agy does not
 * list. Without a catalog agy itself decides when the turn runs.
 */
export function checkSelection({ model, effort }, catalog = readCatalog(), defaultName = defaultModel()) {
  if (!catalog) return { ok: true };
  let family;
  if (model) {
    if (findVariant(catalog, model)) return { ok: true };
    family = findModel(catalog, model);
    if (!family) {
      return { ok: false, message: `Unknown Antigravity model ${model}; agy models lists: ${catalog.map(m => m.slug).join(", ")}` };
    }
  } else {
    family = familyOfName(catalog, defaultName);
    if (!family) return { ok: true };
  }
  if (family.efforts.length && effort && !family.efforts.includes(effort)) {
    return { ok: false, message: `Antigravity model ${family.slug} supports effort: ${family.efforts.join(", ")}` };
  }
  return { ok: true };
}

/** Command for one turn: threadId empty → new conversation; otherwise resume it. */
export function buildCommand({ threadId, workingDir, model, effort, sandbox }) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  args.push(...resolveFlags({ model, effort, catalog: readCatalog(), defaultName: defaultModel() }));
  args.push(...(sandbox === fullAccessSandbox ? ["--dangerously-skip-permissions"] : ["--sandbox", "--mode", "plan"]));
  if (threadId) args.push("--conversation", threadId);
  args.push("--print=");
  return { cmd: "agy", args, cwd: workingDir };
}

// ---------- event log ----------

function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const FILE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);
const statusOf = state => (state === "ACTIVE" ? "in_progress" : state === "DONE" ? "completed" : "failed");
const paramsOf = u => (u.tool_info && u.tool_info.parameters) || {};

/**
 * Read the event log. allLines gives the turn's terminal state and the review text;
 * newLines (not yet reported) give the activities, stamped with `elapsed`.
 */
export function parseEvents(allLines, newLines, elapsed) {
  const state = foldLog(newLogState(), allLines);
  const progressObserved = allLines.some(l => {
    const d = parseLine(l);
    return d && d.event === "step_update";
  });

  // A tool step is reported once when it starts (file changes) and once per state (commands)
  const activities = [];
  const seen = new Set();
  const toolStep = d => (d && d.event === "step_update" && d.step_update && d.step_update.step_type === "tool" ? d.step_update : null);
  for (const rawLine of allLines.slice(0, allLines.length - newLines.length)) {
    const u = toolStep(parseLine(rawLine));
    if (u) seen.add(`${u.step_index}`).add(`${u.step_index}:${u.state}`);
  }
  for (const rawLine of newLines) {
    const u = toolStep(parseLine(rawLine));
    if (!u) continue;
    const p = paramsOf(u);
    const first = !seen.has(`${u.step_index}`);
    const firstInState = !seen.has(`${u.step_index}:${u.state}`);
    seen.add(`${u.step_index}`).add(`${u.step_index}:${u.state}`);
    if (u.tool_name === "run_command") {
      if (firstInState) activities.push({ time: elapsed, type: u.state === "ACTIVE" ? "command_started" : "command_completed", detail: p.CommandLine || "" });
    } else if (FILE_TOOLS.has(u.tool_name) && first) {
      activities.push({ time: elapsed, type: "file_change", detail: `${p.TargetFile || p.AbsolutePath || "?"} (${u.tool_name})` });
    }
  }

  const { turnCompleted, turnFailed, failMessage, threadId, reviewText } = state;
  return { turnCompleted, turnFailed, failMessage, threadId, reviewText, progressObserved, activities };
}

/**
 * The turn's items for the dashboard, one per step, in order of first appearance; the turn's
 * final message (the review) is left out. lines: complete lines only.
 */
export function activityItems(lines) {
  return logItems(foldLog(newLogState(), lines));
}

export function newLogState() {
  return {
    count: 0, byId: new Map(), lastMessageId: null,
    turnCompleted: false, turnFailed: false, failMessage: "", threadId: "", reviewText: "",
  };
}

export function foldLog(state, lines) {
  for (const rawLine of lines) {
    const index = state.count++;
    const d = parseLine(rawLine);
    if (!d) continue;
    const body = d.event === "step_update" ? d.step_update : d.event === "result" ? d.result : d;
    const conv = body && typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
    if (!state.threadId && conv) state.threadId = conv;
    if (d.event === "result" && d.result) {
      if (d.result.status === "SUCCESS") {
        state.turnCompleted = true;
        state.reviewText = typeof d.result.response === "string" ? d.result.response : "";
      } else {
        state.turnFailed = true;
        state.failMessage = (typeof d.result.error === "string" && d.result.error.trim()) || String(d.result.status || "unknown error");
      }
      continue;
    }
    if (d.event !== "step_update" || !body) continue;
    const id = `step-${body.step_index ?? `line-${index}`}`;
    const prev = state.byId.get(id);
    let entry;
    if (body.step_type === "tool") {
      const p = paramsOf(body);
      const tool = body.tool_name || (body.tool_info && body.tool_info.name) || "tool";
      if (tool === "run_command") entry = { kind: "command", command: p.CommandLine || "", exitCode: null };
      else if (FILE_TOOLS.has(tool)) entry = { kind: "file_change", path: p.TargetFile || p.AbsolutePath || "" };
      else entry = { kind: "tool", tool, text: p.AbsolutePath || p.Query || p.SearchPath || "" };
      entry.status = statusOf(body.state);
    } else if (body.step_type === "agent_response") {
      entry = { kind: "message", text: ((prev && prev.text) || "") + (typeof body.text_delta === "string" ? body.text_delta : "") };
      state.lastMessageId = id;
    }
    if (!entry) continue;
    state.byId.set(id, { ...entry, id, line: prev ? prev.line : index, lastLine: index });
  }
  return state;
}

/** Copies of the folded items, in log order, without the turn's final message. */
export function logItems(state) {
  return [...state.byId.values()]
    .filter(e => !(state.turnCompleted && e.id === state.lastMessageId) && !(e.kind === "message" && !e.text))
    .sort((a, b) => a.line - b.line)
    .map(e => ({ ...e }));
}

export function logOutcome(state) {
  const { turnCompleted, turnFailed, failMessage, reviewText, threadId } = state;
  return { turnCompleted, turnFailed, failMessage, reviewText, threadId };
}

/** True when a process command line is a print-mode stream-json agy turn this runner may kill. */
export function matchesCmdline(cmdline) {
  const { program, words } = programOf(cmdline);
  if (!["agy", "agy.exe", "agy.js"].includes(program)) return false;
  return words.includes("--print=") && words.includes("stream-json");
}

// ---------- settings: model catalog, default model, CLI status ----------

function runAgy(args, timeout) {
  return new Promise(resolve => {
    const { cmd, args: argv } = resolveSpawn("agy", args);
    execFile(cmd, argv, { encoding: "utf8", timeout }, (err, stdout) => resolve({ ok: !err, stdout: stdout || "" }));
  });
}

/** The grouped catalog for the dashboard: [{slug, name, description, efforts}], or null. */
export async function listModels() {
  const r = await runAgy(["models"], CATALOG_TIMEOUT_MS);
  const catalog = r.ok ? parseCatalog(r.stdout) : null;
  return catalog && catalog.map(m => ({ slug: m.slug, name: m.name, description: "", efforts: [...m.efforts] }));
}

/** `model` in ~/.gemini/antigravity-cli/settings.json: a display name ("Gemini 3.8 Flash (High)"), or null. */
export function defaultModel() {
  try {
    const file = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
    const m = JSON.parse(fs.readFileSync(file, "utf8")).model;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}

/** `agy --version`; agy has no command that reports a login, so loggedIn is unknown (null). */
export async function cliInfo() {
  const version = await runAgy(["--version"], 5000);
  return { version: (version.ok && version.stdout.trim()) || null, loggedIn: null };
}
