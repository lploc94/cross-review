// Plans that loop-plan writes into <workspace>/.cross-review/plans/. A file whose
// `## Plan schema` is loop-plan/v1 is a plan: its phases, acceptance criteria (ticked by
// loop-implement), plan review and progress log are read from the markdown. Any other .md
// file there is a plain document. Git facts (ignored or not, phase commits) come from read-only
// git commands. The runner's `plans` command and the dashboard both use this module.
//
// Stdlib only; parsing never throws on odd markdown.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, resolvePlanSettings, syncGitignore } from "./config.js";

export const PLAN_SCHEMA = "loop-plan/v1";
/** A normal plan name, like the ones loop-plan writes, that asks git whether new plans are kept. */
export const PROBE_PLAN = "cross-review-probe-plan.md";
const NAME_MAX_BYTES = 255; // the file-name limit of common file systems
const LOG_MAX_COMMITS = 2000; // see the plan's Capacity: older phase commits show no SHA
const GIT_TIMEOUT_MS = 5000;
const SESSION_ID_IN_TEXT = /\b[a-z]+(?:-[a-z]+)*-\d{8}-\d{3}\b/g;

export const plansDir = ws => path.join(ws, ".cross-review", "plans");

/** A plain .md file name: no folders, not hidden, no control characters, ≤ 255 bytes. */
export function isPlanFileName(name) {
  return typeof name === "string"
    && /\.md$/i.test(name) && !name.startsWith(".")
    && !/[/\\\p{Cc}]/u.test(name)
    && Buffer.byteLength(name, "utf8") <= NAME_MAX_BYTES;
}

/** The plan files of `ws`: regular files (not symlinks) with a plan file name, sorted. */
export function listPlans(ws) {
  let entries;
  try {
    entries = fs.readdirSync(plansDir(ws), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isFile() && isPlanFileName(e.name)).map(e => e.name).sort();
}

// ---------- markdown structure ----------

/** Lines with whether each sits inside a ``` or ~~~ fence (the fence lines count as inside). */
function scanLines(text) {
  const out = [];
  let fence = null;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push({ line, fenced: true });
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
      out.push({ line, fenced: true });
    } else {
      out.push({ line, fenced: false });
    }
  }
  return out;
}

/** Split at headings of `level` outside fences: [{ title, lines }], the first with title null. */
function splitAt(lines, level) {
  const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
  const parts = [{ title: null, lines: [] }];
  for (const l of lines) {
    const m = !l.fenced && l.line.match(re);
    if (m) parts.push({ title: m[1], lines: [] });
    else parts[parts.length - 1].lines.push(l);
  }
  return parts;
}

const joinLines = lines => lines.map(l => l.line).join("\n");
const firstParagraph = lines => {
  const out = [];
  for (const l of lines) {
    if (!l.line.trim()) {
      if (out.length) break;
      continue;
    }
    out.push(l.line.trim());
  }
  return out.length ? out.join(" ") : null;
};
const firstLine = lines => {
  const l = lines.find(x => x.line.trim());
  return l ? l.line.trim() : null;
};
const slug = title => title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
const unique = (ids, id) => {
  let out = id;
  for (let i = 2; ids.has(out); i++) out = `${id}-${i}`;
  ids.add(out);
  return out;
};

/** Whether `text` declares `## Plan schema` loop-plan/v1 (outside code fences). */
export function isLoopPlan(text) {
  const sec = splitAt(scanLines(text), 2).find(s => s.title && /^plan schema$/i.test(s.title.trim()));
  return Boolean(sec) && firstLine(sec.lines) === PLAN_SCHEMA;
}

function parsePlanReview(lines) {
  const raw = lines ? firstLine(lines) : null;
  const out = { verdict: null, session: null, user: null, raw };
  if (!raw) return out;
  const word = raw.match(/^(APPROVE|REVISE|pending)\b/i);
  if (word) out.verdict = /^pending$/i.test(word[1]) ? "pending" : word[1].toUpperCase();
  let m;
  if ((m = raw.match(/^APPROVE\s*\(\s*review-plan\s+([^\s,()]+)\s*,[^)]*\)/))) out.session = m[1];
  else if ((m = raw.match(/^APPROVE\s*\(\s*user\s*,\s*([^)]*?)\s*\)/))) out.user = m[1];
  return out;
}

const AC_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;

function parsePhase(n, name, lines) {
  const subs = Object.create(null);
  for (const s of splitAt(lines, 3).slice(1)) subs[s.title.trim().toLowerCase()] = s.lines;
  const acs = [];
  for (const l of subs["acceptance criteria"] || []) {
    const m = !l.fenced && l.line.match(AC_LINE);
    if (!m) continue;
    const id = m[2].match(/^(AC-[\w.-]+):\s*/);
    acs.push({ id: id ? id[1] : null, text: id ? m[2].slice(id[0].length) : m[2], met: m[1] !== " " });
  }
  const review = subs.review ? joinLines(subs.review) : "";
  const commitText = subs.commit ? joinLines(subs.commit) : "";
  const code = commitText.match(/`([^`\n]+)`/) || commitText.match(/^\s*```[^\n]*\n([^\n]+)/);
  return {
    n, name,
    goal: subs.goal ? firstParagraph(subs.goal) : null,
    dependencies: subs.dependencies ? joinLines(subs.dependencies).trim() || null : null,
    acs,
    checkpoint: /review-impl/.test(review) && !/^\s*None\b/.test(review) ? "review-impl" : null,
    commit: { message: code ? code[1].trim() : null, sha: null },
  };
}

function parseLog(lines) {
  const entries = [];
  for (const l of lines || []) {
    if (l.fenced) {
      if (entries.length) entries[entries.length - 1].text += `\n${l.line.trim()}`;
      continue;
    }
    const top = l.line.match(/^[-*+]\s+(.*)$/);
    if (top) entries.push({ text: top[1].trim() });
    else if (l.line.trim() && /^\s/.test(l.line) && entries.length) entries[entries.length - 1].text += `\n${l.line.trim()}`;
  }
  return entries.map(({ text }) => {
    const date = text.match(/^(\d{4}-\d{2}-\d{2})\b/);
    const phase = text.match(/\bPhase (\d+)\b/);
    const kind = /\bDecision:/.test(text) ? "decision" : /\bDiscovery:/.test(text) ? "discovery" : phase ? "phase" : "note";
    return {
      date: date ? date[1] : null, kind, phase: kind === "phase" ? Number(phase[1]) : null,
      text, sessions: [...new Set(text.match(SESSION_ID_IN_TEXT) || [])],
    };
  });
}

/**
 * Read a plan (or any markdown document). Sections keep the whole text but the H1: an
 * `intro` section for what comes before the first H2, then one per H2.
 */
export function parsePlan(text) {
  const lines = scanLines(text);
  let title = null;
  let h1 = -1;
  lines.some((l, i) => {
    const m = !l.fenced && l.line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) [title, h1] = [m[1], i];
    return Boolean(m);
  });
  const parts = splitAt(lines.filter((_, i) => i !== h1), 2);
  const ids = new Set();
  const sections = [];
  const byTitle = Object.create(null);
  const phases = [];
  for (const [i, part] of parts.entries()) {
    const md = joinLines(part.lines);
    if (i === 0) {
      if (md.trim()) sections.push({ id: unique(ids, "intro"), title: null, md, phase: null });
      continue;
    }
    const t = part.title.trim();
    const ph = t.match(/^Phase\s+(\d+)\s*:\s*(.*)$/i);
    const sec = { id: unique(ids, ph ? `phase-${ph[1]}` : slug(t)), title: t, md, phase: ph ? Number(ph[1]) : null };
    sections.push(sec);
    if (ph) phases.push(parsePhase(Number(ph[1]), ph[2].trim(), part.lines));
    else if (!(t.toLowerCase() in byTitle)) byTitle[t.toLowerCase()] = part.lines;
  }
  phases.sort((a, b) => a.n - b.n);
  return {
    title,
    schema: byTitle["plan schema"] ? firstLine(byTitle["plan schema"]) : null,
    sections,
    target: byTitle.target ? firstParagraph(byTitle.target) : null,
    planReview: parsePlanReview(byTitle["plan review"]),
    phases,
    completion: byTitle["completion criteria"] ? joinLines(byTitle["completion criteria"]).trim() : null,
    log: parseLog(byTitle["progress log"]),
    sessionIds: [...new Set(String(text).match(SESSION_ID_IN_TEXT) || [])],
  };
}

const phaseDone = p => p.acs.length > 0 && p.acs.every(a => a.met);

export function planProgress(parsed) {
  const phases = parsed.phases || [];
  const current = phases.find(p => !phaseDone(p));
  return {
    phasesDone: phases.filter(phaseDone).length,
    phasesTotal: phases.length,
    acsMet: phases.reduce((t, p) => t + p.acs.filter(a => a.met).length, 0),
    acsTotal: phases.reduce((t, p) => t + p.acs.length, 0),
    current: current ? current.n : null,
  };
}

/** Approved only with a source: a review-plan session or the user's date. */
export const planApproved = parsed => {
  const r = parsed.planReview || {};
  return r.verdict === "APPROVE" && Boolean(r.session || r.user);
};

/** draft | review | ready | progress | done; `reviewing`: a review-plan session is working on it. */
export function planState(parsed, { reviewing = false } = {}) {
  const pr = planProgress(parsed);
  if (pr.phasesTotal > 0 && pr.phasesDone === pr.phasesTotal) return "done";
  if (pr.acsMet > 0) return "progress";
  const approved = planApproved(parsed);
  if (!approved && reviewing) return "review";
  return approved ? "ready" : "draft";
}

const plainText = md => md.replace(/[`*_>#|[\]()~]/g, " ").replace(/\s+/g, " ").trim();

/** What the list shows of one file; `facts` from gitPlanFacts gives `tracked`. */
export function summarizePlanText(ws, file, text, facts = null) {
  const parsed = parsePlan(text);
  const tracked = facts && facts.repo ? !facts.ignored.has(file) : null;
  const base = { file, path: path.join(plansDir(ws), file), schema: parsed.schema, tracked };
  if (parsed.schema !== PLAN_SCHEMA) {
    const title = parsed.title || file;
    return {
      ...base, format: "markdown", title, state: "doc", progress: null, planReview: null,
      searchText: `${title} ${plainText(parsed.sections.map(s => `${s.title || ""} ${s.md}`).join(" "))}`.toLowerCase(),
    };
  }
  const title = parsed.title || file;
  return {
    ...base, format: "loop-plan", title, state: planState(parsed), progress: planProgress(parsed), planReview: parsed.planReview,
    searchText: [title, parsed.target || "", ...parsed.phases.map(p => p.name)].join(" ").toLowerCase(),
  };
}

export function summarizePlan(ws, file, facts = null) {
  return summarizePlanText(ws, file, fs.readFileSync(path.join(plansDir(ws), file), "utf8"), facts);
}

// ---------- git ----------

function runGit(ws, args, input) {
  const r = spawnSync("git", ["-C", ws, ...args], { input, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return r.error ? { status: null, stdout: "" } : r;
}

/**
 * Read-only git facts for the plans of `ws`: which are ignored, whether a new plan named like
 * loop-plan's would be ignored and by which rule, and subject → SHA of recent commits (only
 * subjects that occur once; a repeated subject maps to null). Outside git: { repo: false }.
 */
export function gitPlanFacts(ws, files) {
  const none = { repo: false, ignored: new Set(), newPlansIgnored: null, blockedBy: null, commits: new Map() };
  const rel = f => path.posix.join(".cross-review", "plans", f);
  // `-q` decides; `-v` also exits 0 on a negation match, so it only names the rule
  const probe = runGit(ws, ["check-ignore", "-q", rel(PROBE_PLAN)]);
  if (probe.status !== 0 && probe.status !== 1) return none;
  const ignored = new Set();
  if (files.length) {
    const r = runGit(ws, ["check-ignore", "--stdin", "-z"], files.map(rel).join("\0") + "\0");
    if (r.status !== 0 && r.status !== 1) return none;
    for (const p of r.stdout.split("\0")) if (p) ignored.add(path.posix.basename(p));
  }
  let blockedBy = null;
  if (probe.status === 0) {
    const v = runGit(ws, ["check-ignore", "-v", rel(PROBE_PLAN)]);
    blockedBy = v.status === 0 ? v.stdout.split("\t")[0].trim() || null : null;
  }
  const commits = new Map();
  const log = runGit(ws, ["log", "-n", String(LOG_MAX_COMMITS), "--format=%h%x09%s"]);
  if (log.status === 0) {
    for (const line of log.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const subject = line.slice(tab + 1);
      commits.set(subject, commits.has(subject) ? null : line.slice(0, tab));
    }
  }
  return { repo: true, ignored, newPlansIgnored: probe.status === 0, blockedBy, commits };
}

/** A copy of `parsed` with the SHA of each finished phase whose planned subject is in one commit. */
export function fillCommits(parsed, facts) {
  const commits = facts && facts.commits instanceof Map ? facts.commits : new Map();
  return {
    ...parsed,
    phases: parsed.phases.map(p => {
      const subject = p.commit.message ? p.commit.message.split("\n")[0] : null;
      const sha = phaseDone(p) && subject ? commits.get(subject) ?? null : null;
      return { ...p, commit: { ...p.commit, sha } };
    }),
  };
}

/**
 * One sentence for the runner and Settings when Plans in git is on but git still ignores new
 * plans; null otherwise. `gitignore` is the syncGitignore result.
 */
export function plansWarning({ track, gitignore, facts }) {
  if (!track || !facts || !facts.repo || !facts.newPlansIgnored) return null;
  const rule = facts.blockedBy || "a .gitignore rule";
  let out = `Plans in git is on, but ${rule} ignores new plans in .cross-review/plans/.`;
  const pattern = facts.blockedBy ? facts.blockedBy.split(":").slice(2).join(":") : "";
  if (/^\/?\.cross-review\/?$/.test(pattern)) out += " Change it to .cross-review/* and add !.cross-review/plans/.";
  if (gitignore === "custom") out += " .cross-review/.gitignore was edited by hand, so it was not changed.";
  return out;
}

// ---------- the runner's `plans` command ----------

const fail = msg => {
  process.stderr.write(`Error: ${msg}\n`);
  return 1;
};

/**
 * `plans --working-dir D [--finished <file>]`: create D/.cross-review/plans, keep its
 * .gitignore in step with track_plans, and print the plans as JSON. --finished names the plan
 * loop-plan just wrote; with Follow plans on it opens on the dashboard.
 */
export async function runPlansCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { "working-dir": { type: "string" }, finished: { type: "string" } }, strict: true }));
  } catch (e) {
    return fail(e.message);
  }
  if (!values["working-dir"]) return fail("--working-dir is required");
  let ws;
  try {
    ws = fs.realpathSync(values["working-dir"]);
    if (!fs.statSync(ws).isDirectory()) throw new Error("not a folder");
  } catch {
    return fail(`working directory does not exist: ${values["working-dir"]}`);
  }
  let settings;
  try {
    settings = resolvePlanSettings(ws);
  } catch (e) {
    if (e instanceof ConfigError) return fail(`${e.code}: ${e.message}`);
    throw e;
  }
  const dir = plansDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = syncGitignore(ws, settings.track_plans.value);
  const files = listPlans(ws);

  let finished = null;
  if (values.finished !== undefined) {
    const given = values.finished;
    if (files.includes(given)) finished = given;
    else {
      let real = null;
      try {
        real = fs.realpathSync(path.resolve(ws, given));
      } catch {}
      if (real && path.dirname(real) === fs.realpathSync(dir) && files.includes(path.basename(real))) finished = path.basename(real);
    }
    if (!finished) return fail(`not a plan in ${dir}: ${given}`);
  }

  const facts = gitPlanFacts(ws, files);
  const plans = [];
  for (const f of files) {
    try {
      plans.push(summarizePlan(ws, f, facts));
    } catch {} // gone between the listing and the read
  }
  const out = {
    dir,
    track_plans: settings.track_plans,
    gitignore,
    git: { repo: facts.repo, new_plans_ignored: facts.newPlansIgnored, blocked_by: facts.blockedBy },
    plans,
  };
  const warning = plansWarning({ track: settings.track_plans.value, gitignore, facts });
  if (warning) out.warning = warning;
  if (finished && settings.open_plans.value === true) {
    const { followInDashboard } = await import("./dashboard/follow.js");
    const r = await followInDashboard({
      workingDir: ws,
      hash: wsKey => `#/p/${encodeURIComponent(wsKey)}/${encodeURIComponent(finished)}/plan`,
    });
    if (r.url) out.dashboard_url = r.url;
    if (r.error) out.dashboard_error = r.error;
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  return 0;
}
