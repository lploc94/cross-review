// Codex CLI as the reviewer: how to find it, launch or resume a turn, read its event log,
// and recognise its process. The runner owns spawning, watchdogs, polling and state.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable, programOf, resolveSpawn } from "../command.js";

export const name = "codex";
export const label = "Codex";
export const installHint = "npm install -g @openai/codex";

// Codex's own sandbox names. Reviewers run with full access so they can verify claims
// (tests, builds, curl); their prompts forbid editing project files.
export const sandboxes = ["read-only", "workspace-write", "danger-full-access"];
export const defaultSandbox = "read-only";
export const fullAccessSandbox = "danger-full-access";

export function isAvailable() {
  return commandAvailable("codex");
}

/**
 * Command for one turn. The prompt arrives on stdin and the JSONL event log goes to stdout.
 * threadId empty → new thread; otherwise resume that thread.
 */
export function buildCommand({ threadId, workingDir, model, effort, sandbox, systemPromptFile }) {
  // Omit the override when absent so Codex keeps its default model selection.
  const modelArgs = model === undefined || model === null ? [] : ["--model", model];
  const sysConfigArgs = systemPromptFile
    ? [
        "--config", `model_instructions_file=${JSON.stringify(systemPromptFile)}`,
        "--config", 'web_search="live"',
        "--config", "include_permissions_instructions=false",
        "--config", "include_apps_instructions=false",
        "--config", "include_collaboration_mode_instructions=false",
        "--config", "features.plugins=false",
        "--config", "features.apps=false",
        "--config", "features.multi_agent=false",
      ]
    : [];

  if (threadId) {
    // `exec resume` has no --sandbox flag; without the override a resumed turn falls back
    // to the config default (seen in real rollouts: danger-full-access → workspace-write)
    return {
      cmd: "codex",
      args: [
        "exec", "--skip-git-repo-check", "--json",
        "--config", `model_reasoning_effort=${effort}`,
        ...sysConfigArgs,
        "--config", `sandbox_mode="${sandbox}"`,
        "resume", ...modelArgs, threadId, "-",
      ],
      cwd: workingDir,
    };
  }
  return {
    cmd: "codex",
    args: [
      "exec", "--skip-git-repo-check", "--json",
      ...modelArgs,
      "--sandbox", sandbox,
      "--config", `model_reasoning_effort=${effort}`,
      ...sysConfigArgs,
      "-C", workingDir,
    ],
    cwd: undefined,
  };
}

function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Read the event log. allLines gives the turn's terminal state and the review text;
 * newLines (not yet reported) give the activities, stamped with `elapsed`.
 */
export function parseEvents(allLines, newLines, elapsed) {
  let turnCompleted = false;
  let turnFailed = false;
  let failMessage = "";
  let threadId = "";
  let reviewText = "";
  let progressObserved = false;

  for (const rawLine of allLines) {
    const d = parseLine(rawLine);
    if (!d) continue;
    const t = d.type || "";

    if (t === "turn.started" || t === "item.started" || t === "item.completed") {
      progressObserved = true;
    }
    if (t === "thread.started" && typeof d.thread_id === "string" && d.thread_id.trim()) {
      threadId = d.thread_id.trim();
    }
    if (t === "turn.completed") {
      turnCompleted = true;
    } else if (t === "turn.failed") {
      turnFailed = true;
      failMessage = (d.error && d.error.message) || "unknown error";
    }
    if (t === "item.completed") {
      const item = d.item || {};
      if (item.type === "agent_message") {
        reviewText = item.text || "";
      }
    }
  }

  const activities = [];
  for (const rawLine of newLines) {
    const d = parseLine(rawLine);
    if (!d) continue;
    const t = d.type || "";
    const item = d.item || {};
    const itemType = item.type || "";

    if (t === "turn.started") {
      activities.push({ time: elapsed, type: "thinking", detail: "started new turn" });
    } else if (t === "item.completed" && itemType === "reasoning") {
      let text = item.text || "";
      if (text.length > 150) text = text.slice(0, 150) + "...";
      activities.push({ time: elapsed, type: "thinking", detail: text });
    } else if (t === "item.started" && itemType === "command_execution") {
      activities.push({ time: elapsed, type: "command_started", detail: item.command || "" });
    } else if (t === "item.completed" && itemType === "command_execution") {
      activities.push({ time: elapsed, type: "command_completed", detail: item.command || "" });
    } else if (t === "item.completed" && itemType === "file_change") {
      for (const c of (item.changes || [])) {
        activities.push({ time: elapsed, type: "file_change", detail: `${c.path || "?"} (${c.kind || "?"})` });
      }
    }
  }

  return { turnCompleted, turnFailed, failMessage, threadId, reviewText, progressObserved, activities };
}

const ITEM_KINDS = {
  command_execution: "command",
  agent_message: "message",
  reasoning: "reasoning",
  mcp_tool_call: "tool",
  web_search: "tool",
  file_change: "file_change",
};

/**
 * The turn's items for the dashboard, one per item id, in order of first appearance.
 * `line` is the first event line of the item (item.started, else item.completed: Codex
 * only completes intermediate messages and reasoning); `lastLine` the latest. Content
 * comes from the latest event. The turn's final agent_message (the review) is left out.
 * lines: the event log split on "\n" (only complete lines).
 */
export function activityItems(lines) {
  return logItems(foldLog(newLogState(), lines));
}

/**
 * The event log read in steps, for a reader that only parses appended lines: fold each
 * batch of complete lines into the state, then read the items (`logItems`) and the turn's
 * outcome (`logOutcome`, the same fields parseEvents gives from all lines).
 */
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
    const t = d.type || "";
    if (t === "thread.started" && typeof d.thread_id === "string" && d.thread_id.trim()) state.threadId = d.thread_id.trim();
    if (t === "turn.completed") {
      state.turnCompleted = true;
    } else if (t === "turn.failed") {
      state.turnFailed = true;
      state.failMessage = (d.error && d.error.message) || "unknown error";
    }
    if (t !== "item.started" && t !== "item.updated" && t !== "item.completed") continue;
    const item = d.item || {};
    if (t === "item.completed" && item.type === "agent_message") state.reviewText = item.text || "";
    const kind = ITEM_KINDS[item.type];
    if (!kind) continue;
    const id = typeof item.id === "string" && item.id ? item.id : `line-${index}`;
    let entry = state.byId.get(id);
    if (!entry) {
      entry = { id, line: index, lastLine: index, kind };
      state.byId.set(id, entry);
    }
    entry.lastLine = index;
    if (kind === "command") {
      entry.command = item.command || "";
      entry.exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      entry.status = item.status || (t === "item.completed" ? "completed" : "in_progress");
    } else if (kind === "message" || kind === "reasoning") {
      entry.text = item.text || "";
      if (kind === "message") state.lastMessageId = id;
    } else if (kind === "tool") {
      entry.tool = item.type === "web_search" ? "web search" : [item.server, item.tool].filter(Boolean).join(".");
      if (item.query) entry.text = item.query;
      entry.status = item.status || null;
    } else {
      entry.path = (item.changes || []).map(c => c.path).filter(Boolean).join(", ");
      entry.status = item.status || null;
    }
  }
  return state;
}

/** Copies of the folded items, in log order, without the turn's final message. */
export function logItems(state) {
  return [...state.byId.values()]
    .filter(e => !(state.turnCompleted && e.id === state.lastMessageId))
    .sort((a, b) => a.line - b.line)
    .map(e => ({ ...e }));
}

export function logOutcome(state) {
  const { turnCompleted, turnFailed, failMessage, reviewText, threadId } = state;
  return { turnCompleted, turnFailed, failMessage, reviewText, threadId };
}

/** True when a process command line is a Codex turn this runner may kill. */
export function matchesCmdline(cmdline) {
  const { program, words } = programOf(cmdline);
  return ["codex", "codex.exe", "codex.js"].includes(program) && words.includes("exec");
}

// ---------- settings: model catalog, default model, CLI status ----------

const CATALOG_TIMEOUT_MS = 15000;

function runCodex(args, timeout = CATALOG_TIMEOUT_MS) {
  const { cmd, args: argv } = resolveSpawn("codex", args);
  return new Promise(resolve => {
    execFile(cmd, argv, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || "" });
    });
  });
}

/**
 * Models offered by `codex debug models` (a debug command that may change, so: the bundled
 * list when it fails, null when that fails too). Listed models only, by priority:
 * [{slug, name, description, efforts}].
 */
export async function listModels() {
  for (const args of [["debug", "models"], ["debug", "models", "--bundled"]]) {
    const r = await runCodex(args);
    if (!r.ok) continue;
    try {
      const data = JSON.parse(r.stdout);
      const models = Array.isArray(data) ? data : data.models;
      if (!Array.isArray(models)) continue;
      return models
        .filter(m => m && m.visibility === "list" && typeof m.slug === "string")
        .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
        .map(m => ({
          slug: m.slug,
          name: m.display_name || m.slug,
          description: m.description || "",
          efforts: (m.supported_reasoning_levels || []).map(l => (typeof l === "string" ? l : l && l.effort)).filter(Boolean),
        }));
    } catch {}
  }
  return null;
}

/** The top-level `model` of $CODEX_HOME/config.toml (default ~/.codex), or null. */
export function defaultModel() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let text;
  try {
    text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // the first table ends the top level
    const m = line.match(/^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

/** `codex --version` and whether `codex login status` succeeds. */
export async function cliInfo() {
  const version = await runCodex(["--version"], 5000);
  if (!version.ok) return { version: null, loggedIn: false };
  const login = await runCodex(["login", "status"], 5000);
  return { version: version.stdout.trim() || null, loggedIn: login.ok };
}
