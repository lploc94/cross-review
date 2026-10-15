// Review session core: four high-level verbs (begin / wait / reply / end) on top of
// the low-level runner commands (init, render, start, poll, resume, finalize, stop).
//
// The verbs call codex-runner.js as a child process, so the low-level commands keep
// exactly one implementation and their behavior is unchanged. Used by the runner CLI
// and by the MCP server.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(SCRIPTS_DIR, "codex-runner.js");

// Same cadence as `poll`'s default --min-interval. The runner counts one stall tick per
// poll without new output, so polling faster would trip stall detection early.
export const POLL_INTERVAL_S = 120;
export const DEFAULT_MAX_WAIT_S = 110;
const CHECK_INTERVAL_MS = 2000;
// Reviewers run tests, builds and network commands (curl, npm view, git fetch) to verify
// claims; the prompts forbid changing project files. The low-level `start` keeps its
// read-only default.
export const REVIEWER_SANDBOX = "danger-full-access";

/**
 * Template names per skill and mode. `round1` starts the session, `reply` renders
 * every later round, `analysis` is the orchestrator's independent analysis (peer skills).
 */
export const SKILL_TEMPLATES = {
  "codex-plan-review": {
    peer: false,
    modes: { default: { round1: "round1", reply: "rebuttal" } },
  },
  "codex-impl-review": {
    peer: false,
    modes: {
      "working-tree": { round1: "working-tree-round1", reply: "rebuttal-working-tree" },
      branch: { round1: "branch-round1", reply: "rebuttal-branch" },
    },
  },
  "codex-think-about": {
    peer: true,
    modes: { default: { round1: "round1", reply: "round2+", analysis: "claude-analysis" } },
  },
  "codex-commit-review": {
    peer: true,
    modes: {
      staged: { round1: "staged-round1", reply: "staged-round2+", analysis: "claude-staged" },
      last: { round1: "last-round1", reply: "last-round2+", analysis: "claude-last" },
    },
  },
  "codex-pr-review": {
    peer: true,
    modes: { default: { round1: "round1", reply: "round2+", analysis: "claude-analysis" } },
  },
};

export class ReviewError extends Error {
  constructor(message, code = "UNKNOWN_ERROR") {
    super(message);
    this.code = code;
  }
}

function resolveTemplates(skill, mode) {
  const entry = SKILL_TEMPLATES[skill];
  if (!entry) {
    throw new ReviewError(`Unknown skill: ${skill}. Known: ${Object.keys(SKILL_TEMPLATES).join(", ")}`, "UNKNOWN_SKILL");
  }
  const modeNames = Object.keys(entry.modes);
  const key = mode || (modeNames.length === 1 ? modeNames[0] : null);
  if (!key || !entry.modes[key]) {
    throw new ReviewError(`Skill ${skill} needs --mode, one of: ${modeNames.join(", ")}`, "INVALID_INPUT");
  }
  return { peer: entry.peer, mode: key, templates: entry.modes[key], sandbox: entry.sandbox || REVIEWER_SANDBOX };
}

export function isPeerSkill(skill) {
  return Boolean(SKILL_TEMPLATES[skill]?.peer);
}

/**
 * Default skills dir: installed layout keeps prompts at <skills>/<skill>/references and
 * the runner at <skills>/codex-review/scripts; the repo keeps them under ../skills.
 */
export function defaultSkillsDir(skill) {
  const installed = path.resolve(SCRIPTS_DIR, "..", "..");
  if (fs.existsSync(path.join(installed, skill, "references", "prompts.md"))) return installed;
  return path.resolve(SCRIPTS_DIR, "..", "skills");
}

function runRunner(args, input = "") {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [RUNNER, ...args], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function runnerFailure(result, fallbackCode) {
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && parsed.error) return new ReviewError(parsed.error, parsed.code || fallbackCode);
  } catch {}
  const msg = (result.stderr || result.stdout || "").trim() || `runner exited with code ${result.code}`;
  return new ReviewError(msg, fallbackCode);
}

async function runnerJson(args, input = "", fallbackCode = "RUNNER_ERROR") {
  const result = await runRunner(args, input);
  if (result.code !== 0) throw runnerFailure(result, fallbackCode);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ReviewError(`Runner returned invalid JSON for ${args[0]}: ${result.stdout.slice(0, 200)}`, "RUNNER_ERROR");
  }
}

function readState(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, "state.json"), "utf8"));
}

function updateState(sessionDir, updates) {
  const file = path.join(sessionDir, "state.json");
  const state = { ...readState(sessionDir), ...updates };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function placeholderNames(skillsDir, skill) {
  const promptsPath = path.join(skillsDir, skill, "references", "prompts.md");
  let md;
  try {
    md = fs.readFileSync(promptsPath, "utf8");
  } catch (e) {
    throw new ReviewError(`Cannot read ${promptsPath}: ${e.message}`, "IO_ERROR");
  }
  return new Set([...md.matchAll(/\{([A-Z][A-Z_0-9]+)\}/g)].map(m => m[1]));
}

/**
 * Parse review input markdown into placeholder values.
 *
 * Optional front-matter (`---` lines) holds single-line `NAME: value` pairs. The body
 * holds multi-line values as `## NAME` sections; only headings that name a placeholder
 * of the skill start a section, so other `##` lines stay inside the value.
 */
export function parseReviewInput(text, knownNames) {
  const values = {};
  let body = (text || "").replace(/\r\n?/g, "\n");
  const fm = body.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([A-Z][A-Z_0-9]+)[ \t]*:[ \t]*(.*)$/);
      if (m) values[m[1]] = m[2].trim();
    }
    body = body.slice(fm[0].length);
  }
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current) values[current] = buffer.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const m = line.match(/^##[ \t]+([A-Z][A-Z_0-9]+)[ \t]*$/);
    if (m && knownNames.has(m[1])) {
      flush();
      current = m[1];
      buffer = [];
    } else if (current) {
      buffer.push(line);
    } else {
      // `NAME: value` lines before the first section, written without --- fences
      const scalar = line.match(/^([A-Z][A-Z_0-9]+)[ \t]*:[ \t]*(.*)$/);
      if (scalar && knownNames.has(scalar[1])) values[scalar[1]] = scalar[2].trim();
    }
  }
  flush();
  return values;
}

async function render(skill, template, skillsDir, values) {
  const result = await runRunner(
    ["render", "--skill", skill, "--template", template, "--skills-dir", skillsDir],
    JSON.stringify(values),
  );
  if (result.code !== 0) throw runnerFailure(result, "RENDER_FAILED");
  return result.stdout;
}

function readInput({ inputText, inputFile }) {
  if (typeof inputText === "string") return inputText;
  if (inputFile) {
    try {
      return fs.readFileSync(inputFile === "-" ? 0 : inputFile, "utf8");
    } catch (e) {
      throw new ReviewError(`Cannot read input: ${e.message}`, "IO_ERROR");
    }
  }
  throw new ReviewError("Review input is required", "INVALID_INPUT");
}

/**
 * Start a review: init the session, render round 1, launch Codex.
 * Returns { session_dir, round: 1, status: "running", analysis_prompt? }.
 */
export async function beginSession({ skill, mode, inputText, inputFile, workingDir, model, effort, timeout, skillsDir }) {
  const resolved = resolveTemplates(skill, mode);
  // Absolute, so later replies from another working directory find the same prompts
  const dir = path.resolve(skillsDir || defaultSkillsDir(skill));
  const values = parseReviewInput(readInput({ inputText, inputFile }), placeholderNames(dir, skill));

  const prompt = await render(skill, resolved.templates.round1, dir, values);
  const analysisPrompt = resolved.templates.analysis
    ? await render(skill, resolved.templates.analysis, dir, values)
    : null;

  const init = await runRunner(["init", "--skill-name", skill, "--working-dir", workingDir || process.cwd()]);
  const line = init.stdout.trim();
  if (init.code !== 0 || !line.startsWith("CODEX_SESSION:")) throw runnerFailure(init, "INIT_FAILED");
  const sessionDir = line.slice("CODEX_SESSION:".length);

  updateState(sessionDir, { skills_dir: dir, mode: resolved.mode });

  const startArgs = ["start", sessionDir, "--effort", effort || "high"];
  if (model) startArgs.push("--model", model);
  if (timeout) startArgs.push("--timeout", String(timeout));
  if (resolved.sandbox) startArgs.push("--sandbox", resolved.sandbox);
  await runnerJson(startArgs, prompt, "START_FAILED");

  const out = { session_dir: sessionDir, round: 1, status: "running" };
  if (analysisPrompt !== null) out.analysis_prompt = analysisPrompt;
  return out;
}

function roundStatus(review) {
  if (!review) return null;
  return (review.verdict && review.verdict.status) || review.suggested_status || null;
}

/**
 * Decide the orchestrator's next step from a poll result.
 * Returns { next, next_reason }.
 */
export function computeNext(pollJson, state = {}) {
  const status = pollJson && pollJson.status;
  if (status === "running") return { next: "running", next_reason: "codex_running" };

  if (status === "completed") {
    const review = pollJson.review || null;
    const verdict = roundStatus(review);
    if ((pollJson.convergence && pollJson.convergence.stalemate) || verdict === "STALEMATE") {
      return { next: "done", next_reason: "stalemate" };
    }
    if (isPeerSkill(state.skill_name)) {
      return { next: "cross_check", next_reason: "peer_verdict_is_advisory" };
    }
    const issues = review && Array.isArray(review.blocks) ? review.blocks.length : 0;
    if (verdict === "APPROVE") return { next: "done", next_reason: "approved" };
    if (verdict || issues > 0) return { next: "respond", next_reason: verdict ? `verdict_${verdict.toLowerCase()}` : "open_issues" };
    return { next: "ask_user", next_reason: "missing_verdict" };
  }

  if (status === "timeout" && pollJson.timeout_reason === "runner_deadline" && pollJson.recoverable === true
    && pollJson.thread_id && pollJson.progress_observed === true) {
    return { next: "stopped", next_reason: "recoverable_timeout" };
  }
  return { next: "stopped", next_reason: (pollJson && (pollJson.failure_reason || status)) || "unknown" };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wait up to maxWaitSeconds for the current round. Polls at the runner's cadence, and
 * immediately once the Codex process has exited. Returns the poll JSON plus next/next_reason.
 */
export async function waitSession(sessionDir, { maxWaitSeconds = DEFAULT_MAX_WAIT_S } = {}) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  const finalFile = path.join(sessionDir, "final.txt");
  let state;
  try {
    state = readState(sessionDir);
  } catch (e) {
    throw new ReviewError(`Cannot read session state: ${e.message}`, "INVALID_SESSION");
  }

  // Each poll returns only activities new since the previous poll; keep all of them
  const activities = [];
  for (;;) {
    state = readState(sessionDir);
    const now = Math.floor(Date.now() / 1000);
    const due = !state.last_poll_at || now - state.last_poll_at >= POLL_INTERVAL_S;
    if (fs.existsSync(finalFile) || !isAlive(state.pid) || due) {
      const pollJson = await runnerJson(["poll", sessionDir, "--min-interval", "0"], "", "POLL_FAILED");
      if (Array.isArray(pollJson.activities)) activities.push(...pollJson.activities);
      if (pollJson.status !== "running" || Date.now() >= deadline) {
        return { ...pollJson, activities, ...computeNext(pollJson, readState(sessionDir)) };
      }
    }
    if (Date.now() + CHECK_INTERVAL_MS > deadline) {
      const elapsed = state.started_at ? now - state.started_at : null;
      return { status: "running", round: state.round, elapsed_seconds: elapsed, activities, ...computeNext({ status: "running" }, state) };
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

/**
 * Send the next round: render the skill's round-2+ template from the input and resume.
 * Model and effort default to the session's stored values; passing one updates the store.
 */
export async function replySession(sessionDir, { inputText, inputFile, model, effort } = {}) {
  const state = readState(sessionDir);
  const skill = state.skill_name;
  const resolved = resolveTemplates(skill, state.mode);
  const dir = state.skills_dir || defaultSkillsDir(skill);
  const values = parseReviewInput(readInput({ inputText, inputFile }), placeholderNames(dir, skill));
  const prompt = await render(skill, resolved.templates.reply, dir, values);

  // `start`/`resume` record effort and model in state.json
  const useEffort = effort || state.effort || "high";
  const useModel = model || state.model || null;
  const args = ["resume", sessionDir, "--effort", useEffort];
  if (useModel) args.push("--model", useModel);
  if (state.timeout) args.push("--timeout", String(state.timeout));
  return runnerJson(args, prompt, "RESUME_FAILED");
}

/**
 * End the session. Finalizes when the review reached a normal end — the reviewer's
 * verdict for plan/impl review, the orchestrator's `outcome` for peer skills — then stops.
 */
export async function endSession(sessionDir, { outcome } = {}) {
  const state = readState(sessionDir);
  const peer = isPeerSkill(state.skill_name);
  let finalVerdict = null;

  if (peer) {
    if (outcome) {
      const normalized = String(outcome).toLowerCase();
      if (normalized !== "consensus" && normalized !== "stalemate") {
        throw new ReviewError("--outcome must be consensus or stalemate", "INVALID_INPUT");
      }
      finalVerdict = normalized.toUpperCase();
    }
  } else {
    let last = null;
    try {
      last = JSON.parse(fs.readFileSync(path.join(sessionDir, "final.txt"), "utf8"));
    } catch {}
    if (last && computeNext(last, state).next === "done") finalVerdict = "";
  }

  let finalized = false;
  let verdict;
  let error;
  if (finalVerdict !== null) {
    const stdin = finalVerdict ? JSON.stringify({ verdict: finalVerdict }) : "";
    try {
      const out = await runnerJson(["finalize", sessionDir], stdin, "FINALIZE_FAILED");
      finalized = true;
      verdict = out.meta && out.meta.verdict;
    } catch (e) {
      error = { message: e.message, code: e.code };
    }
  }
  await runnerJson(["stop", sessionDir], "", "STOP_FAILED");
  const out = { status: "ended", session_dir: sessionDir, finalized };
  if (verdict) out.verdict = verdict;
  if (error) out.error = error;
  return out;
}
