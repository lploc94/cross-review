// The Settings page's logic, without the DOM: select options that never drop a saved
// value, what a review would use at the shown level and where it comes from, and the
// merge that saves only the fields the user changed. Shared by the page and node tests.

export const SKILLS = ["review-plan", "review-impl", "review-think", "review-pr"];
/** Efforts offered when the model catalog is unavailable. */
export const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"];
export const OTHER = "__other__";

const opt = (value, label, selected) => ({ value, label, selected: Boolean(selected) });

/**
 * Model select: the inherited choice first, then the catalog (or "Other…" without one).
 * A saved model the catalog does not list is kept, marked, and selected.
 */
export function modelOptions({ catalog, saved, inherited }) {
  const out = [opt("", inherited, !saved)];
  if (catalog) for (const m of catalog) out.push(opt(m.slug, m.name, m.slug === saved));
  if (saved && !(catalog && catalog.some(m => m.slug === saved))) out.push(opt(saved, `${saved} (not in list)`, true));
  if (!catalog) out.push(opt(OTHER, "Other…", false));
  return out;
}

/** Levels the model supports (the fallback list without a catalog entry). */
export function effortLevels(catalog, model) {
  const m = catalog && model ? catalog.find(x => x.slug === model) : null;
  return m && m.efforts.length ? m.efforts : FALLBACK_EFFORTS;
}

/**
 * Effort select: the inherited choice, then the model's levels. A saved effort outside
 * them is kept, marked "(not verified)", and selected.
 */
export function effortOptions({ catalog, model, saved, inherited }) {
  const levels = effortLevels(catalog, model);
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

/** The chain a review of `skill` reads at this level: [value, source] pairs, first set wins. */
function chain({ global = {}, workspace = null, skill, key }) {
  const g = global || {};
  const w = workspace || {};
  const links = [];
  if (workspace) links.push([w.skills && w.skills[skill] && w.skills[skill][key], SOURCE.wsSkill], [w[key], SOURCE.ws]);
  links.push([g.skills && g.skills[skill] && g.skills[skill][key], SOURCE.gSkill], [g[key], SOURCE.g]);
  return links;
}

/**
 * What a review of `skill` would use for `key` (model | effort) at the shown level
 * (workspace null: global only): { value, source }. Not set anywhere: the model is the
 * reviewer's default (value null), the effort "high".
 */
export function resolveHere({ global, workspace, skill, key }) {
  const hit = chain({ global, workspace, skill, key }).find(([v]) => v !== undefined && v !== null && v !== "");
  if (hit) return { value: hit[0], source: hit[1] };
  return key === "model" ? { value: null, source: "Codex default" } : { value: "high", source: "default" };
}

/**
 * The value a field shows as "Inherit": what applies when this level leaves it empty.
 * Defaults row (no skill): the global value in a workspace, nothing at the global level.
 * Per-skill row: the rest of the chain below this level's skill entry. null: the default.
 */
export function inheritedValue({ global, workspace, skill, key }) {
  const g = global || {};
  let links;
  if (!skill) links = workspace ? [[g[key]]] : [];
  else if (workspace) links = [[workspace[key]], [g.skills && g.skills[skill] && g.skills[skill][key]], [g[key]]];
  else links = [[g[key]]];
  const hit = links.find(([v]) => v !== undefined && v !== null && v !== "");
  return hit ? hit[0] : null;
}

/** The config as it would be saved, for "Show file": empty skill entries dropped. */
export function preview(config) {
  return JSON.stringify(mergeForm(config, {}, []), null, 2);
}
