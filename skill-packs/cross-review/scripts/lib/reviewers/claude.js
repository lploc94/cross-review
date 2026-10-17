// Claude Code CLI as the reviewer: `claude -p` with the prompt on stdin and the stream-json
// event log on stdout (stream-json in print mode needs --verbose). A turn is resumed by its
// session id. The result event's `is_error` decides failure: Claude reports an unknown model
// as `subtype: "success"` with `is_error: true`.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable, programOf, resolveSpawn } from "../command.js";

export const name = "claude";
export const label = "Claude Code";
export const installHint = "npm install -g @anthropic-ai/claude-code";

// Same names as Codex's, so review-core can ask any reviewer for full access.
// read-only is plan mode (reads, no edits or commands); full access skips permission prompts.
export const sandboxes = ["read-only", "danger-full-access"];
export const defaultSandbox = "read-only";
export const fullAccessSandbox = "danger-full-access";

// `claude --help`: --effort <level> (low, medium, high, xhigh, max). An unknown level only
// warns and falls back to the default, so it is refused before anything starts.
export const efforts = ["low", "medium", "high", "xhigh", "max"];
// The model list is a set of aliases; any full model name works too
export const allowCustomModel = true;

export function isAvailable() {
  return commandAvailable("claude");
}

export function checkSelection({ effort }) {
  if (effort && !efforts.includes(effort)) {
    return { ok: false, message: `Claude Code effort must be one of: ${efforts.join(", ")}` };
  }
  return { ok: true };
}

/** Command for one turn: threadId empty → new session; otherwise resume that session. */
export function buildCommand({ threadId, workingDir, model, effort, sandbox }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--effort", effort];
  if (model !== undefined && model !== null) args.push("--model", model);
  args.push(...(sandbox === fullAccessSandbox ? ["--dangerously-skip-permissions"] : ["--permission-mode", "plan"]));
  if (threadId) args.push("--resume", threadId);
  return { cmd: "claude", args, cwd: workingDir };
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

const contentOf = d => (d && d.message && Array.isArray(d.message.content) ? d.message.content : []);

function failMessageOf(d) {
  if (typeof d.result === "string" && d.result.trim()) return d.result;
  if (Array.isArray(d.errors) && d.errors.length) return d.errors.map(String).join("; ");
  return "unknown error";
}

/** The exit code a Bash tool_result reports ("Exit code N" when it failed). */
function exitCodeOf(block) {
  if (!block.is_error) return 0;
  const text = typeof block.content === "string" ? block.content
    : Array.isArray(block.content) ? block.content.map(c => (c && c.text) || "").join("\n") : "";
  const m = text.match(/Exit code (\d+)/);
  return m ? Number(m[1]) : 1;
}

/**
 * Read the event log. allLines gives the turn's terminal state and the review text;
 * newLines (not yet reported) give the activities, stamped with `elapsed`.
 */
export function parseEvents(allLines, newLines, elapsed) {
  const state = foldLog(newLogState(), allLines);
  const progressObserved = allLines.some(l => {
    const d = parseLine(l);
    return d && (d.type === "assistant" || d.type === "user");
  });

  const activities = [];
  const bashIds = new Set();
  for (const rawLine of allLines.slice(0, allLines.length - newLines.length)) {
    const d = parseLine(rawLine);
    for (const c of contentOf(d)) if (c.type === "tool_use" && c.name === "Bash") bashIds.add(c.id);
  }
  for (const rawLine of newLines) {
    const d = parseLine(rawLine);
    if (!d) continue;
    for (const c of contentOf(d)) {
      if (d.type === "assistant" && c.type === "tool_use") {
        if (c.name === "Bash") {
          bashIds.add(c.id);
          activities.push({ time: elapsed, type: "command_started", detail: (c.input && c.input.command) || "" });
        } else if (FILE_TOOLS.has(c.name)) {
          activities.push({ time: elapsed, type: "file_change", detail: `${(c.input && c.input.file_path) || "?"} (${c.name})` });
        }
      } else if (d.type === "assistant" && c.type === "thinking" && c.thinking) {
        let text = c.thinking;
        if (text.length > 150) text = text.slice(0, 150) + "...";
        activities.push({ time: elapsed, type: "thinking", detail: text });
      } else if (d.type === "user" && c.type === "tool_result" && bashIds.has(c.tool_use_id)) {
        const item = state.byId.get(c.tool_use_id);
        activities.push({ time: elapsed, type: "command_completed", detail: (item && item.command) || "" });
      }
    }
  }

  const { turnCompleted, turnFailed, failMessage, threadId, reviewText } = state;
  return { turnCompleted, turnFailed, failMessage, threadId, reviewText, progressObserved, activities };
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * The turn's items for the dashboard, one per tool call or message block, in order of first
 * appearance; the turn's final message (the review) is left out. lines: complete lines only.
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
    if (!state.threadId && typeof d.session_id === "string" && d.session_id.trim()) state.threadId = d.session_id.trim();
    if (d.type === "result") {
      if (d.is_error === true) {
        state.turnFailed = true;
        state.failMessage = failMessageOf(d);
      } else {
        state.turnCompleted = true;
        state.reviewText = typeof d.result === "string" ? d.result : "";
      }
      continue;
    }
    const content = contentOf(d);
    if (d.type === "assistant") {
      const msgId = (d.message && d.message.id) || `line-${index}`;
      content.forEach((c, i) => {
        let entry;
        if (c.type === "tool_use") {
          const input = c.input || {};
          if (c.name === "Bash") entry = { kind: "command", command: input.command || "", exitCode: null, status: "in_progress" };
          else if (FILE_TOOLS.has(c.name)) entry = { kind: "file_change", path: input.file_path || input.notebook_path || "", status: "in_progress" };
          else entry = { kind: "tool", tool: c.name || "tool", text: input.file_path || input.pattern || input.url || input.query || "", status: "in_progress" };
          entry.id = c.id || `${msgId}:${i}`;
        } else if (c.type === "text" && c.text) {
          entry = { kind: "message", text: c.text, id: `${msgId}:${i}` };
        } else if (c.type === "thinking" && c.thinking) {
          entry = { kind: "reasoning", text: c.thinking, id: `${msgId}:${i}` };
        }
        if (!entry) return;
        const prev = state.byId.get(entry.id);
        state.byId.set(entry.id, { ...entry, line: prev ? prev.line : index, lastLine: index });
        if (entry.kind === "message") state.lastMessageId = entry.id;
      });
    } else if (d.type === "user") {
      for (const c of content) {
        if (c.type !== "tool_result") continue;
        const entry = state.byId.get(c.tool_use_id);
        if (!entry) continue;
        entry.lastLine = index;
        entry.status = c.is_error ? "failed" : "completed";
        if (entry.kind === "command") entry.exitCode = exitCodeOf(c);
      }
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

/** True when a process command line is a print-mode Claude turn this runner may kill. */
export function matchesCmdline(cmdline) {
  const { program, words } = programOf(cmdline);
  if (!["claude", "claude.exe", "claude.js"].includes(program)) return false;
  return (words.includes("-p") || words.includes("--print")) && words.includes("stream-json");
}

// ---------- settings: model catalog, default model, CLI status ----------

const ALIASES = [
  { slug: "fable", name: "Fable", description: "The latest Fable model." },
  { slug: "opus", name: "Opus", description: "The latest Opus model." },
  { slug: "sonnet", name: "Sonnet", description: "The latest Sonnet model." },
  { slug: "haiku", name: "Haiku", description: "The latest Haiku model." },
];

/** The aliases `claude --model` accepts (the CLI has no command that lists models). */
export async function listModels() {
  return ALIASES.map(m => ({ ...m, efforts: [...efforts] }));
}

/** `model` in $CLAUDE_CONFIG_DIR/settings.json (default ~/.claude), or null. */
export function defaultModel() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).model;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}

function runClaude(args, timeout = 5000) {
  return new Promise(resolve => {
    const { cmd, args: argv } = resolveSpawn("claude", args);
    execFile(cmd, argv, { encoding: "utf8", timeout }, (err, stdout) => resolve({ ok: !err, stdout: stdout || "" }));
  });
}

/** `claude --version` and whether `claude auth status` reports a login. */
export async function cliInfo() {
  const version = await runClaude(["--version"]);
  if (!version.ok) return { version: null, loggedIn: false };
  const auth = await runClaude(["auth", "status"]);
  let loggedIn = false;
  try {
    loggedIn = auth.ok && JSON.parse(auth.stdout).loggedIn === true;
  } catch {}
  return { version: version.stdout.trim() || null, loggedIn };
}
