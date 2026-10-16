// Plans written by loop-plan into <workspace>/.cross-review/plans/ (lib/plans.js): parsing,
// progress and state, listing, git facts, the .gitignore that decides whether git keeps them,
// and the runner's `plans` command. HOME and every workspace are temp dirs; plans are invented.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fillCommits, gitPlanFacts, isLoopPlan, isPlanFileName, listPlans, parsePlan, planProgress, planState, plansDir, summarizePlan,
} from "../skill-packs/cross-review/scripts/lib/plans.js";
import { GITIGNORE, ensureCrossReviewDir, globalConfigPath, syncGitignore, workspaceConfigPath } from "../skill-packs/cross-review/scripts/lib/config.js";
import { findWorkspaces, isWorkspace } from "../skill-packs/cross-review/scripts/lib/dashboard/scan.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(repo, "skill-packs", "cross-review", "scripts", "review-runner.js");
const FIXTURES = path.join(repo, "tests", "helpers", "fixtures");
const EXPORT = fs.readFileSync(path.join(FIXTURES, "export-formats-plan.md"), "utf8");
const SYNC = fs.readFileSync(path.join(FIXTURES, "sync-offline-plan.md"), "utf8");

let tmp;
const savedHome = process.env.HOME;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plans-test-")));
  process.env.HOME = path.join(tmp, "home");
  fs.mkdirSync(process.env.HOME);
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
const dir = name => {
  const d = path.join(tmp, `${name}-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const GIT_ENV = { GIT_AUTHOR_NAME: "Invented", GIT_AUTHOR_EMAIL: "invented@example.invalid", GIT_COMMITTER_NAME: "Invented", GIT_COMMITTER_EMAIL: "invented@example.invalid" };
const git = (ws, ...args) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
const gitRepo = name => {
  const ws = dir(name);
  assert.equal(git(ws, "init", "-q").status, 0);
  return ws;
};
const ignored = (ws, rel) => git(ws, "check-ignore", "-q", rel).status === 0;
const writePlan = (ws, file, text) => {
  fs.mkdirSync(plansDir(ws), { recursive: true });
  fs.writeFileSync(path.join(plansDir(ws), file), text);
};
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const runPlans = (...args) => spawnSync(process.execPath, [RUNNER, "plans", ...args], { encoding: "utf8", timeout: 30000, env: { ...process.env } });

// ---------- parsing ----------

test("parsePlan reads title, schema, target, plan review, phases, criteria, commits, completion and the log", () => {
  const p = parsePlan(EXPORT);
  assert.equal(p.title, "CSV and JSON export");
  assert.equal(p.schema, "loop-plan/v1");
  assert.match(p.target, /^Users export any list as CSV or JSON/);
  assert.deepEqual(p.planReview, { verdict: "APPROVE", session: "review-plan-20261012-002", user: null, raw: "APPROVE (review-plan review-plan-20261012-002, 2026-10-12)" });
  assert.deepEqual(p.phases.map(ph => [ph.n, ph.name, ph.acs.length, ph.acs.filter(a => a.met).length]),
    [[1, "Export model and formats", 4, 4], [2, "The export command", 3, 3], [3, "Streaming large exports", 4, 2], [4, "Default format setting", 3, 0], [5, "Docs and release notes", 2, 0]]);
  const [one, two, three] = p.phases;
  assert.equal(one.goal, "One row model behind both formats, so CSV and JSON can never disagree.");
  assert.equal(three.dependencies, "Phases 1 and 2.");
  assert.deepEqual(one.acs[2], { id: "AC-1.3", text: "Dates are written as ISO 8601 in UTC — proven by `test/dates.test.js`.", met: true }); // [X] counts
  assert.equal(three.acs[2].met, false);
  assert.deepEqual([one.checkpoint, two.checkpoint, three.checkpoint], ["review-impl", null, "review-impl"]);
  assert.deepEqual(one.commit, { message: "feat(export): one row model behind CSV and JSON", sha: null });
  assert.match(p.completion, /Every criterion is ticked/);
  // The code fence in "Design and project patterns" holds a "## Phase 9" that is not a section
  assert.equal(p.sections.some(s => /Phase 9/.test(s.title || "")), false);
  assert.deepEqual(p.sections.filter(s => s.phase).map(s => [s.id, s.phase]), [["phase-1", 1], ["phase-2", 2], ["phase-3", 3], ["phase-4", 4], ["phase-5", 5]]);
  assert.deepEqual(p.sections.slice(0, 3).map(s => s.id), ["plan-schema", "target", "scope"]);

  assert.deepEqual(p.log.map(e => [e.date, e.kind, e.phase]), [
    ["2026-10-13", "discovery", null], ["2026-10-14", "phase", 1], ["2026-10-14", "phase", 2],
    ["2026-10-15", "decision", null], ["2026-10-15", "phase", 3], [null, "note", null],
  ]);
  assert.deepEqual(p.log[1].sessions, ["review-impl-20261013-004"]);
  assert.match(p.log[2].text, /3 of 3 criteria\.\n.*12 passed/); // the indented line belongs to it
  assert.deepEqual(p.sessionIds, ["review-plan-20261012-002", "review-impl-20261013-004"]);
});

test("parsePlan: a second plan with other counts, CRLF line ends, and documents with an intro", () => {
  const p = parsePlan(SYNC);
  assert.equal(p.title, "Offline drafts");
  assert.deepEqual(p.phases.map(ph => [ph.n, ph.acs.length]), [[1, 2], [2, 1]]);
  assert.deepEqual(p.planReview, { verdict: "pending", session: null, user: null, raw: "pending" });
  assert.deepEqual(p.log, []);
  // CRLF gives the same result
  const crlf = parsePlan(EXPORT.replace(/\n/g, "\r\n"));
  const lf = parsePlan(EXPORT);
  assert.deepEqual(crlf.phases, lf.phases);
  assert.deepEqual(crlf.log, lf.log);
  assert.equal(crlf.title, lf.title);
  // An intro before the first H2 is kept, and joining the sections gives the whole text but the H1
  const doc = "# Sync notes\n\nTwo devices can edit the same note offline.\n\n- one\n- two\n\n## Options\nMerge by paragraph.\n\n## Open questions\nTombstones?\n";
  const d = parsePlan(doc);
  assert.equal(d.sections[0].id, "intro");
  assert.equal(d.sections[0].title, null);
  assert.match(d.sections[0].md, /Two devices can edit[\s\S]*- two/);
  assert.deepEqual(d.sections.map(s => s.title), [null, "Options", "Open questions"]);
  const joined = d.sections.map(s => (s.title ? `## ${s.title}\n` : "") + s.md).join("");
  assert.equal(joined.replace(/\s+/g, " ").trim(), doc.replace(/^# Sync notes\n/, "").replace(/\s+/g, " ").trim());
  // No H2 at all: everything but the H1 is the intro; no H1: no title
  assert.deepEqual(parsePlan("# Only\nbody text\n").sections.map(s => [s.id, s.md.trim()]), [["intro", "body text"]]);
  assert.equal(parsePlan("no heading here\n").title, null);
  // Nothing breaks on odd input
  for (const odd of ["", "\n\n", "## Phase x: no number\n- [x] stray", "```\n## inside\n"]) assert.doesNotThrow(() => parsePlan(odd));
});

test("Plan Review: only APPROVE with a source approves", () => {
  const review = line => parsePlan(`# P\n\n## Plan schema\nloop-plan/v1\n\n## Plan Review\n${line}\n`).planReview;
  assert.deepEqual(review("APPROVE (user, 2026-10-15)"), { verdict: "APPROVE", session: null, user: "2026-10-15", raw: "APPROVE (user, 2026-10-15)" });
  assert.equal(review("REVISE (review-plan review-plan-20261014-002)").verdict, "REVISE");
  assert.deepEqual(review("APPROVE"), { verdict: "APPROVE", session: null, user: null, raw: "APPROVE" });
  assert.equal(parsePlan("# P\n").planReview.verdict, null);
});

test("planProgress and planState", () => {
  const variant = (review, ticks) => {
    const text = EXPORT.replace(/^APPROVE \(review-plan .*$/m, review);
    // tick only the real criteria, after the code fence that holds an invented one
    const cut = text.indexOf("## Plan Review");
    let tail = text.slice(cut).replace(/- \[[xX]\]/g, "- [ ]");
    for (let i = 0; i < ticks; i++) tail = tail.replace("- [ ]", "- [x]");
    return parsePlan(text.slice(0, cut) + tail);
  };
  const exp = parsePlan(EXPORT);
  assert.deepEqual(planProgress(exp), { phasesDone: 2, phasesTotal: 5, acsMet: 9, acsTotal: 16, current: 3 });
  assert.deepEqual(planProgress(parsePlan(SYNC)), { phasesDone: 0, phasesTotal: 2, acsMet: 0, acsTotal: 3, current: 1 });
  const cases = [
    ["pending", 0, {}, "draft"],
    ["REVISE (review-plan review-plan-20261012-001, 2026-10-12)", 0, {}, "draft"],
    ["pending", 0, { reviewing: true }, "review"],
    ["APPROVE (review-plan review-plan-20261012-002, 2026-10-12)", 0, {}, "ready"],
    ["APPROVE (user, 2026-10-15)", 0, {}, "ready"],
    ["APPROVE", 0, {}, "draft"],
    ["APPROVE (user, 2026-10-15)", 1, {}, "progress"],
    ["APPROVE (user, 2026-10-15)", 16, {}, "done"],
    ["APPROVE (user, 2026-10-15)", 16, { reviewing: true }, "done"],
  ];
  for (const [review, ticks, opts, want] of cases) assert.equal(planState(variant(review, ticks), opts), want, `${review} / ${ticks}`);
  assert.equal(planProgress(variant("pending", 16)).current, null);
  // A phase without criteria never counts as done
  const empty = parsePlan("# P\n\n## Plan schema\nloop-plan/v1\n\n## Phase 1: Nothing yet\n### Goal\nx\n");
  assert.deepEqual(planProgress(empty), { phasesDone: 0, phasesTotal: 1, acsMet: 0, acsTotal: 0, current: 1 });
  assert.notEqual(planState(empty), "done");
});

// ---------- listing ----------

test("listPlans and summarizePlan: .md files of the plans folder; loop-plan plans and markdown documents", () => {
  const ws = dir("list");
  writePlan(ws, "export-formats-plan.md", EXPORT);
  writePlan(ws, "sync notes.md", "# Sync notes\n\nWhy offline needs merging.\n\n## Options\nThe tombstone idea.\n");
  writePlan(ws, "kế-hoạch.md", "no heading, just words\n");
  writePlan(ws, "other.md", "# Other\n\n## Plan schema\nother/v2\n");
  writePlan(ws, "fenced.md", "# Fenced\n\n```\n## Plan schema\nloop-plan/v1\n```\n");
  writePlan(ws, ".draft.md", EXPORT);
  writePlan(ws, "notes.txt", "x");
  fs.mkdirSync(path.join(plansDir(ws), "folder.md"));
  fs.symlinkSync(path.join(FIXTURES, "sync-offline-plan.md"), path.join(plansDir(ws), "linked-plan.md"));
  assert.deepEqual(listPlans(ws), ["export-formats-plan.md", "fenced.md", "kế-hoạch.md", "other.md", "sync notes.md"]);
  assert.deepEqual(listPlans(dir("none")), []);

  const sum = Object.fromEntries(listPlans(ws).map(f => [f, summarizePlan(ws, f)]));
  assert.deepEqual([sum["export-formats-plan.md"].format, sum["export-formats-plan.md"].state, sum["export-formats-plan.md"].progress.acsMet], ["loop-plan", "progress", 9]);
  for (const f of ["fenced.md", "kế-hoạch.md", "other.md", "sync notes.md"]) {
    assert.deepEqual([sum[f].format, sum[f].state, sum[f].progress, sum[f].planReview], ["markdown", "doc", null, null], f);
  }
  assert.equal(sum["kế-hoạch.md"].title, "kế-hoạch.md");
  assert.equal(sum["sync notes.md"].title, "Sync notes");
  assert.equal(sum["export-formats-plan.md"].path, path.join(plansDir(ws), "export-formats-plan.md"));
  // Search text: words only in the Target, only in a phase name, only in a document's body
  assert.match(sum["export-formats-plan.md"].searchText, /50 000 rows/);
  assert.match(sum["export-formats-plan.md"].searchText, /streaming large exports/);
  assert.match(sum["sync notes.md"].searchText, /tombstone/);
  assert.equal(sum["export-formats-plan.md"].tracked, null); // no git facts asked for
  assert.equal(isLoopPlan(EXPORT), true);
  assert.equal(isLoopPlan("```\n## Plan schema\nloop-plan/v1\n```\n"), false);
});

test("isPlanFileName", () => {
  for (const ok of ["a.md", "sync notes.md", "kế-hoạch.md", "UPPER.MD", `${"x".repeat(250)}.md`]) assert.equal(isPlanFileName(ok), true, ok);
  for (const bad of [".hidden.md", "a.txt", "a/b.md", "a\\b.md", "a\0.md", "a\n.md", "..", ".md", `${"é".repeat(127)}.md`, "", null]) {
    assert.equal(isPlanFileName(bad), false, JSON.stringify(bad));
  }
});

// ---------- .gitignore ----------

test("syncGitignore: created, updated, unchanged, custom — checked with git itself", () => {
  const ws = gitRepo("sync");
  const gi = path.join(ws, ".cross-review", ".gitignore");
  assert.equal(syncGitignore(ws, false), "created");
  assert.equal(fs.readFileSync(gi, "utf8"), GITIGNORE.ignore);
  assert.equal(syncGitignore(ws, false), "unchanged");
  assert.equal(ignored(ws, ".cross-review/plans/x-plan.md"), true);
  assert.equal(syncGitignore(ws, true), "updated");
  assert.equal(fs.readFileSync(gi, "utf8"), GITIGNORE.track);
  assert.equal(syncGitignore(ws, true), "unchanged");
  assert.equal(ignored(ws, ".cross-review/plans/x-plan.md"), false);
  assert.equal(ignored(ws, ".cross-review/plans/deep/y.md"), false);
  assert.equal(ignored(ws, ".cross-review/sessions/s/state.json"), true);
  assert.equal(ignored(ws, ".cross-review/config.json"), true);
  assert.equal(syncGitignore(ws, false), "updated");
  assert.equal(ignored(ws, ".cross-review/plans/x-plan.md"), true);
  fs.writeFileSync(gi, "*\n!keep.md\n");
  for (const track of [true, false]) assert.equal(syncGitignore(ws, track), "custom");
  assert.equal(fs.readFileSync(gi, "utf8"), "*\n!keep.md\n");
  assert.deepEqual(fs.readdirSync(path.dirname(gi)).filter(f => f.includes(".tmp")), []);
});

test("ensureCrossReviewDir follows track_plans; a broken config keeps the file it finds", () => {
  const ws = dir("ensure");
  put(workspaceConfigPath(ws), { track_plans: true });
  ensureCrossReviewDir(ws);
  const gi = path.join(ws, ".cross-review", ".gitignore");
  assert.equal(fs.readFileSync(gi, "utf8"), GITIGNORE.track);
  put(workspaceConfigPath(ws), "{ broken");
  assert.doesNotThrow(() => ensureCrossReviewDir(ws));
  assert.equal(fs.readFileSync(gi, "utf8"), GITIGNORE.track);
  const fresh = dir("ensure-broken");
  put(workspaceConfigPath(fresh), "[");
  ensureCrossReviewDir(fresh);
  assert.equal(fs.readFileSync(path.join(fresh, ".cross-review", ".gitignore"), "utf8"), "*\n");
});

// ---------- git facts ----------

test("gitPlanFacts and tracked follow git, not the setting", () => {
  // A root .gitignore that ignores the whole .cross-review/ blocks the exception inside it
  const ws = gitRepo("facts");
  fs.writeFileSync(path.join(ws, ".gitignore"), ".cross-review/\n");
  syncGitignore(ws, true);
  writePlan(ws, "export-formats-plan.md", EXPORT);
  let f = gitPlanFacts(ws, listPlans(ws));
  assert.equal(f.repo, true);
  assert.equal(f.newPlansIgnored, true);
  assert.match(f.blockedBy, /^\.gitignore:1:\.cross-review\/$/);
  assert.equal(summarizePlan(ws, "export-formats-plan.md", f).tracked, false);
  // .cross-review/* plus an exception for plans/ lets it through
  fs.writeFileSync(path.join(ws, ".gitignore"), ".cross-review/*\n!.cross-review/plans/\n");
  f = gitPlanFacts(ws, listPlans(ws));
  assert.deepEqual([f.newPlansIgnored, f.blockedBy], [false, null]);
  assert.equal(summarizePlan(ws, "export-formats-plan.md", f).tracked, true);

  // A plan committed while tracking stays tracked after the setting goes off; a new one does not
  const ws2 = gitRepo("facts-committed");
  syncGitignore(ws2, true);
  writePlan(ws2, "export-formats-plan.md", EXPORT);
  assert.equal(git(ws2, "add", ".cross-review/plans/export-formats-plan.md").status, 0);
  assert.equal(git(ws2, "commit", "-qm", "docs: add the invented plan").status, 0);
  syncGitignore(ws2, false);
  writePlan(ws2, "sync-offline-plan.md", SYNC);
  f = gitPlanFacts(ws2, listPlans(ws2));
  assert.equal(summarizePlan(ws2, "export-formats-plan.md", f).tracked, true);
  assert.equal(summarizePlan(ws2, "sync-offline-plan.md", f).tracked, false);
  assert.equal(f.newPlansIgnored, true);

  // A rule that only ignores hidden files does not block plans named like loop-plan's
  const ws3 = gitRepo("facts-hidden");
  syncGitignore(ws3, true);
  writePlan(ws3, ".gitignore", ".*\n");
  writePlan(ws3, "export-formats-plan.md", EXPORT);
  f = gitPlanFacts(ws3, listPlans(ws3));
  assert.deepEqual([f.newPlansIgnored, summarizePlan(ws3, "export-formats-plan.md", f).tracked], [false, true]);

  // Not a git repo
  const plain = dir("facts-plain");
  writePlan(plain, "export-formats-plan.md", EXPORT);
  f = gitPlanFacts(plain, listPlans(plain));
  assert.equal(f.repo, false);
  assert.equal(summarizePlan(plain, "export-formats-plan.md", f).tracked, null);
});

test("fillCommits: the SHA of the one commit whose subject is the phase's planned message", () => {
  const ws = gitRepo("commits");
  const commit = msg => {
    fs.writeFileSync(path.join(ws, "work.txt"), `${msg} ${Math.random()}\n`);
    git(ws, "add", "work.txt");
    assert.equal(git(ws, "commit", "-qm", msg).status, 0);
    return git(ws, "rev-parse", "--short", "HEAD").stdout.trim();
  };
  const one = commit("feat(export): one row model behind CSV and JSON");
  commit("feat(export): the export command");
  commit("feat(export): the export command"); // the same subject twice: no guess
  commit("feat(export): stream large exports in pages"); // phase 3 is not done
  writePlan(ws, "export-formats-plan.md", EXPORT);
  const facts = gitPlanFacts(ws, listPlans(ws));
  const parsed = parsePlan(EXPORT);
  const filled = fillCommits(parsed, facts);
  assert.deepEqual(filled.phases.map(p => p.commit.sha), [one, null, null, null, null]);
  assert.equal(parsed.phases[0].commit.sha, null); // a copy; the parsed plan is unchanged
  assert.deepEqual(fillCommits(parsed, { repo: false }).phases.map(p => p.commit.sha), [null, null, null, null, null]);
  // An empty repo has no log
  assert.equal(gitPlanFacts(gitRepo("commits-empty"), []).commits.size, 0);
});

// ---------- workspaces ----------

test("a folder with only .cross-review/plans/ is a workspace; a symlinked plans folder is not", () => {
  const root = dir("scan");
  const only = path.join(root, "only-plans");
  writePlan(only, "export-formats-plan.md", EXPORT);
  const linked = path.join(root, "linked");
  fs.mkdirSync(path.join(linked, ".cross-review"), { recursive: true });
  fs.symlinkSync(plansDir(only), path.join(linked, ".cross-review", "plans"));
  assert.equal(isWorkspace(only), true);
  assert.equal(isWorkspace(linked), false);
  assert.deepEqual(findWorkspaces(root), [only]);
});

// ---------- the runner's plans command ----------

test("CLI plans: folder, .gitignore, settings and summaries", () => {
  const ws = gitRepo("cli");
  let r = runPlans("--working-dir", ws);
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    dir: plansDir(ws), track_plans: { value: false, source: "default" }, gitignore: "created",
    git: { repo: true, new_plans_ignored: true, blocked_by: ".cross-review/.gitignore:1:*" }, plans: [],
  });
  assert.equal(fs.statSync(plansDir(ws)).isDirectory(), true);

  writePlan(ws, "export-formats-plan.md", EXPORT);
  writePlan(ws, "notes.md", "# Notes\n\nFree text.\n");
  out = JSON.parse(runPlans("--working-dir", ws).stdout);
  assert.deepEqual(out.plans.map(p => [p.file, p.format, p.state, p.tracked]), [["export-formats-plan.md", "loop-plan", "progress", false], ["notes.md", "markdown", "doc", false]]);
  assert.deepEqual(Object.keys(out.plans[0]).sort(), ["file", "format", "path", "planReview", "progress", "schema", "searchText", "state", "title", "tracked"]);
  assert.equal(out.warning, undefined);

  put(workspaceConfigPath(ws), { track_plans: true });
  out = JSON.parse(runPlans("--working-dir", ws).stdout);
  assert.deepEqual([out.track_plans, out.gitignore, out.git.new_plans_ignored, out.plans.map(p => p.tracked), out.warning],
    [{ value: true, source: "workspace" }, "updated", false, [true, true], undefined]);

  // global on, workspace off: the workspace wins
  put(globalConfigPath(), { track_plans: true });
  put(workspaceConfigPath(ws), { track_plans: false });
  out = JSON.parse(runPlans("--working-dir", ws).stdout);
  assert.deepEqual([out.track_plans, out.gitignore], [{ value: false, source: "workspace" }, "updated"]);
  fs.rmSync(globalConfigPath());

  // a root rule that ignores .cross-review/ while tracking is on: a warning with the fix
  put(workspaceConfigPath(ws), { track_plans: true });
  fs.writeFileSync(path.join(ws, ".gitignore"), ".cross-review/\n");
  out = JSON.parse(runPlans("--working-dir", ws).stdout);
  assert.equal(out.git.blocked_by, ".gitignore:1:.cross-review/");
  assert.match(out.warning, /Plans in git is on, but \.gitignore:1:\.cross-review\/ ignores new plans in \.cross-review\/plans\/\. Change it to \.cross-review\/\* and add !\.cross-review\/plans\//);
  // a hand-edited .cross-review/.gitignore that ignores plans: left alone, and said so
  fs.rmSync(path.join(ws, ".gitignore"));
  fs.writeFileSync(path.join(ws, ".cross-review", ".gitignore"), "*\n!config.json\n");
  out = JSON.parse(runPlans("--working-dir", ws).stdout);
  assert.equal(out.gitignore, "custom");
  assert.deepEqual(out.plans.map(p => p.tracked), [false, false]);
  assert.match(out.warning, /ignores new plans/);
  assert.match(out.warning, /edited by hand/);
  assert.doesNotMatch(out.warning, /Change it to/);
  assert.equal(fs.readFileSync(path.join(ws, ".cross-review", ".gitignore"), "utf8"), "*\n!config.json\n");

  // outside git
  const plain = dir("cli-plain");
  out = JSON.parse(runPlans("--working-dir", plain).stdout);
  assert.deepEqual(out.git, { repo: false, new_plans_ignored: null, blocked_by: null });
});

test("CLI plans: errors", () => {
  let r = runPlans();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--working-dir/);
  r = runPlans("--working-dir", path.join(tmp, "missing"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  const ws = dir("cli-broken");
  put(workspaceConfigPath(ws), "{ nope");
  r = runPlans("--working-dir", ws);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /CONFIG_INVALID/);
  assert.ok(r.stderr.includes(workspaceConfigPath(ws)));
  assert.equal(fs.existsSync(plansDir(ws)), false);
  // --finished names something that is not a plan in the folder
  const ok = dir("cli-finished");
  writePlan(ok, "export-formats-plan.md", EXPORT);
  for (const bad of ["../x.md", "missing-plan.md", path.join(FIXTURES, "export-formats-plan.md")]) {
    r = runPlans("--working-dir", ok, "--finished", bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /not a plan in/);
  }
  // with Follow plans off, a finished plan only lists; no dashboard keys
  for (const name of ["export-formats-plan.md", path.join(plansDir(ok), "export-formats-plan.md")]) {
    r = runPlans("--working-dir", ok, "--finished", name);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal("dashboard_url" in out || "dashboard_error" in out, false);
  }
});
