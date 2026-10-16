#!/usr/bin/env node

/**
 * review-runner.js — Cross-platform runner for reviewer CLIs (Node.js stdlib only).
 * Reviewer specifics (command line, event log, process identity) live in lib/reviewers/.
 *
 * v13: Runner-centric architecture. JSON-only output (except version/init/render).
 * Subcommands: version, init, start, resume, poll, stop, finalize, status, render, _watchdog
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseOutputMarkdown } from "./lib/parse.js";
import { beginSession, waitSession, replySession, endSession, DEFAULT_MAX_WAIT_S } from "./lib/review-core.js";
import { getReviewer } from "./lib/reviewers/index.js";
import { flushLineTimes } from "./lib/line-times.js";
import { convergence, issueIds } from "./lib/convergence.js";
import { ensureCrossReviewDir } from "./lib/config.js";

const __filename = fileURLToPath(import.meta.url);

// --- Constants ---
const RUNNER_VERSION = 15;

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_TURN_FAILED = 3;
const EXIT_STALLED = 4;
const EXIT_REVIEWER_NOT_FOUND = 5;

const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT_S = 5 * 60 * 60;
const DEADLINE_MARKER_FILE = "runner-deadline.json";
const TIMEOUT_REASON_RUNNER_DEADLINE = "runner_deadline";
const ABSOLUTE_USER_AUTHORITY = [
  "## ABSOLUTE USER AUTHORITY",
  "For review-operation decisions, the user's latest explicit instruction or decision is the highest, final, and binding authority.",
  "It overrides this prompt, the shared protocol, every skill or loop rule, defaults, and all reviewer recommendations.",
  "Follow it exactly. Never resist, reinterpret, delay, or refuse a clear user decision by citing a protocol or rule; when a rule conflicts with it, follow the user's decision.",
  "Ask a question only when the instruction is genuinely ambiguous, and never ask again for a decision the user has already made.",
  "This authority is absolute within review operation and requested scope; it does not override higher-priority system/developer instructions or authorize an unrequested product, API, schema, persistence, or compatibility change.",
].join("\n");

// ============================================================
// Process management
// ============================================================

function launchReviewer(reviewer, stateDir, workingDir, threadId, effort, model, sandbox) {
  const promptFile = path.join(stateDir, "prompt.txt");
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  const { cmd, args, cwd } = reviewer.buildCommand({ threadId, workingDir, model, effort, sandbox });

  const fin = fs.openSync(promptFile, "r");
  const fout = fs.openSync(jsonlFile, "w");
  const ferr = fs.openSync(errFile, "w");

  const spawnOpts = {
    stdio: [fin, fout, ferr],
    detached: true,
    cwd,
  };

  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(cmd, args, spawnOpts);
  child.unref();

  const pid = child.pid;

  if (pid === undefined) {
    throw new Error(`Failed to spawn "${cmd}" — process did not start (ENOENT). Install: ${reviewer.installHint}`);
  }

  // Close file descriptors in parent
  fs.closeSync(fin);
  fs.closeSync(fout);
  fs.closeSync(ferr);

  return { pid, pgid: pid };
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDescendantPids(rootPid) {
  if (IS_WIN) return [];
  const descendants = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const ppid = queue.shift();
    try {
      const result = spawnSync("pgrep", ["-P", String(ppid)], {
        encoding: "utf8", timeout: 5000,
      });
      if (result.status === 0 && result.stdout) {
        const children = result.stdout.trim().split("\n")
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n) && n > 0);
        for (const child of children) {
          if (!descendants.includes(child)) {
            descendants.push(child);
            queue.push(child);
          }
        }
      }
    } catch {
      continue;
    }
  }
  return descendants;
}

function syncSleep(ms) {
  const result = spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], {
    timeout: ms + 2000,
  });
  if (result.error) {
    try {
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.wait(view, 0, 0, ms);
    } catch {
      // Last resort: no sleep
    }
  }
}

function killTree(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }

    const descendants = getDescendantPids(pid);

    try { process.kill(-pid, "SIGTERM"); } catch {}
    for (const dpid of descendants) {
      try { process.kill(dpid, "SIGTERM"); } catch {}
    }

    syncSleep(2000);

    const rescanSeeds = [pid, ...descendants.filter(d => isAlive(d))];
    const rescanned = [];
    for (const seed of rescanSeeds) {
      for (const dp of getDescendantPids(seed)) {
        if (!rescanned.includes(dp)) rescanned.push(dp);
      }
    }
    const allPids = new Set([...descendants, ...rescanned]);

    try { process.kill(-pid, "SIGKILL"); } catch {}
    for (const dpid of allPids) {
      if (isAlive(dpid)) {
        try { process.kill(dpid, "SIGKILL"); } catch {}
      }
    }
  } catch {}
}

function killSingle(pid) {
  if (!pid || pid <= 1) return;
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    syncSleep(500);
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {}
}

function getCmdline(pid) {
  try {
    if (IS_WIN) {
      try {
        const result = spawnSync(
          "powershell",
          ["-NoProfile", "-Command",
           `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: "utf8", timeout: 10000 },
        );
        const cmdline = (result.stdout || "").trim();
        if (cmdline) return cmdline;
      } catch {}
      try {
        const result = spawnSync(
          "wmic",
          ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
          { encoding: "utf8", timeout: 5000 },
        );
        for (const line of (result.stdout || "").split("\n")) {
          if (line.startsWith("CommandLine=")) {
            return line.slice("CommandLine=".length).trim();
          }
        }
      } catch {}
      return null;
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return result.status === 0 ? (result.stdout || "").trim() : null;
  } catch {
    return null;
  }
}

function verifyReviewer(reviewer, pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  return reviewer.matchesCmdline(cmdline) ? "verified" : "mismatch";
}

function verifyWatchdog(pid) {
  if (!isAlive(pid)) return "dead";
  const cmdline = getCmdline(pid);
  if (cmdline === null) return "unknown";
  if (cmdline.includes("node") && cmdline.includes("_watchdog")) {
    return "verified";
  }
  return "mismatch";
}

function launchWatchdog(timeoutS, targetPid, stateDir, round) {
  const script = path.resolve(__filename);
  const nodeExe = process.execPath;
  const args = [script, "_watchdog", String(timeoutS), String(targetPid), stateDir, String(round)];

  const spawnOpts = {
    stdio: "ignore",
    detached: true,
  };
  if (IS_WIN) {
    spawnOpts.windowsHide = true;
  }

  const child = spawn(nodeExe, args, spawnOpts);
  child.unref();
  return child.pid;
}

// ============================================================
// File I/O
// ============================================================

function atomicWrite(filepath, content) {
  const dirpath = path.dirname(filepath);
  const tmpPath = path.join(dirpath, `.${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function deadlineMarkerPath(stateDir) {
  return path.join(stateDir, DEADLINE_MARKER_FILE);
}

function clearDeadlineMarker(stateDir) {
  try { fs.unlinkSync(deadlineMarkerPath(stateDir)); } catch {}
}

function writeDeadlineMarker(stateDir, timeoutS, round) {
  atomicWrite(deadlineMarkerPath(stateDir), JSON.stringify({
    reason: TIMEOUT_REASON_RUNNER_DEADLINE,
    timeout_seconds: timeoutS,
    round,
    marked_at: Math.floor(Date.now() / 1000),
  }, null, 2));
}

function hasDeadlineMarker(stateDir, round) {
  try {
    const marker = JSON.parse(fs.readFileSync(deadlineMarkerPath(stateDir), "utf8"));
    return marker.reason === TIMEOUT_REASON_RUNNER_DEADLINE && marker.round === round;
  } catch {
    return false;
  }
}

function normalizeThreadId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildPartialReview(stateDir, state, reviewText) {
  if (!reviewText) return null;
  try { atomicWrite(path.join(stateDir, "review.md"), reviewText); } catch {}
  return parseOutputMarkdown(reviewText, state.skill_name || "");
}

function readState(stateDir) {
  const stateFile = path.join(stateDir, "state.json");
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function updateState(stateDir, updates) {
  const state = readState(stateDir);
  Object.assign(state, updates);
  atomicWrite(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  return state;
}

function readRounds(stateDir) {
  const roundsFile = path.join(stateDir, "rounds.json");
  try {
    return JSON.parse(fs.readFileSync(roundsFile, "utf8"));
  } catch {
    return [];
  }
}

function writeRounds(stateDir, rounds) {
  atomicWrite(path.join(stateDir, "rounds.json"), JSON.stringify(rounds, null, 2));
}

// ============================================================
// Stdin reading
// ============================================================

function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let bytesRead;
  try {
    while (true) {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.slice(0, bytesRead)));
    }
  } catch {
    // EOF or pipe closed
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ============================================================
// JSON output helpers
// ============================================================

function jsonOut(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function jsonError(error, code = "UNKNOWN_ERROR") {
  jsonOut({ status: "error", error, code });
}


// ============================================================
// Round log parsing (the reviewer module reads its own event format)
// ============================================================

function parseRoundLog(reviewer, stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state, runnerDeadlineObserved = false) {
  const jsonlFile = path.join(stateDir, "output.jsonl");
  const errFile = path.join(stateDir, "error.log");

  let allLines = [];
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    allLines = content.split("\n").filter(l => l.trim());
  }

  const events = reviewer.parseEvents(allLines, allLines.slice(lastLineCount), elapsed);
  let turnCompleted = events.turnCompleted;
  const turnFailed = events.turnFailed;
  const turnFailedMsg = events.failMessage;
  const extractedThreadId = events.threadId;
  const reviewText = events.reviewText;
  const progressObserved = events.progressObserved;
  const activities = events.activities;

  function sanitizeMsg(s) {
    if (s == null) return "unknown error";
    return String(s).replace(/\s+/g, " ").trim();
  }

  // Determine status and build JSON result
  const currentRound = state.round || 1;
  const threadId = normalizeThreadId(extractedThreadId) || normalizeThreadId(state.thread_id);

  // Treat an explicit turn failure as terminal even if a malformed stream also
  // contains a completion event.
  if (turnFailed) turnCompleted = false;

  if (turnCompleted) {
    if (!threadId || !reviewText) {
      const errorDetail = !threadId ? "no thread_id" : "no agent_message";
      return {
        json: {
          status: "failed",
          round: currentRound,
          elapsed_seconds: elapsed,
          exit_code: EXIT_TURN_FAILED,
          error: `turn.completed but ${errorDetail}`,
          failure_reason: !threadId ? "missing_thread_id" : "missing_agent_message",
          recoverable: false,
          thread_id: threadId || null,
          progress_observed: progressObserved,
          review: buildPartialReview(stateDir, state, reviewText),
          activities,
        },
        extractedThreadId,
        reviewText,
        progressObserved,
        terminal: true,
      };
    }

    // Write review.md
    atomicWrite(path.join(stateDir, "review.md"), reviewText);

    // Parse the review
    const skillName = state.skill_name || "";
    const review = parseOutputMarkdown(reviewText, skillName);

    return {
      json: { status: "completed", round: currentRound, elapsed_seconds: elapsed, thread_id: threadId, review, activities },
      extractedThreadId,
      reviewText,
      terminal: true,
    };
  } else if (turnFailed) {
    return {
      json: {
        status: "failed",
        round: currentRound,
        elapsed_seconds: elapsed,
        exit_code: EXIT_TURN_FAILED,
        error: `${reviewer.label} turn failed: ${sanitizeMsg(turnFailedMsg)}`,
        failure_reason: "turn_failed",
        recoverable: false,
        thread_id: threadId || null,
        progress_observed: progressObserved,
        review: buildPartialReview(stateDir, state, reviewText),
        activities,
      },
      extractedThreadId,
      reviewText,
      progressObserved,
      terminal: true,
    };
  } else if (!processAlive) {
    if (runnerDeadlineObserved) {
      const recoverable = Boolean(threadId) && progressObserved;
      return {
        json: {
          status: "timeout",
          round: currentRound,
          elapsed_seconds: elapsed,
          exit_code: EXIT_TIMEOUT,
          error: `Timeout after ${timeoutVal}s`,
          timeout_reason: TIMEOUT_REASON_RUNNER_DEADLINE,
          recoverable,
          thread_id: threadId || null,
          progress_observed: progressObserved,
          review: buildPartialReview(stateDir, state, reviewText),
          activities,
        },
        extractedThreadId,
        reviewText,
        progressObserved,
        terminal: true,
      };
    } else {
      let errContent = "";
      if (fs.existsSync(errFile)) {
        errContent = fs.readFileSync(errFile, "utf8").trim();
      }
      let errorMsg = `${reviewer.label} process exited unexpectedly`;
      if (errContent) {
        errorMsg += ": " + sanitizeMsg(errContent.slice(0, 200));
      }
      return {
        json: {
          status: "failed",
          round: currentRound,
          elapsed_seconds: elapsed,
          exit_code: EXIT_ERROR,
          error: errorMsg,
          failure_reason: "reviewer_process_exit",
          recoverable: false,
          thread_id: threadId || null,
          progress_observed: progressObserved,
          review: buildPartialReview(stateDir, state, reviewText),
          activities,
        },
        extractedThreadId,
        reviewText,
        progressObserved,
        terminal: true,
      };
    }
  } else {
    return {
      json: { status: "running", round: currentRound, elapsed_seconds: elapsed, activities },
      extractedThreadId,
      reviewText,
      progressObserved,
      terminal: false,
    };
  }
}

// ============================================================
// Validation helpers
// ============================================================

function validateStateDir(stateDir) {
  let resolved;
  try {
    resolved = fs.realpathSync(stateDir);
  } catch {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { dir: null, err: "Invalid or missing state directory" };
  }

  const stateFile = path.join(resolved, "state.json");
  if (!fs.existsSync(stateFile)) {
    return { dir: null, err: "state.json not found" };
  }

  // Reconstruct expected path from state.json and compare
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const wd = fs.realpathSync(s.working_dir || "");
    const sid = s.session_id || "";
    if (!sid) {
      return { dir: null, err: "state.json missing session_id" };
    }
    const expected = path.join(wd, ".cross-review", "sessions", sid);
    const actual = fs.realpathSync(resolved);
    if (expected !== actual) {
      return { dir: null, err: "state directory path mismatch" };
    }
  } catch {
    return { dir: null, err: "state.json validation error" };
  }

  return { dir: resolved, err: null };
}

function verifyAndKillReviewer(reviewer, pid, pgid) {
  if (!pid || pid <= 1 || !pgid || pgid <= 1) return;
  const status = verifyReviewer(reviewer, pid);
  if (status === "verified" || status === "unknown") {
    killTree(pgid);
  }
}

function verifyAndKillWatchdog(pid) {
  if (!pid || pid <= 1) return;
  const status = verifyWatchdog(pid);
  if (status === "verified" || status === "unknown") {
    killSingle(pid);
  }
}

// ============================================================
// Template engine — cmdRender
// ============================================================

/** Template name → heading mapping per skill */
const TEMPLATE_MAP = {
  "review-plan": {
    "round1": "Plan Review Prompt (Round 1)",
    "rebuttal": "Rebuttal Prompt (Round 2+)",
  },
  "review-impl": {
    "working-tree-round1": "Working Tree Review Prompt (Round 1)",
    "branch-round1": "Branch Review Prompt (Round 1)",
    "rebuttal-working-tree": "Rebuttal Prompt — Working-tree mode (Round 2+)",
    "rebuttal-branch": "Rebuttal Prompt — Branch mode (Round 2+)",
  },
  "review-think": {
    "round1": "Round 1 Prompt",
    "analysis": "Independent Analysis Prompt",
    "round2+": "Round 2+ Response Prompt",
  },
  "review-pr": {
    "round1": "PR Review Prompt (Round 1)",
    "analysis": "Independent Analysis Prompt",
    "round2+": "Response Prompt (Round 2+)",
  },
};

/**
 * Extract a template section from prompts.md by heading.
 * Returns the content of the fenced code block within the section,
 * or the full section content if no fenced block found.
 */
function extractTemplateSection(promptsMd, targetHeading) {
  // Split by ## headings — but must be fence-aware to skip ## headings
  // that appear inside fenced code blocks (prompt templates often contain
  // ## headings as part of the prompt text).
  const lines = promptsMd.split("\n");
  let inTargetSection = false;
  let sectionLines = [];
  let found = false;
  let inFence = false;

  for (const line of lines) {
    // Track fenced code block boundaries
    if (line.trimEnd().match(/^```/)) {
      if (inTargetSection) {
        sectionLines.push(line);
        inFence = !inFence;
        continue;
      }
      inFence = !inFence;
    }

    // Only recognize ## headings when NOT inside a fenced block
    if (!inFence) {
      const headingMatch = line.match(/^## (.+)$/);
      if (headingMatch) {
        if (inTargetSection) {
          // We've left the target section
          break;
        }
        if (headingMatch[1].trim() === targetHeading) {
          inTargetSection = true;
          found = true;
          continue;
        }
      }
    }
    if (inTargetSection) {
      sectionLines.push(line);
    }
  }

  if (!found) return null;

  const sectionContent = sectionLines.join("\n");

  // Try to extract fenced code block
  const fenceRegex = /```[^\n]*\n([\s\S]*?)```/;
  const fenceMatch = sectionContent.match(fenceRegex);
  if (fenceMatch) {
    return fenceMatch[1];
  }

  // No fenced block found — use section content
  return sectionContent.trim();
}

/**
 * Parse the Placeholder Injection Guide table from prompts.md.
 * Returns Map of placeholder name (uppercase) → { required: boolean, default: string|null }
 */
function parsePlaceholderGuide(promptsMd) {
  const guide = new Map();

  // Find the Placeholder Injection Guide section
  const guideMatch = promptsMd.match(/## Placeholder Injection Guide\s*\n([\s\S]*?)(?=\n## |\n---|\n### [^P]|$)/);
  if (!guideMatch) return guide;

  // Parse table rows
  const tableContent = guideMatch[1];
  const rows = tableContent.split("\n").filter(line =>
    line.includes("|") && line.includes("`{") && !line.match(/^\|?\s*[-|]+\s*\|?$/)
  );

  for (const row of rows) {
    const cells = row.split("|").map(c => c.trim()).filter(c => c);
    if (cells.length >= 4) {
      // cells[0] = `{PLACEHOLDER}`, cells[1] = Source, cells[2] = Required, cells[3] = Default
      const nameMatch = cells[0].match(/`\{([A-Z_]+)\}`/);
      if (nameMatch) {
        const name = nameMatch[1];
        const required = cells[2].toLowerCase().includes("yes");
        const defaultVal = cells[3] === "—" || cells[3] === "-" ? null : cells[3].replace(/^`|`$/g, "").trim() || null;
        guide.set(name, { required, default: defaultVal });
      }
    }
  }

  return guide;
}

function cmdRender(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      skill: { type: "string" },
      template: { type: "string" },
      "skills-dir": { type: "string" },
    },
    strict: true,
  });

  const skill = values.skill;
  const templateName = values.template;
  const skillsDir = values["skills-dir"];

  if (!skill || !templateName || !skillsDir) {
    process.stderr.write("Error: --skill, --template, and --skills-dir are required\n");
    return EXIT_ERROR;
  }

  // Validate skill has templates
  const skillTemplates = TEMPLATE_MAP[skill];
  if (!skillTemplates) {
    jsonError(`Unknown skill: ${skill}`, "UNKNOWN_SKILL");
    return EXIT_ERROR;
  }

  const targetHeading = skillTemplates[templateName];
  if (!targetHeading) {
    jsonError(`Template '${templateName}' not found for skill '${skill}'. Available: ${Object.keys(skillTemplates).join(", ")}`, "TEMPLATE_NOT_FOUND");
    return EXIT_ERROR;
  }

  // Read prompts.md
  const promptsPath = path.join(skillsDir, skill, "references", "prompts.md");
  let promptsMd;
  try {
    promptsMd = fs.readFileSync(promptsPath, "utf8");
  } catch (e) {
    jsonError(`Cannot read prompts.md: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Extract template
  const template = extractTemplateSection(promptsMd, targetHeading);
  if (template === null) {
    jsonError(`Template heading '${targetHeading}' not found in prompts.md`, "TEMPLATE_NOT_FOUND");
    return EXIT_ERROR;
  }

  // Read placeholders from stdin JSON
  let placeholders = {};
  const stdinContent = readStdinSync().trim();
  if (stdinContent) {
    try {
      placeholders = JSON.parse(stdinContent);
    } catch (e) {
      jsonError(`Invalid JSON on stdin: ${e.message}`, "INVALID_INPUT");
      return EXIT_ERROR;
    }
  }

  // Auto-inject {OUTPUT_FORMAT}
  const outputFormatPath = path.join(skillsDir, skill, "references", "output-format.md");
  if (fs.existsSync(outputFormatPath) && !placeholders.OUTPUT_FORMAT) {
    const outputFormatMd = fs.readFileSync(outputFormatPath, "utf8");
    // Extract the fenced code block after "Use this exact shape"
    const fenceMatch = outputFormatMd.match(/```(?:markdown)?\n([\s\S]*?)```/);
    placeholders.OUTPUT_FORMAT = fenceMatch ? fenceMatch[1].trim() : outputFormatMd.trim();
  }

  // Auto-inject {ANALYSIS_FORMAT}
  const analysisPath = path.join(skillsDir, skill, "references", "analysis-template.md");
  if (fs.existsSync(analysisPath) && !placeholders.ANALYSIS_FORMAT) {
    const analysisMd = fs.readFileSync(analysisPath, "utf8");
    const fenceMatch = analysisMd.match(/```(?:markdown)?\n([\s\S]*?)```/);
    placeholders.ANALYSIS_FORMAT = fenceMatch ? fenceMatch[1].trim() : analysisMd.trim();
  }

  // Parse placeholder guide for defaults and required fields
  const guide = parsePlaceholderGuide(promptsMd);

  // Replace all {PLACEHOLDER} patterns
  // Require min 2 chars to avoid matching {N} in "ISSUE-{N}" format strings.
  // All real placeholders have underscores (e.g. {USER_REQUEST}, {OUTPUT_FORMAT}).
  // Put the authority rule first so every rendered prompt (reviewer or orchestrator) sees it,
  // including templates that do not repeat the shared protocol section.
  let rendered = `${ABSOLUTE_USER_AUTHORITY}\n\n${template}`;
  const placeholderRegex = /\{([A-Z][A-Z_0-9]{1,})\}/g;
  const missingRequired = [];

  rendered = rendered.replace(placeholderRegex, (match, name) => {
    // Check stdin JSON first
    if (placeholders[name] !== undefined && placeholders[name] !== null) {
      return String(placeholders[name]);
    }

    // Check guide defaults
    const guideEntry = guide.get(name);
    if (guideEntry && guideEntry.default !== null) {
      return guideEntry.default;
    }

    // Check if required
    if (guideEntry && guideEntry.required) {
      missingRequired.push(name);
      return match; // Leave as-is for error reporting
    }

    // Not required, no default → empty string
    return "";
  });

  if (missingRequired.length > 0) {
    jsonError(`Missing required placeholder(s): ${missingRequired.map(n => `{${n}}`).join(", ")}`, "MISSING_PLACEHOLDER");
    return EXIT_ERROR;
  }

  // Validation: warn about remaining unresolved placeholders on stderr
  const remaining = rendered.match(/\{[A-Z][A-Z_0-9]{1,}\}/g);
  if (remaining) {
    process.stderr.write(`Warning: unresolved placeholders in rendered prompt: ${remaining.join(", ")}\n`);
  }

  // Output rendered prompt as plain text
  process.stdout.write(rendered);
  return EXIT_SUCCESS;
}

// ============================================================
// Subcommands — v13
// ============================================================

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "skill-name": { type: "string" },
      "working-dir": { type: "string" },
      reviewer: { type: "string" },
    },
    strict: true,
  });

  const skillName = values["skill-name"];
  const workingDir = values["working-dir"];
  let reviewer;
  try {
    reviewer = getReviewer(values.reviewer);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    return EXIT_ERROR;
  }

  if (!skillName) {
    process.stderr.write("Error: --skill-name is required\n");
    return EXIT_ERROR;
  }
  if (!workingDir) {
    process.stderr.write("Error: --working-dir is required\n");
    return EXIT_ERROR;
  }

  let resolvedWorkingDir;
  try {
    resolvedWorkingDir = fs.realpathSync(workingDir);
  } catch {
    process.stderr.write(`Error: working directory does not exist: ${workingDir}\n`);
    return EXIT_ERROR;
  }

  // Generate session ID: {skill}-{yyyymmdd}-{NNN}
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `${skillName}-${today}-`;
  const sessionsBase = path.join(resolvedWorkingDir, ".cross-review", "sessions");
  // Keep review artifacts out of the user's git history
  ensureCrossReviewDir(resolvedWorkingDir);
  fs.mkdirSync(sessionsBase, { recursive: true });

  let maxN = 0;
  try {
    for (const d of fs.readdirSync(sessionsBase)) {
      if (d.startsWith(prefix)) {
        const n = parseInt(d.slice(prefix.length), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  } catch {}

  // Atomic session dir creation — retry on EEXIST (parallel init race)
  let sessionDir;
  let sessionId;
  let created = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    sessionId = `${prefix}${String(maxN + 1 + attempt).padStart(3, "0")}`;
    sessionDir = path.join(sessionsBase, sessionId);
    try {
      fs.mkdirSync(sessionDir);
      created = true;
      break;
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }

  if (!created) {
    process.stderr.write("Error: could not reserve session directory after 10 attempts\n");
    return EXIT_ERROR;
  }

  // Create subdirectories
  fs.mkdirSync(path.join(sessionDir, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "outputs"), { recursive: true });

  // Write initial state.json
  const now = Math.floor(Date.now() / 1000);
  const initialState = {
    session_id: sessionId,
    runner_version: RUNNER_VERSION,
    skill_name: skillName,
    reviewer: reviewer.name,
    state_dir: sessionDir,
    working_dir: resolvedWorkingDir,
    round: 0,
    created_at: now,
    pid: null,
    pgid: null,
    watchdog_pid: null,
    effort: null,
    sandbox: null,
    timeout: null,
    started_at: null,
    thread_id: null,
    last_line_count: 0,
    stall_count: 0,
    last_poll_at: null,
  };
  atomicWrite(path.join(sessionDir, "state.json"), JSON.stringify(initialState, null, 2));

  // Output plain text (unchanged from v12)
  process.stdout.write(`SESSION:${sessionDir}\n`);
  return EXIT_SUCCESS;
}

function cmdStart(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    jsonError("Session directory argument required", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      model: { type: "string" },
      effort: { type: "string", default: "high" },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_S) },
      sandbox: { type: "string" },
      "stall-threshold": { type: "string", default: "" },
    },
    strict: true,
  });

  const effort = values.effort || "high";
  const timeout = parseInt(values.timeout || String(DEFAULT_TIMEOUT_S), 10);
  const stallThreshold = parseInt(values["stall-threshold"] || "12", 10);

  if (isNaN(stallThreshold) || stallThreshold < 1) {
    jsonError("--stall-threshold must be a positive integer (>= 1)", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  // Validate session dir exists
  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read state.json — must exist with round == 0
  let state;
  try {
    state = readState(resolvedSessionDir);
  } catch (e) {
    jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  if (state.round !== 0) {
    jsonError("Session already started (round != 0). Use resume for subsequent rounds.", "PRECONDITION_FAILED");
    return EXIT_ERROR;
  }

  const resolvedWorkingDir = state.working_dir || path.resolve(resolvedSessionDir, "..", "..", "..");
  const sessionId = state.session_id || path.basename(resolvedSessionDir);
  const skillName = state.skill_name || "";

  let reviewer;
  try {
    reviewer = getReviewer(state.reviewer);
  } catch (e) {
    jsonError(e.message, e.code);
    return EXIT_ERROR;
  }
  const sandbox = values.sandbox || reviewer.defaultSandbox;
  if (!reviewer.sandboxes.includes(sandbox)) {
    jsonError(`--sandbox must be one of: ${reviewer.sandboxes.join(", ")}`, "INVALID_INPUT");
    return EXIT_ERROR;
  }
  if (!reviewer.isAvailable()) {
    jsonError(`${reviewer.name} CLI not found in PATH. Install: ${reviewer.installHint}`, "REVIEWER_NOT_FOUND");
    return EXIT_REVIEWER_NOT_FOUND;
  }

  // Read prompt from stdin, write to prompt.txt + prompts/round-001.txt
  const promptFile = path.join(resolvedSessionDir, "prompt.txt");
  let prompt;

  // v13: prefer stdin (piped from render), fallback to pre-written prompt.txt
  const stdinContent = readStdinSync();
  if (stdinContent.trim()) {
    prompt = stdinContent;
    fs.writeFileSync(promptFile, prompt, "utf8");
  } else if (fs.existsSync(promptFile)) {
    const fileContent = fs.readFileSync(promptFile, "utf8");
    if (fileContent.trim()) prompt = fileContent;
  }

  if (!prompt || !prompt.trim()) {
    jsonError("No prompt provided (pipe via stdin or pre-write prompt.txt)", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  // Archive prompt
  fs.writeFileSync(path.join(resolvedSessionDir, "prompts", "round-001.txt"), prompt, "utf8");

  // Track for rollback
  let reviewerPgid = null;
  let watchdogPid = null;

  clearDeadlineMarker(resolvedSessionDir);

  function startupCleanup() {
    if (reviewerPgid !== null) killTree(reviewerPgid);
    if (watchdogPid !== null && isAlive(watchdogPid)) killSingle(watchdogPid);
  }

  try {
    const { pid: reviewerPid, pgid } = launchReviewer(
      reviewer, resolvedSessionDir, resolvedWorkingDir, "", effort, values.model, sandbox,
    );
    reviewerPgid = pgid;

    watchdogPid = launchWatchdog(timeout, reviewerPgid, resolvedSessionDir, 1);

    // Update state.json
    const now = Math.floor(Date.now() / 1000);
    updateState(resolvedSessionDir, {
      round: 1,
      pid: reviewerPid,
      pgid: reviewerPgid,
      watchdog_pid: watchdogPid,
      effort,
      model: values.model || null,
      sandbox,
      timeout,
      started_at: now,
      thread_id: null,
      last_line_count: 0,
      stall_count: 0,
      last_poll_at: 0,
      stall_threshold: stallThreshold,
      stall_recovery_count: 0,
    });

    // Create rounds.json
    writeRounds(resolvedSessionDir, [{
      round: 1,
      started_at: now,
      completed_at: null,
      elapsed_seconds: null,
      status: "running",
      verdict: null,
      issues_found: null,
    }]);

  } catch (e) {
    startupCleanup();

    // Mark round as start_failed if rounds.json was created
    try {
      const rounds = readRounds(resolvedSessionDir);
      if (rounds.length > 0 && rounds[rounds.length - 1].status === "running") {
        rounds[rounds.length - 1].status = "start_failed";
        rounds[rounds.length - 1].completed_at = Math.floor(Date.now() / 1000);
        writeRounds(resolvedSessionDir, rounds);
      }
    } catch {}

    jsonError(e.message, "LAUNCH_FAILED");
    return EXIT_ERROR;
  }

  // Success — JSON output
  jsonOut({ status: "started", session_dir: resolvedSessionDir, round: 1 });
  return EXIT_SUCCESS;
}

function cmdResume(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    jsonError("Session directory argument required", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      model: { type: "string" },
      effort: { type: "string", default: "high" },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_S) },
      "stall-threshold": { type: "string", default: "" },
      recovery: { type: "boolean", default: false },
    },
    strict: true,
  });

  const effort = values.effort || "high";
  const timeout = parseInt(values.timeout || String(DEFAULT_TIMEOUT_S), 10);

  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read state
  let prevState;
  try {
    prevState = readState(resolvedSessionDir);
  } catch (e) {
    jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  const explicitThreshold = values["stall-threshold"];
  const stallThreshold = explicitThreshold ? parseInt(explicitThreshold, 10) : (prevState.stall_threshold || 12);

  if (isNaN(stallThreshold) || stallThreshold < 1) {
    jsonError("--stall-threshold must be a positive integer (>= 1)", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  const recoveryCount = prevState.stall_recovery_count || 0;
  const isRecovery = values.recovery;
  const newRecoveryCount = isRecovery ? recoveryCount + 1 : recoveryCount;
  const effectiveStallThreshold = isRecovery ? Math.min(stallThreshold, 8) : stallThreshold;

  const threadId = prevState.thread_id || "";
  const resolvedWorkingDir = prevState.working_dir || "";
  const sessionId = prevState.session_id || path.basename(resolvedSessionDir);
  const currentRound = prevState.round || 0;

  if (!threadId) {
    jsonError("No thread_id found in state.json — cannot resume (session may have failed on start)", "SESSION_BROKEN");
    return EXIT_ERROR;
  }

  if (!resolvedWorkingDir) {
    jsonError("No working_dir found in state.json", "IO_ERROR");
    return EXIT_ERROR;
  }

  // Check rounds.json — last round must NOT be "running"
  const rounds = readRounds(resolvedSessionDir);
  if (rounds.length > 0) {
    const lastRound = rounds[rounds.length - 1];
    if (lastRound.status === "running") {
      jsonError("Round still running — poll first before resuming", "ROUND_STILL_RUNNING");
      return EXIT_ERROR;
    }
    if (lastRound.status === "start_failed") {
      jsonError("Session broken — previous round failed to start (no thread_id)", "SESSION_BROKEN");
      return EXIT_ERROR;
    }
  }

  let reviewer;
  try {
    reviewer = getReviewer(prevState.reviewer);
  } catch (e) {
    jsonError(e.message, e.code);
    return EXIT_ERROR;
  }
  if (!reviewer.isAvailable()) {
    jsonError(`${reviewer.name} CLI not found in PATH. Install: ${reviewer.installHint}`, "REVIEWER_NOT_FOUND");
    return EXIT_REVIEWER_NOT_FOUND;
  }

  // Read prompt from stdin
  const promptFile = path.join(resolvedSessionDir, "prompt.txt");
  let prompt;
  const stdinContent = readStdinSync();
  if (stdinContent.trim()) {
    prompt = stdinContent;
    fs.writeFileSync(promptFile, prompt, "utf8");
  } else if (fs.existsSync(promptFile)) {
    const fileContent = fs.readFileSync(promptFile, "utf8");
    if (fileContent.trim()) prompt = fileContent;
  }

  if (!prompt || !prompt.trim()) {
    jsonError("No prompt provided (pipe via stdin or pre-write prompt.txt)", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  const newRound = currentRound + 1;

  // Archive prompt
  fs.writeFileSync(
    path.join(resolvedSessionDir, "prompts", `round-${String(newRound).padStart(3, "0")}.txt`),
    prompt, "utf8",
  );

  // Stamp the previous round's last lines before its log is archived and reopened
  if (currentRound > 0) flushLineTimes(resolvedSessionDir, currentRound);

  // Archive current round artifacts before any active file is cleared.
  const jsonlFile = path.join(resolvedSessionDir, "output.jsonl");
  const reviewFile = path.join(resolvedSessionDir, "review.md");
  const finalFile = path.join(resolvedSessionDir, "final.txt");
  const roundLabel = String(currentRound).padStart(3, "0");
  try {
    if (fs.existsSync(jsonlFile)) {
      fs.copyFileSync(
        jsonlFile,
        path.join(resolvedSessionDir, "outputs", `output-round-${roundLabel}.jsonl`),
      );
    }
    if (fs.existsSync(reviewFile)) {
      fs.copyFileSync(
        reviewFile,
        path.join(resolvedSessionDir, "outputs", `review-round-${roundLabel}.md`),
      );
    }
    if (fs.existsSync(finalFile)) {
      fs.copyFileSync(
        finalFile,
        path.join(resolvedSessionDir, "outputs", `final-round-${roundLabel}.json`),
      );
    }
  } catch (e) {
    jsonError(`Cannot archive previous round artifacts: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Clear stale artifacts
  try {
    if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
    if (fs.existsSync(reviewFile)) fs.unlinkSync(reviewFile);
  } catch (e) {
    jsonError(`Cannot clear archived round artifacts: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Track for rollback
  let reviewerPgid = null;
  let watchdogPid = null;

  clearDeadlineMarker(resolvedSessionDir);

  function startupCleanup() {
    if (reviewerPgid !== null) killTree(reviewerPgid);
    if (watchdogPid !== null && isAlive(watchdogPid)) killSingle(watchdogPid);
  }

  try {
    const { pid: reviewerPid, pgid } = launchReviewer(
      reviewer, resolvedSessionDir, resolvedWorkingDir, threadId, effort, values.model,
      prevState.sandbox || reviewer.defaultSandbox,
    );
    reviewerPgid = pgid;

    watchdogPid = launchWatchdog(timeout, reviewerPgid, resolvedSessionDir, newRound);

    // Update state.json
    const now = Math.floor(Date.now() / 1000);
    updateState(resolvedSessionDir, {
      round: newRound,
      pid: reviewerPid,
      pgid: reviewerPgid,
      watchdog_pid: watchdogPid,
      effort,
      timeout,
      started_at: now,
      thread_id: threadId,
      last_line_count: 0,
      stall_count: 0,
      last_poll_at: 0,
      last_output_at: now,
      stall_recovery_count: newRecoveryCount,
      stall_threshold: effectiveStallThreshold,
      ...(values.model ? { model: values.model } : {}),
    });

    // Append new round to rounds.json
    rounds.push({
      round: newRound,
      started_at: now,
      completed_at: null,
      elapsed_seconds: null,
      status: "running",
      verdict: null,
      issues_found: null,
    });
    writeRounds(resolvedSessionDir, rounds);

  } catch (e) {
    startupCleanup();
    jsonError(e.message, "LAUNCH_FAILED");
    return EXIT_ERROR;
  }

  // Success
  jsonOut({ status: "started", session_dir: resolvedSessionDir, round: newRound, thread_id: threadId });
  return EXIT_SUCCESS;
}

function cmdPoll(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    jsonError("Invalid or missing state directory", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  // Parse --min-interval flag (default 120s)
  let minInterval = 120;
  const filteredArgv = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min-interval" && i + 1 < argv.length) {
      minInterval = parseInt(argv[++i], 10);
      if (isNaN(minInterval) || minInterval < 0) minInterval = 120;
    } else {
      filteredArgv.push(argv[i]);
    }
  }

  const { dir: stateDir, err } = validateStateDir(filteredArgv[0] || stateDirArg);
  if (err) {
    jsonError(err, "INVALID_INPUT");
    return EXIT_ERROR;
  }

  // Check for cached final result
  const finalFile = path.join(stateDir, "final.txt");
  if (fs.existsSync(finalFile)) {
    const cached = fs.readFileSync(finalFile, "utf8");
    process.stdout.write(cached);
    if (!cached.endsWith("\n")) process.stdout.write("\n");
    return EXIT_SUCCESS;
  }

  // Throttle: wait until min-interval elapsed OR process completes
  if (minInterval > 0) {
    const stateFile = path.join(stateDir, "state.json");
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const lastPoll = s.last_poll_at || 0;
      const now = Math.floor(Date.now() / 1000);
      const remaining = minInterval - (now - lastPoll);
      if (remaining > 0 && lastPoll > 0) {
        // Sleep in 2s increments, check for completion each iteration
        let waited = 0;
        while (waited < remaining) {
          const chunk = Math.min(2000, (remaining - waited) * 1000);
          syncSleep(chunk);
          waited += chunk / 1000;
          // Early exit if process completed (final.txt appeared)
          if (fs.existsSync(finalFile)) {
            const cached = fs.readFileSync(finalFile, "utf8");
            process.stdout.write(cached);
            if (!cached.endsWith("\n")) process.stdout.write("\n");
            return EXIT_SUCCESS;
          }
        }
      }
    } catch {
      // state.json unreadable — proceed without throttle
    }
  }

  // Read state
  const state = readState(stateDir);
  const reviewer = getReviewer(state.reviewer);
  const reviewerPid = state.pid || 0;
  const reviewerPgid = state.pgid || 0;
  const watchdogPid = state.watchdog_pid || 0;
  const timeoutVal = state.timeout || DEFAULT_TIMEOUT_S;
  const startedAt = state.started_at || Math.floor(Date.now() / 1000);
  const lastLineCount = state.last_line_count || 0;
  const stallCount = state.stall_count || 0;
  const stallThresholdFromState = state.stall_threshold || 12;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - startedAt;

  const processAlive = isAlive(reviewerPid);
  const deadlineReached = timeoutVal > 0 && elapsed >= timeoutVal;
  const runnerDeadlineObserved = deadlineReached
    && (processAlive || hasDeadlineMarker(stateDir, state.round || 1));

  // Count lines for stall detection
  const jsonlFile = path.join(stateDir, "output.jsonl");
  let currentLineCount = 0;
  if (fs.existsSync(jsonlFile)) {
    const content = fs.readFileSync(jsonlFile, "utf8");
    currentLineCount = content.split("\n").filter((l) => l.trim()).length;
  }

  const newStallCount = currentLineCount === lastLineCount
    ? stallCount + 1
    : 0;

  // Track when output last changed for accurate stall duration
  const lastOutputAt = currentLineCount === lastLineCount
    ? (state.last_output_at || startedAt)
    : now;

  // Parse the round log → structured JSON
  let result = parseRoundLog(
    reviewer, stateDir, lastLineCount, elapsed, processAlive, timeoutVal, state, runnerDeadlineObserved,
  );

  // Override: stall/timeout detection for still-running process
  if (!result.terminal) {
    if (deadlineReached) {
      try { writeDeadlineMarker(stateDir, timeoutVal, state.round || 1); } catch {}

      // Recover partial output if available
      const partialReview = buildPartialReview(stateDir, state, result.reviewText);
      const threadId = normalizeThreadId(result.extractedThreadId) || normalizeThreadId(state.thread_id);
      const progressObserved = result.progressObserved === true;

      result = {
        json: {
          status: "timeout",
          round: state.round || 1,
          elapsed_seconds: elapsed,
          exit_code: EXIT_TIMEOUT,
          error: `Timeout after ${timeoutVal}s`,
          timeout_reason: TIMEOUT_REASON_RUNNER_DEADLINE,
          recoverable: Boolean(threadId) && progressObserved,
          thread_id: threadId || null,
          progress_observed: progressObserved,
          review: partialReview,
          activities: result.json.activities,
        },
        extractedThreadId: result.extractedThreadId,
        reviewText: result.reviewText,
        progressObserved,
        terminal: true,
      };
    } else if (newStallCount >= stallThresholdFromState && processAlive) {
      // Recover partial output if available
      const partialReview = buildPartialReview(stateDir, state, result.reviewText);
      const threadId = normalizeThreadId(result.extractedThreadId) || normalizeThreadId(state.thread_id);

      result = {
        json: {
          status: "stalled",
          round: state.round || 1,
          elapsed_seconds: elapsed,
          exit_code: EXIT_STALLED,
          error: `No new output for ~${Math.round((now - lastOutputAt) / 60)} minutes`,
          review: partialReview,
          failure_reason: "stalled",
          recoverable: false,
          thread_id: threadId || null,
          progress_observed: result.progressObserved === true,
          activities: result.json.activities,
        },
        extractedThreadId: result.extractedThreadId,
        reviewText: result.reviewText || "",
        progressObserved: result.progressObserved === true,
        terminal: true,
      };
    }
  }

  // Crash recovery: if round is running but process dead and no turn.completed
  if (!result.terminal && !processAlive) {
    const rounds = readRounds(stateDir);
    const currentRoundObj = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    if (currentRoundObj && currentRoundObj.status === "running") {
      currentRoundObj.status = "failed";
      currentRoundObj.completed_at = state.last_poll_at || now;
      currentRoundObj.elapsed_seconds = (currentRoundObj.completed_at || now) - currentRoundObj.started_at;
      writeRounds(stateDir, rounds);
    }
  }

  if (result.extractedThreadId) {
    updateState(stateDir, { thread_id: result.extractedThreadId });
  }

  if (result.terminal) {
    if (result.json.status !== "timeout") {
      clearDeadlineMarker(stateDir);
    }

    // Update rounds.json FIRST (before caching) so convergence can be computed
    const rounds = readRounds(stateDir);
    if (rounds.length > 0) {
      const currentRoundObj = rounds[rounds.length - 1];
      if (currentRoundObj.status === "running") {
        currentRoundObj.status = result.json.status; // completed/failed/timeout/stalled
        currentRoundObj.completed_at = now;
        currentRoundObj.elapsed_seconds = now - currentRoundObj.started_at;

        // Extract verdict, issues_found, and issue_ids from parsed review
        if (result.json.review) {
          const review = result.json.review;
          if (review.verdict && review.verdict.status) {
            currentRoundObj.verdict = review.verdict.status;
          }
          if (review.blocks) {
            currentRoundObj.issues_found = review.blocks.length;
            // Store issue IDs for convergence detection
            currentRoundObj.issue_ids = issueIds(review);
          }
          if (review.suggested_status) {
            currentRoundObj.verdict = review.suggested_status;
          }
        }

        writeRounds(stateDir, rounds);

        // Convergence / stalemate detection
        if (result.json.status === "completed" && rounds.length >= 2) {
          const c = convergence(rounds[rounds.length - 2].issue_ids, currentRoundObj.issue_ids);
          if (c) result.json.convergence = c;
        }
      }
    }

    // Cache final JSON (after convergence is computed) and cleanup
    const jsonStr = JSON.stringify(result.json);
    atomicWrite(path.join(stateDir, "final.txt"), jsonStr);

    verifyAndKillReviewer(reviewer, reviewerPid, reviewerPgid);
    // Stamp the last lines, including any written while the reviewer shut down, before
    // the watchdog that stamps them otherwise is killed
    flushLineTimes(stateDir, state.round || 1);
    if (watchdogPid) verifyAndKillWatchdog(watchdogPid);
  }

  // Update state.json
  updateState(stateDir, {
    last_line_count: currentLineCount,
    stall_count: newStallCount,
    last_output_at: lastOutputAt,
    last_poll_at: now,
  });

  jsonOut(result.json);
  return EXIT_SUCCESS;
}

function cmdStop(argv) {
  const stateDirArg = argv[0];
  if (!stateDirArg) {
    jsonError("State directory argument required", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  const { dir: stateDir, err } = validateStateDir(stateDirArg);
  if (err) {
    jsonError(err, "INVALID_INPUT");
    return EXIT_ERROR;
  }

  // Read state and kill processes
  try {
    const state = readState(stateDir);
    const reviewerPid = state.pid || 0;
    const reviewerPgid = state.pgid || 0;
    const watchdogPid = state.watchdog_pid || 0;

    if (reviewerPid && reviewerPgid) {
      verifyAndKillReviewer(getReviewer(state.reviewer), reviewerPid, reviewerPgid);
    }
    flushLineTimes(stateDir, state.round || 1);
    if (watchdogPid) {
      verifyAndKillWatchdog(watchdogPid);
    }

    // Update running round to "stopped"
    const rounds = readRounds(stateDir);
    const now = Math.floor(Date.now() / 1000);
    let modified = false;
    for (const round of rounds) {
      if (round.status === "running") {
        round.status = "stopped";
        round.completed_at = now;
        round.elapsed_seconds = now - round.started_at;
        modified = true;
      }
    }
    if (modified) {
      writeRounds(stateDir, rounds);
    }
  } catch {
    // State may be corrupted, proceed to output
  }

  jsonOut({ status: "stopped", session_dir: stateDir });
  return EXIT_SUCCESS;
}

function cmdFinalize(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    jsonError("Session directory argument required", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read state
  let state;
  try {
    state = readState(resolvedSessionDir);
  } catch (e) {
    jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read rounds
  const rounds = readRounds(resolvedSessionDir);

  // Check precondition: no running rounds
  for (const round of rounds) {
    if (round.status === "running") {
      jsonError("Cannot finalize: round " + round.round + " is still running", "PRECONDITION_FAILED");
      return EXIT_ERROR;
    }
  }

  // Read override from stdin
  let overrides = {};
  const stdinContent = readStdinSync().trim();
  if (stdinContent) {
    try {
      overrides = JSON.parse(stdinContent);
    } catch (e) {
      jsonError(`Invalid JSON on stdin: ${e.message}`, "INVALID_INPUT");
      return EXIT_ERROR;
    }
  }

  // Compute timing
  const perRound = rounds.map(r => r.elapsed_seconds || 0);
  const totalSeconds = perRound.reduce((a, b) => a + b, 0);

  // Determine verdict
  let verdict = overrides.verdict;
  if (!verdict) {
    // Only the last round counts; an older round's verdict is stale
    const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
    verdict = lastRound ? lastRound.verdict : null;
  }

  if (!verdict) {
    jsonError("Last round has no verdict — read its review.md and pass the verdict via stdin, e.g. {\"verdict\":\"APPROVE\"}", "PRECONDITION_FAILED");
    return EXIT_ERROR;
  }

  // Build meta.json
  const reviewer = getReviewer(state.reviewer);
  const meta = {
    skill: state.skill_name || "",
    reviewer: reviewer.name,
    runner_version: RUNNER_VERSION,
    effort: state.effort || "high",
    sandbox: state.sandbox || reviewer.defaultSandbox,
    scope: overrides.scope || null,
    base_branch: overrides.base_branch || null,
    rounds: rounds.length,
    verdict,
    timing: {
      total_seconds: totalSeconds,
      per_round: perRound,
    },
    timestamp: new Date().toISOString(),
    session_dir: resolvedSessionDir,
  };

  // Add optional override fields
  if (overrides.custom_notes) meta.custom_notes = overrides.custom_notes;
  if (overrides.issues) meta.issues = overrides.issues;

  // Write meta.json
  atomicWrite(path.join(resolvedSessionDir, "meta.json"), JSON.stringify(meta, null, 2));

  jsonOut({ status: "finalized", meta });
  return EXIT_SUCCESS;
}

function cmdStatus(argv) {
  const sessionDir = argv[0];
  if (!sessionDir) {
    jsonError("Session directory argument required", "INVALID_INPUT");
    return EXIT_ERROR;
  }

  let resolvedSessionDir;
  try {
    resolvedSessionDir = fs.realpathSync(sessionDir);
  } catch {
    jsonError(`Session directory does not exist: ${sessionDir}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read state
  let state;
  try {
    state = readState(resolvedSessionDir);
  } catch (e) {
    jsonError(`Cannot read state.json: ${e.message}`, "IO_ERROR");
    return EXIT_ERROR;
  }

  // Read rounds (may not exist yet)
  const rounds = readRounds(resolvedSessionDir);

  // Check for review.md and meta.json
  const hasReview = fs.existsSync(path.join(resolvedSessionDir, "review.md"));
  const hasMeta = fs.existsSync(path.join(resolvedSessionDir, "meta.json"));

  const result = {
    status: "ok",
    session_id: state.session_id,
    skill: state.skill_name,
    reviewer: getReviewer(state.reviewer).name,
    runner_version: state.runner_version || RUNNER_VERSION,
    round: state.round,
    effort: state.effort,
    sandbox: state.sandbox,
    thread_id: state.thread_id,
    created_at: state.created_at,
    rounds: rounds.map(r => ({
      round: r.round,
      started_at: r.started_at,
      completed_at: r.completed_at || null,
      elapsed_seconds: r.elapsed_seconds || null,
      status: r.status,
      verdict: r.verdict || null,
      issues_found: r.issues_found != null ? r.issues_found : null,
    })),
    has_review: hasReview,
    has_meta: hasMeta,
  };

  jsonOut(result);
  return EXIT_SUCCESS;
}

function cmdWatchdog(argv) {
  const timeoutS = parseInt(argv[0], 10);
  const targetPid = parseInt(argv[1], 10);
  const stateDir = argv[2] || "";
  const round = parseInt(argv[3], 10);

  if (isNaN(timeoutS) || isNaN(targetPid)) {
    process.stderr.write("Error: _watchdog requires <timeout> <pid>\n");
    return EXIT_ERROR;
  }

  // Detach from parent session on Unix
  if (!IS_WIN) {
    try {
      process.setsid && process.setsid();
    } catch {
      // setsid may not be available in all Node.js builds
    }
  }

  // Stamp output lines with wall-clock times (Codex's event log has none) and exit once
  // the reviewer is gone. Without a session dir only the deadline below applies.
  const stamping = Boolean(stateDir) && Number.isInteger(round) && round >= 1;
  const cursor = {};
  if (stamping) {
    flushLineTimes(stateDir, round, cursor);
    const tick = setInterval(() => {
      const alive = isAlive(targetPid);
      flushLineTimes(stateDir, round, cursor);
      if (!alive) {
        clearInterval(tick);
        process.exit(EXIT_SUCCESS);
      }
    }, 1000);
  }

  setTimeout(() => {
    if (isAlive(targetPid)) {
      if (stamping) {
        flushLineTimes(stateDir, round, cursor);
        try { writeDeadlineMarker(stateDir, timeoutS, round); } catch {}
      }
      killTree(targetPid);
      // The reviewer may write while it shuts down; killTree waits for that
      if (stamping) flushLineTimes(stateDir, round, cursor);
    }
    process.exit(EXIT_SUCCESS);
  }, timeoutS * 1000);

  return -1; // Signal: don't exit immediately
}

// ============================================================
// High-level verbs — v14 (begin / wait / reply / end)
// ============================================================

async function runVerb(fn) {
  try {
    const result = await fn();
    jsonOut(result);
    // `end` reports a failed finalize in `error` after still stopping the session
    return result && result.error ? EXIT_ERROR : EXIT_SUCCESS;
  } catch (e) {
    jsonError(e.message, e.code || "UNKNOWN_ERROR");
    return e.code === "REVIEWER_NOT_FOUND" ? EXIT_REVIEWER_NOT_FOUND : EXIT_ERROR;
  }
}

function cmdBegin(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      skill: { type: "string" },
      mode: { type: "string" },
      input: { type: "string" },
      "working-dir": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      timeout: { type: "string" },
      reviewer: { type: "string" },
      "skills-dir": { type: "string" },
    },
    strict: true,
  });
  return runVerb(() => {
    if (!values.skill || !values.input) {
      throw Object.assign(new Error("--skill and --input are required (--input - reads stdin)"), { code: "INVALID_INPUT" });
    }
    return beginSession({
      skill: values.skill,
      mode: values.mode,
      inputFile: values.input,
      workingDir: values["working-dir"],
      model: values.model,
      effort: values.effort,
      timeout: values.timeout,
      reviewer: values.reviewer,
      skillsDir: values["skills-dir"],
    });
  });
}

function cmdWait(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { "max-wait": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  return runVerb(() => {
    const { dir, err } = validateStateDir(positionals[0]);
    if (err) throw Object.assign(new Error(err), { code: "INVALID_INPUT" });
    const maxWait = values["max-wait"] ? parseInt(values["max-wait"], 10) : DEFAULT_MAX_WAIT_S;
    if (isNaN(maxWait) || maxWait < 0) throw Object.assign(new Error("--max-wait must be a non-negative integer"), { code: "INVALID_INPUT" });
    return waitSession(dir, { maxWaitSeconds: maxWait });
  });
}

function cmdReply(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  return runVerb(() => {
    const { dir, err } = validateStateDir(positionals[0]);
    if (err) throw Object.assign(new Error(err), { code: "INVALID_INPUT" });
    if (!values.input) throw Object.assign(new Error("--input is required (--input - reads stdin)"), { code: "INVALID_INPUT" });
    return replySession(dir, { inputFile: values.input, model: values.model, effort: values.effort });
  });
}

function cmdEnd(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { outcome: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  return runVerb(() => {
    const { dir, err } = validateStateDir(positionals[0]);
    if (err) throw Object.assign(new Error(err), { code: "INVALID_INPUT" });
    return endSession(dir, { outcome: values.outcome });
  });
}

// ============================================================
// CLI
// ============================================================

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "";
  const rest = argv.slice(1);

  let exitCode;

  switch (command) {
    case "version":
      process.stdout.write(`${RUNNER_VERSION}\n`);
      exitCode = EXIT_SUCCESS;
      break;
    case "init":
      exitCode = cmdInit(rest);
      break;
    case "start":
      exitCode = cmdStart(rest);
      break;
    case "resume":
      exitCode = cmdResume(rest);
      break;
    case "poll":
      exitCode = cmdPoll(rest);
      break;
    case "stop":
      exitCode = cmdStop(rest);
      break;
    case "finalize":
      exitCode = cmdFinalize(rest);
      break;
    case "status":
      exitCode = cmdStatus(rest);
      break;
    case "render":
      exitCode = cmdRender(rest);
      break;
    case "_watchdog":
      exitCode = cmdWatchdog(rest);
      break;
    case "begin":
    case "wait":
    case "reply":
    case "end": {
      const verb = { begin: cmdBegin, wait: cmdWait, reply: cmdReply, end: cmdEnd }[command];
      verb(rest).then(code => process.exit(code));
      return;
    }
    case "plans":
      import("./lib/plans.js")
        .then(m => m.runPlansCli(rest))
        .then(code => process.exit(code));
      return;
    case "dashboard":
      // Loaded on demand: the review commands never pay for the dashboard modules
      import("./lib/dashboard/server.js")
        .then(m => m.runDashboardCli(rest))
        .then(code => process.exit(code));
      return;
    default:
      process.stderr.write(
        "review-runner.js — Cross-platform runner for reviewer CLIs (v15)\n\n" +
        "Usage (high-level):\n" +
        "  node review-runner.js begin --skill <name> [--mode <mode>] --input <file|-> [--working-dir <dir>] [--model <name>] [--effort <level>] [--timeout <s>]\n" +
        "  node review-runner.js wait <session_dir> [--max-wait <s>]\n" +
        "  node review-runner.js reply <session_dir> --input <file|-> [--model <name>] [--effort <level>]\n" +
        "  node review-runner.js end <session_dir> [--outcome consensus|stalemate]\n" +
        "  node review-runner.js dashboard [--root <dir>] [--port <n>] [--no-open] [--idle-exit <s>]\n" +
        "  node review-runner.js plans --working-dir <dir> [--finished <file>]\n\n" +
        "Usage (low-level):\n" +
        "  node review-runner.js version\n" +
        "  node review-runner.js init --skill-name <name> --working-dir <dir>\n" +
        "  echo PROMPT | node review-runner.js start <session_dir> [--model <name>] [--effort <level>] [--timeout <s>] [--sandbox <mode>]\n" +
        "  echo PROMPT | node review-runner.js resume <session_dir> [--model <name>] [--effort <level>] [--timeout <s>]\n" +
        "  Reviewer: --reviewer on begin/init (default codex); later rounds reuse it\n" +
        "  Model: uses the reviewer CLI default unless --model is provided\n" +
        "  Default start/resume timeout: 18000s (5h)\n" +
        "  node review-runner.js poll <session_dir> [--min-interval <s>]\n" +
        "  node review-runner.js stop <session_dir>\n" +
        "  echo JSON | node review-runner.js finalize <session_dir>\n" +
        "  node review-runner.js status <session_dir>\n" +
        "  echo JSON | node review-runner.js render --skill <name> --template <name> --skills-dir <path>\n",
      );
      exitCode = command ? EXIT_ERROR : EXIT_SUCCESS;
      break;
  }

  // _watchdog returns -1 to keep process alive
  if (exitCode >= 0) {
    process.exit(exitCode);
  }
}

main();
