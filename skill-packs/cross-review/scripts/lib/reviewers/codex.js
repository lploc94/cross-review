// Codex CLI as the reviewer: how to find it, launch or resume a turn, read its event log,
// and recognise its process. The runner owns spawning, watchdogs, polling and state.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

export const name = "codex";
export const label = "Codex";
export const installHint = "npm install -g @openai/codex";

// Codex's own sandbox names. Reviewers run with full access so they can verify claims
// (tests, builds, curl); their prompts forbid editing project files.
export const sandboxes = ["read-only", "workspace-write", "danger-full-access"];
export const defaultSandbox = "read-only";
export const fullAccessSandbox = "danger-full-access";

export function isAvailable() {
  const probe = spawnSync(IS_WIN ? "where" : "which", ["codex"], { encoding: "utf8" });
  return probe.status === 0;
}

/**
 * Resolve the codex CLI command for spawning.
 *
 * On Windows, npm-installed CLIs are .cmd wrappers (e.g. codex.cmd).
 * Node.js spawn() cannot resolve .cmd files without shell: true,
 * but shell: true + detached: true drops stdio on Windows.
 * Instead, resolve the underlying codex.js entry point and invoke
 * it directly via node.exe — no shell needed.
 */
function resolveCommand() {
  if (!IS_WIN) {
    return { cmd: "codex", prependArgs: [] };
  }

  // Try to find codex.js via npm global prefix
  const r = spawnSync("npm", ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: true,
    timeout: 10000,
  });
  if (r.status === 0 && r.stdout) {
    const codexJs = path.join(r.stdout.trim(), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Fallback: try common npm global path on Windows
  const appData = process.env.APPDATA;
  if (appData) {
    const codexJs = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(codexJs)) {
      return { cmd: process.execPath, prependArgs: [codexJs] };
    }
  }

  // Last resort: assume "codex" is directly executable (non-npm install)
  return { cmd: "codex", prependArgs: [] };
}

/**
 * Command for one turn. The prompt arrives on stdin and the JSONL event log goes to stdout.
 * threadId empty → new thread; otherwise resume that thread.
 */
export function buildCommand({ threadId, workingDir, model, effort, sandbox }) {
  const { cmd, prependArgs } = resolveCommand();
  // Omit the override when absent so Codex keeps its default model selection.
  const modelArgs = model === undefined || model === null ? [] : ["--model", model];

  if (threadId) {
    // `exec resume` has no --sandbox flag; without the override a resumed turn falls back
    // to the config default (seen in real rollouts: danger-full-access → workspace-write)
    return {
      cmd,
      args: [
        ...prependArgs, "exec", "--skip-git-repo-check", "--json",
        "--config", `model_reasoning_effort=${effort}`,
        "--config", `sandbox_mode="${sandbox}"`,
        "resume", ...modelArgs, threadId, "-",
      ],
      cwd: workingDir,
    };
  }
  return {
    cmd,
    args: [
      ...prependArgs,
      "exec", "--skip-git-repo-check", "--json",
      ...modelArgs,
      "--sandbox", sandbox,
      "--config", `model_reasoning_effort=${effort}`,
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
  const byId = new Map();
  let turnCompleted = false;
  let lastMessageId = null;
  lines.forEach((rawLine, index) => {
    const d = parseLine(rawLine);
    if (!d) return;
    if (d.type === "turn.completed") turnCompleted = true;
    if (d.type !== "item.started" && d.type !== "item.updated" && d.type !== "item.completed") return;
    const item = d.item || {};
    const kind = ITEM_KINDS[item.type];
    if (!kind) return;
    const id = typeof item.id === "string" && item.id ? item.id : `line-${index}`;
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, line: index, lastLine: index, kind };
      byId.set(id, entry);
    }
    entry.lastLine = index;
    if (kind === "command") {
      entry.command = item.command || "";
      entry.exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      entry.status = item.status || (d.type === "item.completed" ? "completed" : "in_progress");
    } else if (kind === "message" || kind === "reasoning") {
      entry.text = item.text || "";
      if (kind === "message") lastMessageId = id;
    } else if (kind === "tool") {
      entry.tool = item.type === "web_search" ? "web search" : [item.server, item.tool].filter(Boolean).join(".");
      if (item.query) entry.text = item.query;
      entry.status = item.status || null;
    } else {
      entry.path = (item.changes || []).map(c => c.path).filter(Boolean).join(", ");
      entry.status = item.status || null;
    }
  });
  if (turnCompleted && lastMessageId !== null) byId.delete(lastMessageId);
  return [...byId.values()].sort((a, b) => a.line - b.line);
}

/** True when a process command line is a Codex turn this runner may kill. */
export function matchesCmdline(cmdline) {
  return cmdline.includes("codex exec") || cmdline.includes("codex.exe exec") ||
    (cmdline.includes("codex.js") && cmdline.includes("exec"));
}
