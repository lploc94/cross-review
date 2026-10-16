// The Settings page's logic, without the DOM: select options that never drop a saved
// value, what a review would use at the shown level and where it comes from, and the
// merge that saves only the fields the user changed. Shared by the page and node tests.

export const SKILLS = ["review-plan", "review-impl", "review-think", "review-pr"];
/** Efforts offered when the model catalog is unavailable. */
export const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];
export const OTHER = "__other__";
export const REVIEWERS = { codex: "Codex", claude: "Claude Code", agy: "Antigravity" };
export const DEFAULT_REVIEWER = "codex";

const opt = (value, label, selected) => ({ value, label, selected: Boolean(selected) });

/**
 * Model select: the inherited choice first, then the catalog, then "Other…" (without a catalog,
 * or always when the reviewer takes any model name: allowCustom). A saved model the catalog does
 * not list is kept and selected, marked "(not in list)" unless any name is allowed.
 */
export function modelOptions({ catalog, saved, inherited, allowCustom = false }) {
  const out = [opt("", inherited, !saved)];
  if (catalog) for (const m of catalog) out.push(opt(m.slug, m.name, m.slug === saved));
  if (saved && !(catalog && catalog.some(m => m.slug === saved))) out.push(opt(saved, allowCustom ? saved : `${saved} (not in list)`, true));
  if (!catalog || allowCustom) out.push(opt(OTHER, "Other…", false));
  return out;
}

/** The catalog entry for a slug or a display name (agy names its default "Family (Level)"). */
function findModel(catalog, model) {
  if (!catalog || !model) return null;
  const bare = String(model).replace(/\s*\([^()]*\)\s*$/, "");
  return catalog.find(x => x.slug === model) || catalog.find(x => x.name === model || x.name === bare) || null;
}

/** Levels the model supports (the fallback list without a catalog entry). */
export function effortLevels(catalog, model, fallback = FALLBACK_EFFORTS) {
  const m = findModel(catalog, model);
  return m && m.efforts.length ? m.efforts : fallback;
}

/** The catalog lists the model with no effort levels (an agy model that has none). */
export function hasNoEfforts(catalog, model) {
  const m = findModel(catalog, model);
  return Boolean(m && Array.isArray(m.efforts) && !m.efforts.length);
}

/**
 * Effort select: the inherited choice, then the model's levels. A saved effort outside
 * them is kept, marked "(not verified)", and selected.
 */
export function effortOptions({ catalog, model, saved, inherited, fallback }) {
  const levels = effortLevels(catalog, model, fallback);
  const out = [opt("", inherited, !saved), ...levels.map(l => opt(l, l, l === saved))];
  if (saved && !levels.includes(saved)) out.push(opt(saved, `${saved} (not verified)`, true));
  return out;
}

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

const UNSAFE_KEY = new Set(["__proto__", "constructor", "prototype"]);
const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The config to save: the saved one with only the touched fields ("reviewer", "open_dashboard",
 * "reviewers.<name>.<model|effort>", "reviewers.<name>.skills.<skill>.<model|effort>", …) taken
 * from the form. An empty form value removes the field, and objects it leaves empty on its path.
 * The saved object is not modified.
 */
export function mergeForm(saved, form, touched) {
  const out = JSON.parse(JSON.stringify(saved || {}));
  for (const p of touched) {
    const keys = p.split(".");
    if (keys.some(k => UNSAFE_KEY.has(k))) continue;
    const value = getPath(form, p);
    const clear = value === undefined || value === null || value === "";
    const chain = [out];
    for (const k of keys.slice(0, -1)) {
      const node = chain[chain.length - 1];
      if (!isPlain(node[k])) {
        if (clear) break;
        node[k] = {};
      }
      chain.push(node[k]);
    }
    if (chain.length < keys.length) continue; // clearing a field that is not there
    const last = keys[keys.length - 1];
    if (clear) delete chain[chain.length - 1][last];
    else chain[chain.length - 1][last] = value;
    for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][keys[i - 1]];
  }
  return out;
}

const SOURCE = { ws: "workspace", wsSkill: "workspace, this skill", g: "global", gSkill: "global, this skill" };

/** The reviewer a review would use at the shown level (workspace null: global only). */
export function effectiveReviewer({ global, workspace }) {
  return (workspace && workspace.reviewer) || (global && global.reviewer) || DEFAULT_REVIEWER;
}

/** A level's entry for one reviewer: reviewers.<name>, or {} (a name from a file is a plain key). */
const entryOf = (cfg, reviewer) => {
  const r = cfg && isPlain(cfg.reviewers) && Object.hasOwn(cfg.reviewers, reviewer) ? cfg.reviewers[reviewer] : null;
  return isPlain(r) ? r : {};
};

/** The chain a review of `skill` reads at this level: [value, source] pairs, first set wins. */
function chain({ global = {}, workspace = null, skill, key, reviewer = DEFAULT_REVIEWER }) {
  const g = entryOf(global, reviewer);
  const w = entryOf(workspace, reviewer);
  const links = [];
  if (workspace) links.push([w.skills && w.skills[skill] && w.skills[skill][key], SOURCE.wsSkill], [w[key], SOURCE.ws]);
  links.push([g.skills && g.skills[skill] && g.skills[skill][key], SOURCE.gSkill], [g[key], SOURCE.g]);
  return links;
}

/**
 * What a review of `skill` by `reviewer` would use for `key` (model | effort) at the shown
 * level (workspace null: global only), read from reviewers.<reviewer>: { value, source }. Not
 * set anywhere: the model is the reviewer's default (value null), the effort "high".
 */
export function resolveHere({ global, workspace, skill, key, reviewer = DEFAULT_REVIEWER }) {
  const hit = chain({ global, workspace, skill, key, reviewer }).find(([v]) => v !== undefined && v !== null && v !== "");
  if (hit) return { value: hit[0], source: hit[1] };
  const label = Object.hasOwn(REVIEWERS, reviewer) ? REVIEWERS[reviewer] : reviewer;
  return key === "model" ? { value: null, source: `${label} default` } : { value: "high", source: "default" };
}

/**
 * The value a field shows as "Inherit": what applies when this level leaves it empty.
 * Defaults row (no skill): the global value in a workspace, nothing at the global level.
 * Per-skill row: the rest of the chain below this level's skill entry. null: the default.
 * Read from reviewers.<reviewer> at each level.
 */
export function inheritedValue({ global, workspace, skill, key, reviewer = DEFAULT_REVIEWER }) {
  const g = entryOf(global, reviewer);
  let links;
  if (!skill) links = workspace ? [[g[key]]] : [];
  else if (workspace) links = [[entryOf(workspace, reviewer)[key]], [g.skills && g.skills[skill] && g.skills[skill][key]], [g[key]]];
  else links = [[g[key]]];
  const hit = links.find(([v]) => v !== undefined && v !== null && v !== "");
  return hit ? hit[0] : null;
}

/** The config as it would be saved, for "Show file": empty skill entries dropped. */
export function preview(config) {
  return JSON.stringify(mergeForm(config, {}, []), null, 2);
}
