// Review settings at two levels: ~/.cross-review/config.json (global) and
// <workspace>/.cross-review/config.json. `begin` takes its defaults from them; the
// dashboard's Settings page reads and writes them.
//
// Schema: { reviewer?, open_dashboard?, track_plans?, open_plans?, check_updates? (read from the
//           global file only), reviewers?: { codex?|claude?|agy?: { model?, effort?,
//           skills?: { <skill>: { model?, effort? } } } }, model?, effort?, skills? }
// The last three are the older form of reviewers.codex: readConfig and writeConfig move them
// there (normalizeConfig), and a field already in reviewers.codex wins.
// The reviewer resolves first: requested > workspace > global > "codex". Its model and effort
// then resolve key by key through that reviewer's entries: requested > workspace skill >
// workspace > global skill > global > default (the reviewer's own model, effort "high").
// track_plans and open_plans are plan settings, not review settings: workspace > global > false.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_REVIEWER, REVIEWER_NAMES, getReviewer } from "./reviewers/index.js";

/** The skills a config can name (the runner's SKILL_TEMPLATES; a test keeps them equal). */
export const CONFIG_SKILLS = ["review-plan", "review-impl", "review-think", "review-pr"];
export const DEFAULT_EFFORT = "high";
const MODEL_MAX = 200;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.code = "CONFIG_INVALID";
  }
}

export const globalConfigPath = () => path.join(os.homedir(), ".cross-review", "config.json");
export const workspaceConfigPath = ws => path.join(ws, ".cross-review", "config.json");

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

function checkModel(v, where, errors) {
  if (typeof v !== "string" || !v || v.length > MODEL_MAX || /[\s\p{Cc}]/u.test(v)) {
    errors.push(`${where}: must be a model name without spaces, 1–${MODEL_MAX} characters`);
  }
}

/** A lowercase word; one of `efforts` when the reviewer has fixed levels. */
function checkEffort(v, where, errors, efforts = null) {
  if (typeof v !== "string" || !/^[a-z]+$/.test(v)) errors.push(`${where}: must be a lowercase word such as "high"`);
  else if (efforts && !efforts.includes(v)) errors.push(`${where}: must be one of ${efforts.join(", ")}`);
}

/** { <skill>: { model?, effort? } } at `where` ("skills" or "reviewers.<name>.skills"). */
function checkSkills(v, where, errors, efforts) {
  if (!isObject(v)) {
    errors.push(`${where}: must be an object keyed by skill`);
    return;
  }
  for (const [skill, entry] of Object.entries(v)) {
    if (!CONFIG_SKILLS.includes(skill)) {
      errors.push(`${where}: unknown skill ${JSON.stringify(skill)} (known: ${CONFIG_SKILLS.join(", ")})`);
      continue;
    }
    if (!isObject(entry)) {
      errors.push(`${where}.${skill}: must be an object`);
      continue;
    }
    for (const [k, x] of Object.entries(entry)) {
      if (k === "model") checkModel(x, `${where}.${skill}.model`, errors);
      else if (k === "effort") checkEffort(x, `${where}.${skill}.effort`, errors, efforts);
      else errors.push(`${where}.${skill}: unknown key ${JSON.stringify(k)} (only model and effort)`);
    }
  }
}

function checkReviewers(v, errors) {
  if (!isObject(v)) {
    errors.push("reviewers: must be an object keyed by reviewer");
    return;
  }
  for (const [name, entry] of Object.entries(v)) {
    if (!REVIEWER_NAMES.includes(name)) {
      errors.push(`reviewers: unknown reviewer ${JSON.stringify(name)} (known: ${REVIEWER_NAMES.join(", ")})`);
      continue;
    }
    if (!isObject(entry)) {
      errors.push(`reviewers.${name}: must be an object`);
      continue;
    }
    const efforts = getReviewer(name).efforts || null;
    for (const [k, x] of Object.entries(entry)) {
      if (k === "model") checkModel(x, `reviewers.${name}.model`, errors);
      else if (k === "effort") checkEffort(x, `reviewers.${name}.effort`, errors, efforts);
      else if (k === "skills") checkSkills(x, `reviewers.${name}.skills`, errors, efforts);
      else errors.push(`reviewers.${name}: unknown key ${JSON.stringify(k)} (only model, effort and skills)`);
    }
  }
}

/** Problems with a config object, one sentence each; [] when it is valid. */
export function validateConfig(obj) {
  const errors = [];
  if (!isObject(obj)) return ["the config must be a JSON object"];
  for (const [key, v] of Object.entries(obj)) {
    if (key === "reviewer") {
      if (!REVIEWER_NAMES.includes(v)) errors.push(`reviewer: unknown reviewer ${JSON.stringify(v)} (known: ${REVIEWER_NAMES.join(", ")})`);
    } else if (key === "model") {
      checkModel(v, "model", errors);
    } else if (key === "effort") {
      checkEffort(v, "effort", errors);
    } else if (key === "open_dashboard" || key === "track_plans" || key === "open_plans" || key === "check_updates") {
      if (typeof v !== "boolean") errors.push(`${key}: must be true or false`);
    } else if (key === "skills") {
      checkSkills(v, "skills", errors, null);
    } else if (key === "reviewers") {
      checkReviewers(v, errors);
    } else {
      errors.push(`unknown key ${JSON.stringify(key)}`);
    }
  }
  return errors;
}

/**
 * The config with the older top-level model, effort and skills moved into reviewers.codex; a
 * field already in reviewers.codex wins. Pure: the input is not changed, and normalizing a
 * normalized config gives it back unchanged.
 */
export function normalizeConfig(obj) {
  if (!isObject(obj)) return obj;
  const { model, effort, skills, ...rest } = obj;
  if (model === undefined && effort === undefined && skills === undefined) return { ...obj };
  const reviewers = isObject(obj.reviewers) ? { ...obj.reviewers } : {};
  const codex = isObject(reviewers.codex) ? { ...reviewers.codex } : {};
  if (model !== undefined && codex.model === undefined) codex.model = model;
  if (effort !== undefined && codex.effort === undefined) codex.effort = effort;
  if (isObject(skills)) {
    const merged = isObject(codex.skills) ? { ...codex.skills } : {};
    for (const [skill, entry] of Object.entries(skills)) {
      merged[skill] = { ...(isObject(entry) ? entry : {}), ...(isObject(merged[skill]) ? merged[skill] : {}) };
    }
    codex.skills = merged;
  }
  reviewers.codex = codex;
  return { ...rest, reviewers };
}

/** The config in `file`: {} when it does not exist; throws CONFIG_INVALID when it is broken. */
export function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new ConfigError(`Cannot read ${file}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${e.message}`);
  }
  const errors = validateConfig(obj);
  if (errors.length) throw new ConfigError(`${file}: ${errors.join("; ")}`);
  return normalizeConfig(obj);
}

/** An entry without empty skill entries, so a cleared field leaves no `{}` behind. */
function pruneEntry(entry) {
  const out = { ...entry };
  if (isObject(out.skills)) {
    const skills = {};
    for (const [s, e] of Object.entries(out.skills)) if (isObject(e) && Object.keys(e).length) skills[s] = e;
    if (Object.keys(skills).length) out.skills = skills; else delete out.skills;
  }
  return out;
}

/** Drop empty skill and reviewer entries, so a cleared field leaves no `{}` behind. */
function prune(obj) {
  const out = pruneEntry(obj);
  if (isObject(out.reviewers)) {
    const reviewers = {};
    for (const [name, e] of Object.entries(out.reviewers)) {
      const entry = isObject(e) ? pruneEntry(e) : e;
      if (isObject(entry) && Object.keys(entry).length) reviewers[name] = entry;
    }
    if (Object.keys(reviewers).length) out.reviewers = reviewers; else delete out.reviewers;
  }
  return out;
}

/** Validate and write `obj` normalized (temp file + rename). An empty config deletes the file. */
export function writeConfig(file, obj) {
  const errors = validateConfig(obj);
  if (errors.length) throw new ConfigError(errors.join("; "));
  const clean = prune(normalizeConfig(obj));
  if (!Object.keys(clean).length) {
    fs.rmSync(file, { force: true });
    return clean;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return clean;
}

/**
 * The two .gitignore files the pack writes in <ws>/.cross-review: everything ignored, or
 * everything but plans/. Git cannot re-include a file whose parent folder is excluded, so the
 * exception names both the folder and what is in it.
 */
export const GITIGNORE = { ignore: "*\n", track: "*\n!plans/\n!plans/**\n" };

/**
 * Make <ws>/.cross-review/.gitignore ignore or keep plans. Only a missing file or one of the
 * two the pack writes is changed; a file edited by hand is left alone ("custom").
 * Returns "created" | "updated" | "unchanged" | "custom".
 */
export function syncGitignore(ws, track) {
  const dir = path.join(ws, ".cross-review");
  const file = path.join(dir, ".gitignore");
  const want = track ? GITIGNORE.track : GITIGNORE.ignore;
  let have = null;
  try {
    have = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (have === want) return "unchanged";
  if (have !== null && have !== GITIGNORE.ignore && have !== GITIGNORE.track) return "custom";
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, want);
  fs.renameSync(tmp, file);
  return have === null ? "created" : "updated";
}

/**
 * Create <ws>/.cross-review with a .gitignore that keeps sessions and config out of git, and
 * plans too unless track_plans is on. A broken config does not stop it: an existing
 * .gitignore is kept, a missing one is created ignoring everything.
 */
export function ensureCrossReviewDir(ws) {
  const dir = path.join(ws, ".cross-review");
  fs.mkdirSync(dir, { recursive: true });
  let track;
  try {
    track = resolvePlanSettings(ws).track_plans.value;
  } catch (e) {
    if (e.code !== "CONFIG_INVALID") throw e;
    try {
      fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE.ignore, { encoding: "utf8", flag: "wx" });
    } catch {}
    return dir;
  }
  try {
    syncGitignore(ws, track);
  } catch {} // as before: a .gitignore that cannot be written never stops a review
  return dir;
}

/**
 * Plan settings for the workspace `ws`: { track_plans, open_plans }, each { value, source }
 * with source workspace | global | default. Throws CONFIG_INVALID when either file is broken.
 */
export function resolvePlanSettings(ws) {
  const global = readConfig(globalConfigPath());
  const local = ws ? readConfig(workspaceConfigPath(path.resolve(ws))) : {};
  const pick = key => {
    if (local[key] !== undefined) return { value: local[key], source: "workspace" };
    if (global[key] !== undefined) return { value: global[key], source: "global" };
    return { value: false, source: "default" };
  };
  return { track_plans: pick("track_plans"), open_plans: pick("open_plans") };
}

/**
 * Settings for a new session of `skill` started in `workingDir`; `explicit` holds what the
 * agent passed (reviewer, model, effort). The reviewer resolves first; model and effort then
 * come from that reviewer's entries only. Returns { reviewer, model, effort, open_dashboard,
 * sources } where each source is requested | workspace:<skill> | workspace | global:<skill> |
 * global | default. Throws CONFIG_INVALID when either file is broken.
 */
export function resolveSettings({ skill, workingDir, explicit = {} }) {
  const global = readConfig(globalConfigPath());
  const ws = workingDir ? readConfig(workspaceConfigPath(path.resolve(workingDir))) : {};
  const asked = key => explicit[key] !== undefined && explicit[key] !== null && explicit[key] !== "";
  const first = (key, fallback, levels) => {
    if (asked(key)) return [explicit[key], "requested"];
    for (const [level, source] of levels) if (level && level[key] !== undefined) return [level[key], source];
    return [fallback, "default"];
  };
  const top = [[ws, "workspace"], [global, "global"]];
  const [reviewer, rs] = first("reviewer", DEFAULT_REVIEWER, top);
  const entryOf = cfg => (isObject(cfg.reviewers) && Object.hasOwn(cfg.reviewers, reviewer) ? cfg.reviewers[reviewer] : {});
  const skillOf = entry => (isObject(entry.skills) && Object.hasOwn(entry.skills, skill) ? entry.skills[skill] : null);
  const wsEntry = entryOf(ws);
  const globalEntry = entryOf(global);
  const levels = [
    [skillOf(wsEntry), `workspace:${skill}`],
    [wsEntry, "workspace"],
    [skillOf(globalEntry), `global:${skill}`],
    [globalEntry, "global"],
  ];
  const [model, ms] = first("model", null, levels);
  const [effort, es] = first("effort", DEFAULT_EFFORT, levels);
  const [open, os_] = first("open_dashboard", false, top);
  return { reviewer, model, effort, open_dashboard: open, sources: { reviewer: rs, model: ms, effort: es, open_dashboard: os_ } };
}
