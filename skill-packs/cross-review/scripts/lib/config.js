// Review settings at two levels: ~/.cross-review/config.json (global) and
// <workspace>/.cross-review/config.json. `begin` takes its defaults from them; the
// dashboard's Settings page reads and writes them.
//
// Schema: { reviewer?, model?, effort?, open_dashboard?, skills?: { <skill>: { model?, effort? } } }
// Each key resolves on its own: requested > workspace skill > workspace > global skill >
// global > default (the reviewer's own model, effort "high", reviewer "codex").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_REVIEWER, REVIEWER_NAMES } from "./reviewers/index.js";

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

function checkEffort(v, where, errors) {
  if (typeof v !== "string" || !/^[a-z]+$/.test(v)) errors.push(`${where}: must be a lowercase word such as "high"`);
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
    } else if (key === "open_dashboard") {
      if (typeof v !== "boolean") errors.push("open_dashboard: must be true or false");
    } else if (key === "skills") {
      if (!isObject(v)) {
        errors.push("skills: must be an object keyed by skill");
        continue;
      }
      for (const [skill, entry] of Object.entries(v)) {
        if (!CONFIG_SKILLS.includes(skill)) {
          errors.push(`skills: unknown skill ${JSON.stringify(skill)} (known: ${CONFIG_SKILLS.join(", ")})`);
          continue;
        }
        if (!isObject(entry)) {
          errors.push(`skills.${skill}: must be an object`);
          continue;
        }
        for (const [k, x] of Object.entries(entry)) {
          if (k === "model") checkModel(x, `skills.${skill}.model`, errors);
          else if (k === "effort") checkEffort(x, `skills.${skill}.effort`, errors);
          else errors.push(`skills.${skill}: unknown key ${JSON.stringify(k)} (only model and effort)`);
        }
      }
    } else {
      errors.push(`unknown key ${JSON.stringify(key)}`);
    }
  }
  return errors;
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
  return obj;
}

/** Drop empty skill entries, so a cleared field leaves no `{}` behind. */
function prune(obj) {
  const out = { ...obj };
  if (isObject(out.skills)) {
    const skills = {};
    for (const [s, e] of Object.entries(out.skills)) if (isObject(e) && Object.keys(e).length) skills[s] = e;
    if (Object.keys(skills).length) out.skills = skills; else delete out.skills;
  }
  return out;
}

/** Validate and write `obj` (temp file + rename). An empty config deletes the file. */
export function writeConfig(file, obj) {
  const errors = validateConfig(obj);
  if (errors.length) throw new ConfigError(errors.join("; "));
  const clean = prune(obj);
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

/** Create <ws>/.cross-review with a `*` .gitignore, so sessions and config stay out of git. */
export function ensureCrossReviewDir(ws) {
  const dir = path.join(ws, ".cross-review");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch {}
  return dir;
}

/**
 * Settings for a new session of `skill` started in `workingDir`; `explicit` holds what the
 * agent passed (reviewer, model, effort). Returns { reviewer, model, effort, open_dashboard,
 * sources } where each source is requested | workspace:<skill> | workspace | global:<skill> |
 * global | default. Throws CONFIG_INVALID when either file is broken.
 */
export function resolveSettings({ skill, workingDir, explicit = {} }) {
  const global = readConfig(globalConfigPath());
  const ws = workingDir ? readConfig(workspaceConfigPath(path.resolve(workingDir))) : {};
  const levels = [
    [ws.skills && ws.skills[skill], `workspace:${skill}`],
    [ws, "workspace"],
    [global.skills && global.skills[skill], `global:${skill}`],
    [global, "global"],
  ];
  const pick = (key, fallback, perSkill = true) => {
    if (explicit[key] !== undefined && explicit[key] !== null && explicit[key] !== "") return [explicit[key], "requested"];
    for (const [level, source] of levels) {
      if (!perSkill && source.includes(":")) continue;
      if (level && level[key] !== undefined) return [level[key], source];
    }
    return [fallback, "default"];
  };
  const [reviewer, rs] = pick("reviewer", DEFAULT_REVIEWER, false);
  const [model, ms] = pick("model", null);
  const [effort, es] = pick("effort", DEFAULT_EFFORT);
  const [open, os_] = pick("open_dashboard", false, false);
  return { reviewer, model, effort, open_dashboard: open, sources: { reviewer: rs, model: ms, effort: es, open_dashboard: os_ } };
}
