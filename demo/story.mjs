// The landing page demo's invented projects: review sessions and loop plans in four workspaces
// (harbor-app, services/orchard-api, inkwell, atlas-notes), and the steps that move them while
// the demo plays. Every name, request, finding, command and commit here is made up; nothing
// comes from a real session. build.mjs writes this tree, runs the real dashboard on it, and
// records what each step looks like.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(REPO, "skill-packs/cross-review");
const SKILLS = path.join(PACK, "skills");
const RUNNER = path.join(PACK, "scripts/review-runner.js");
const { parseOutputMarkdown } = await import(pathToFileURL(path.join(PACK, "scripts/lib/parse.js")).href);
const { placeholderNames, parseReviewInput, SKILL_TEMPLATES } = await import(pathToFileURL(path.join(PACK, "scripts/lib/review-core.js")).href);

/** The demo's clock: 16 Oct 2026, 15:42 in UTC+7 (the time zone only moves the labels). */
export const T0 = Math.floor(Date.UTC(2026, 9, 16, 8, 42, 0) / 1000);
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
/** The live session's reviewer process; build.mjs reports it alive until the round ends. */
export const LIVE_PID = 424242;
export const LIVE_ORCHARD_PID = 424243;

const pad = n => String(n).padStart(3, "0");
const write = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
const json = v => JSON.stringify(v, null, 2);

// ---------- activity ----------

/** A shell command as Codex logs it; `s` is how long it ran. */
const sh = (command, s = 1, exit = 0) => ({ kind: "command", command: `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`, s, exit });
const think = (text, s = 4) => ({ kind: "reasoning", text, s });
const say = (text, s = 2) => ({ kind: "message", text, s });

/**
 * The reviewer's event log for one round, with item ids fixed per round and position, so a log
 * written again with more items only appends lines (the dashboard reads appended lines only).
 * `done` acts are complete; the next one, when `open`, has started and not finished.
 */
function roundLog({ tag, threadId, acts, startedAt, open = false, review = null, failed = null }) {
  const lines = [];
  const times = [];
  let t = startedAt;
  const stamp = () => times.push([lines.length, Math.round(t)]);
  lines.push({ type: "thread.started", thread_id: threadId }, { type: "turn.started" });
  stamp();
  const last = acts.length - 1;
  acts.forEach((a, i) => {
    const id = `${tag}_${i}`;
    // Codex logs reasoning and messages only when they complete
    if (open && i === last && a.kind !== "command") return;
    if (a.kind === "command") {
      const item = { id, type: "command_execution", command: a.command, aggregated_output: "" };
      lines.push({ type: "item.started", item: { ...item, exit_code: null, status: "in_progress" } });
      stamp();
      if (open && i === last) return;
      t += a.s;
      lines.push({ type: "item.completed", item: { ...item, exit_code: a.exit, status: a.exit === 0 ? "completed" : "failed" } });
      stamp();
    } else {
      t += a.s;
      lines.push({ type: "item.completed", item: { id, type: a.kind === "reasoning" ? "reasoning" : "agent_message", text: a.text } });
      stamp();
    }
  });
  if (failed) {
    t += 2;
    lines.push({ type: "turn.failed", error: { message: failed } });
    stamp();
  }
  if (review) {
    t += 3;
    lines.push({ type: "item.completed", item: { id: `${tag}_review`, type: "agent_message", text: review } });
    lines.push({ type: "turn.completed", usage: {} });
    stamp();
  }
  return {
    jsonl: lines.map(l => JSON.stringify(l)).join("\n") + "\n",
    times: times.map(r => JSON.stringify(r)).join("\n") + "\n",
    end: t,
  };
}

/** Seconds the acts take, plus the time to write the review. */
const actsTime = acts => acts.reduce((n, a) => n + a.s, 0) + 3;

/** The prompt the runner would send for a round, rendered from the skill's real templates. */
function renderPrompt(skill, mode, round, input) {
  const t = SKILL_TEMPLATES[skill].modes[mode || "default"];
  const values = parseReviewInput(input, placeholderNames(SKILLS, skill));
  return execFileSync(process.execPath, [RUNNER, "render", "--skill", skill, "--template", round === 1 ? t.round1 : t.reply, "--skills-dir", SKILLS], { input: JSON.stringify(values), encoding: "utf8" });
}

/**
 * Write one session in the runner's layout (as tests/helpers/dashboard-fixture.js does, with
 * fixed item ids and the times each act took). spec: { skill, mode?, inputs: [md per round],
 * rounds: [{ status, started, acts, review?, error?, open?, convergence? }], state?, meta?, analysis? }
 */
export function writeSession(sessionsDir, id, spec) {
  const dir = path.join(sessionsDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  const threadId = `thread-${id}`;
  const roundsJson = [];
  spec.rounds.forEach((r, i) => {
    const round = i + 1;
    const last = i === spec.rounds.length - 1;
    const running = r.status === "running";
    const log = roundLog({
      tag: `r${round}`, threadId, acts: r.acts, startedAt: r.started, open: r.open,
      review: r.status === "completed" ? r.review : null,
      failed: r.status === "failed" ? r.error : null,
    });
    const elapsed = running ? null : Math.round(log.end - r.started);
    const review = r.review && r.status === "completed" ? parseOutputMarkdown(r.review, spec.skill) : null;
    const final = running || r.status === "stopped" ? null : {
      status: r.status, round, elapsed_seconds: elapsed, thread_id: threadId,
      review: r.status === "completed" ? review : null, activities: [],
      ...(r.status !== "completed" ? { error: r.error, failure_reason: r.status === "failed" ? "turn_failed" : r.status, recoverable: r.status === "failed" } : {}),
      convergence: r.convergence || { stalemate: false },
    };
    if (spec.inputs[i] !== undefined) write(path.join(dir, "prompts", `round-${pad(round)}.txt`), renderPrompt(spec.skill, spec.mode, round, spec.inputs[i]));
    if (last) {
      write(path.join(dir, "output.jsonl"), log.jsonl);
      if (final) write(path.join(dir, "final.txt"), JSON.stringify(final));
      if (review) write(path.join(dir, "review.md"), r.review);
    } else {
      write(path.join(dir, "outputs", `output-round-${pad(round)}.jsonl`), log.jsonl);
      if (final) write(path.join(dir, "outputs", `final-round-${pad(round)}.json`), JSON.stringify(final));
      if (review) write(path.join(dir, "outputs", `review-round-${pad(round)}.md`), r.review);
    }
    write(path.join(dir, "outputs", `times-round-${pad(round)}.jsonl`), log.times);
    roundsJson.push({
      round, started_at: r.started, completed_at: running ? null : r.started + elapsed, elapsed_seconds: elapsed, status: r.status,
      verdict: review?.verdict?.status || null, issues_found: review?.blocks ? review.blocks.length : null, issue_ids: (review?.blocks || []).map(b => b.id),
    });
  });
  spec.inputs.forEach((text, i) => write(path.join(dir, "inputs", `round-${pad(i + 1)}.md`), text));
  if (spec.analysis) write(path.join(dir, "analysis.md"), spec.analysis);
  const lastRound = spec.rounds[spec.rounds.length - 1];
  write(path.join(dir, "state.json"), json({
    session_id: id, runner_version: 15, skill_name: spec.skill, reviewer: "codex", state_dir: dir,
    working_dir: path.dirname(path.dirname(sessionsDir)), round: spec.rounds.length, created_at: spec.rounds[0].started,
    pid: 999999, pgid: 999999, watchdog_pid: 999998, effort: "high", sandbox: "danger-full-access", timeout: 18000,
    started_at: lastRound.started, thread_id: threadId, mode: spec.mode || "default", model: null,
    caller: { name: "claude-code", title: "Claude Code", version: "2.1.4" },
    ...spec.state,
  }));
  write(path.join(dir, "rounds.json"), json(roundsJson));
  if (spec.meta) write(path.join(dir, "meta.json"), json({ skill: spec.skill, reviewer: "codex", runner_version: 15, rounds: spec.rounds.length, verdict: spec.meta, timing: {}, session_dir: dir }));
  return dir;
}

/** Rounds placed one after another: each starts `gap` seconds after the one before ended. */
function chain(start, rounds, gap = 4 * MIN) {
  let t = start;
  return rounds.map(r => {
    const out = { status: "completed", ...r, started: t };
    t += actsTime(r.acts) + gap;
    return out;
  });
}

const issue = (n, title, { cat = "correctness", sev, where, problem, evidence, fix }) =>
  [`### ISSUE-${n}: ${title}`, `- Category: ${cat}`, `- Severity: ${sev}`, `- Location: ${where}`, `- Problem: ${problem}`,
    ...(evidence ? [`- Evidence: ${evidence}`] : []), ...(fix ? [`- Suggested fix: ${fix}`] : []), ""].join("\n");
const verdict = (status, reason) => `### VERDICT\n- Status: ${status}\n- Reason: ${reason}\n`;

// ---------- harbor-app: the live review (review-impl, phase 3 checkpoint) ----------

const BASE = "4f2c9e1";
const LIVE_REQUEST = "Review phase 3 of `export-formats-plan.md` (streaming large exports) before moving on.";
const LIVE_IN1 = `BASE_BRANCH: ${BASE}

## USER_REQUEST
${LIVE_REQUEST}
The plan is .cross-review/plans/export-formats-plan.md; phase 3 is AC-3.1 to AC-3.5.

## SESSION_CONTEXT
Phases 1 and 2 are committed and were reviewed at the phase 1 checkpoint. The user asked for cancel to leave nothing behind (AC-3.3) and for the toolbar to count rows, not pages (AC-3.4). \`npm test\`: 471 passed before this phase.
`;
const LIVE_R1 = [
  issue(1, "A cancelled export leaves a partial file behind", {
    sev: "high", where: "src/export/stream.ts:88",
    problem: "`exportToFile()` opens `--out` directly with `createWriteStream(out)`. When the AbortSignal fires the stream is destroyed, but the half-written file stays, and the next run without `--force` refuses to overwrite it. AC-3.3 requires no partial file.",
    evidence: "Seeded 60 000 rows in a temp dir and stopped the export after 2 s with `timeout 2`: `t.csv` stayed at 3.1 MB. test/stream.test.js has no cancel case.",
    fix: "Write to a temporary file next to `--out`, rename it on finish, and unlink it on abort.",
  }),
  issue(2, "Rows on a page boundary are written twice", {
    sev: "high", where: "src/export/pager.ts:41",
    problem: "The next page starts at `updated_at >= cursor`, so when the last row of a page shares its timestamp with the next rows, that row is written again.",
    evidence: "`harbor seed --rows 2000 --same-time` then `harbor export --format csv | wc -l` prints 2003 (2000 rows, a header and 2 repeats).",
    fix: "Page by `(updated_at, id)` and resume strictly after the last pair.",
  }),
  issue(3, "JSON writer awaits every row", {
    cat: "performance", sev: "medium", where: "src/export/json-writer.ts:27",
    problem: "`for await` writes and awaits one row at a time; exporting 1 million rows as JSON took 94 s against 21 s for CSV.",
    fix: "Write a page at a time and wait for `drain` only when `write()` returns false.",
  }),
  issue(4, "Toolbar counter counts pages, not rows", {
    sev: "medium", where: "src/ui/ExportButton.tsx:63",
    problem: "The progress event carries the page index, so the toolbar reads 12 after 12 000 rows. AC-3.4 asks for rows written so far.",
    fix: "Send the running row count in the progress event.",
  }),
  issue(5, "Memory test passes without streaming", {
    cat: "tests", sev: "low", where: "test/stream.test.js:52",
    problem: "The 120 MB check reads `heapUsed` after the export resolves, once the buffers are collected; a writer that loads every row first passes it too, so AC-3.2 is not proven.",
    fix: "Sample `rss` during the export and assert on the peak.",
  }),
  verdict("REVISE", "Two high defects, in cancel and in paging; the streaming design itself follows the plan."),
].join("\n");
const LIVE_IN2 = `BASE_BRANCH: ${BASE}

## FIXED_ITEMS
ISSUE-1: A cancelled export leaves a partial file behind — fixed in src/export/stream.ts:84: writes to \`<out>.partial\`, renames on finish, unlinks on abort; test test/stream.test.js:131 cancels after 500 rows and checks the folder is empty.
ISSUE-2: Rows on a page boundary are written twice — fixed in src/export/pager.ts:38: the cursor is \`(updated_at, id)\`; test test/pager.test.js:77 pages 2000 rows with one timestamp.
ISSUE-4: Toolbar counter counts pages, not rows — fixed in src/ui/ExportButton.tsx:61: the progress event carries rows; test test/toolbar.test.js:40.
ISSUE-5: Memory test passes without streaming — fixed in test/stream.test.js:52: samples \`rss\` every 50 ms during the export; checked that it fails with the old buffered writer (186 MB).

## DISPUTED_ITEMS
ISSUE-3: JSON writer awaits every row — the await is the writer's backpressure check, not a flush: \`write()\` resolves at once unless the buffer is full (src/export/json-writer.ts:27-31). \`npm run bench:export -- --rows 1000000\` on this branch: JSON 23.8 s, CSV 21.2 s. The 94 s came from the debug build with source maps.
`;
const LIVE_R2 = [
  issue(6, "Two exports to the same path share one .partial file", {
    sev: "medium", where: "src/export/stream.ts:84",
    problem: "The ISSUE-1 fix names the temporary file `<out>.partial`. A second export to the same `--out` truncates the first one's file, and whichever is cancelled unlinks the other's.",
    evidence: "Two `harbor export --out t.csv` started 1 s apart: the first finished with 41 000 of 60 000 rows.",
    fix: "Add the pid and a random suffix to the temporary name.",
  }),
  issue(7, "Cancel leaves the page request running", {
    sev: "low", where: "src/export/pager.ts:52",
    problem: "The signal is checked between pages but not passed to `fetchPage()`, so a cancel waits for the page in flight (up to 4 s on a slow server).",
    fix: "Pass the signal to `fetchPage()`.",
  }),
  verdict("REVISE", "ISSUE-1, ISSUE-2, ISSUE-4 and ISSUE-5 hold. ISSUE-3 withdrawn: the bench gives 23.8 s for JSON against 21.2 s for CSV. The cancel fix brought two new defects."),
].join("\n");
const LIVE_IN3 = `BASE_BRANCH: ${BASE}

## FIXED_ITEMS
ISSUE-6: Two exports to the same path share one .partial file — fixed in src/export/stream.ts:84: the temporary name is \`<out>.<pid>.<6 random hex>.partial\`; test test/stream.test.js:158 runs two exports to one path.
ISSUE-7: Cancel leaves the page request running — fixed in src/export/pager.ts:52: the signal goes to \`fetchPage()\`; test test/pager.test.js:96 aborts mid-page.

## DISPUTED_ITEMS
None — all issues addressed
`;
const LIVE_R3 = verdict("APPROVE", "ISSUE-6 and ISSUE-7 hold: two exports to one path both finish, and a cancel stops the page request at once. Full suite: 486 passed; lint and typecheck clean. Cancel, paging and the toolbar counter meet AC-3.3 and AC-3.4; nothing new.");

const LIVE_ACTS_1 = [
  sh("git log --oneline -8", 1), sh(`git diff --stat ${BASE}...HEAD`, 1),
  think("Phase 3 touches the pager, both writers, the stream wrapper and the toolbar. Start from the plan's criteria, then read each file against them.", 6),
  sh("sed -n '/^## Phase 3/,/^## Phase 4/p' .cross-review/plans/export-formats-plan.md", 1),
  sh(`git diff ${BASE}...HEAD -- src/export/stream.ts`, 1), sh("nl -ba src/export/stream.ts | sed -n '1,140p'", 1),
  sh("rg -n 'createWriteStream|AbortSignal|signal' src/export", 1), sh("nl -ba src/export/pager.ts | sed -n '1,90p'", 1),
  think("The cursor resumes with >= on updated_at. Rows that share the boundary timestamp would be read again.", 9),
  sh("rg -n 'updated_at' src/export src/api/list.ts", 1), sh("nl -ba src/api/list.ts | sed -n '20,75p'", 1),
  sh("cat test/pager.test.js", 1), sh("cat test/stream.test.js", 1), sh("node --test test/stream.test.js test/pager.test.js", 7),
  say("Reproducing the boundary case with a seeded database before writing it up.", 2),
  sh("d=$(mktemp -d) && node bin/harbor.js seed --rows 2000 --same-time --db \"$d/h.db\" && node bin/harbor.js export --format csv --db \"$d/h.db\" | wc -l", 6),
  sh("d=$(mktemp -d) && node bin/harbor.js seed --rows 60000 --db \"$d/h.db\" && (timeout 2 node bin/harbor.js export --format csv --db \"$d/h.db\" --out \"$d/t.csv\"; echo exit=$?) && ls -la \"$d\"", 9),
  think("Cancel leaves t.csv at 3.1 MB and the next run without --force refuses to write. That breaks AC-3.3.", 7),
  sh("nl -ba src/export/json-writer.ts | sed -n '1,60p'", 1), sh("nl -ba src/export/csv-writer.ts | sed -n '1,60p'", 1),
  sh("npm run bench:export -- --rows 1000000 --format csv", 24), sh("npm run bench:export -- --rows 1000000 --format json", 97),
  sh("rg -n 'progress' src/export src/ui", 1), sh("nl -ba src/ui/ExportButton.tsx | sed -n '30,90p'", 1), sh("cat test/toolbar.test.js", 1),
  think("The progress event carries the page index; the toolbar shows pages. AC-3.4 asks for rows.", 5),
  sh("sed -n '40,70p' test/stream.test.js", 1),
  think("heapUsed is read after the export resolves. A buffering writer would pass this too.", 6),
  sh("npm test 2>&1 | tail -25", 41), sh("npm run lint", 9), sh("npm run typecheck", 14), sh("git status --short", 1),
];
const LIVE_ACTS_2 = [
  sh("git log --oneline -6", 1), sh("git diff HEAD~1 -- src/export test", 1),
  think("Check each fix, then what it touches: the temporary file name, the cursor, the progress event, the memory test.", 5),
  sh("nl -ba src/export/stream.ts | sed -n '70,130p'", 1), sh("rg -n 'partial' src test", 1), sh("sed -n '120,170p' test/stream.test.js", 1),
  sh("node --test test/stream.test.js", 8),
  think("<out>.partial is a fixed name. Two exports to one path would write the same file.", 8),
  sh("d=$(mktemp -d) && node bin/harbor.js seed --rows 60000 --db \"$d/h.db\" && (node bin/harbor.js export --format csv --db \"$d/h.db\" --out \"$d/t.csv\" & sleep 1; node bin/harbor.js export --format csv --db \"$d/h.db\" --out \"$d/t.csv\"; wait) && wc -l \"$d/t.csv\"", 12),
  sh("nl -ba src/export/pager.ts | sed -n '25,75p'", 1), sh("sed -n '60,110p' test/pager.test.js", 1), sh("node --test test/pager.test.js", 5),
  sh("rg -n 'fetchPage' src", 1),
  think("The signal is checked between pages but fetchPage never gets it; a cancel waits for the page in flight.", 6),
  sh("nl -ba src/ui/ExportButton.tsx | sed -n '40,80p'", 1), sh("node --test test/toolbar.test.js", 4),
  sh("git stash && node --test test/stream.test.js --test-name-pattern memory; git stash pop", 19, 1),
  say("The new memory test fails on the old writer (186 MB peak), as the agent says.", 2),
  sh("npm run bench:export -- --rows 1000000 --format json", 25), sh("npm run bench:export -- --rows 1000000 --format csv", 22),
  sh("npm test 2>&1 | tail -25", 43), sh("git status --short", 1),
];
/** Round 3, which the demo plays: the first LIVE_START acts are done before it begins. */
const LIVE_ACTS_3 = [
  sh("git log --oneline -6", 1), sh("git diff HEAD~1 --stat", 1),
  think("Round 3 only needs ISSUE-6 and ISSUE-7 checked, and whatever their fixes touch.", 5),
  sh("git diff HEAD~1 -- src/export/stream.ts src/export/pager.ts", 1), sh("nl -ba src/export/stream.ts | sed -n '70,130p'", 1),
  sh("rg -n 'partial' src test", 1), sh("sed -n '140,190p' test/stream.test.js", 1), sh("node --test test/stream.test.js", 8),
  think("The temporary name now carries the pid and 6 random bytes; two exports cannot collide, and each unlinks only its own.", 5),
  sh("rg -n 'fetchPage' src", 1), sh("nl -ba src/export/pager.ts | sed -n '30,75p'", 1), sh("sed -n '80,120p' test/pager.test.js", 1),
  sh("node --test test/pager.test.js", 5), sh("rg -n 'signal' src/export src/api/list.ts", 1), sh("nl -ba src/api/list.ts | sed -n '1,60p'", 1),
  think("fetchPage hands the signal to fetch(); an aborted export stops the page request too.", 5),
  sh("d=$(mktemp -d) && node bin/harbor.js seed --rows 60000 --db \"$d/h.db\" && (timeout 2 node bin/harbor.js export --format csv --db \"$d/h.db\" --out \"$d/t.csv\"; echo exit=$?) && ls -la \"$d\"", 9),
  say("After a cancel only the database is left in the temp dir. Checking the toolbar and the full suite next.", 2),
  sh("nl -ba src/ui/ExportButton.tsx | sed -n '40,90p'", 1), sh("node --test test/toolbar.test.js", 4),
  sh("rg -n 'AC-3\\.[345]' .cross-review/plans/export-formats-plan.md", 1),
  sh("npm run bench:export -- --rows 1000000 --format json", 25), sh("npm run lint", 9), sh("npm run typecheck", 14),
  sh("npm test 2>&1 | tail -25", 42), sh("git status --short", 1),
  think("All five earlier fixes still hold; the two new ones are narrow and tested. Nothing else in the diff changed.", 6),
];
/** Acts of round 3 already done when the demo starts; the demo adds the rest one or two at a time. */
export const LIVE_START = 6;
export const LIVE_TOTAL = LIVE_ACTS_3.length;
/** How long act i of the live round takes (the demo's clock moves by it). */
export const liveSeconds = i => LIVE_ACTS_3[i].s;
const LIVE_ID = "review-impl-20261016-007";
// round 3's first LIVE_START acts end 20 s before the demo starts
const LIVE_R3_START = T0 - 20 - LIVE_ACTS_3.slice(0, LIVE_START).reduce((n, a) => n + a.s, 0);

/**
 * Acts before `first` keep their own durations and end at `base`; a later act i ends at
 * `ends[i]` (the demo's clock when it completed). The act in progress keeps its duration.
 */
function retime(acts, first, base, ends) {
  return acts.map((a, i) => (i < first || ends[i] === undefined ? a : { ...a, s: Math.max(1, ends[i] - (i === first ? base : ends[i - 1])) }));
}

/**
 * The live session after `done` acts of round 3, or, when `approved`, with its verdict and the
 * session ended at `now`. `ends[i]`: the clock time act i completed.
 */
export function writeLive(ws, { done, approved, now, ends }) {
  const [r1, r2] = chain(T0 - 24 * MIN, [{ acts: LIVE_ACTS_1, review: LIVE_R1 }, { acts: LIVE_ACTS_2, review: LIVE_R2 }], 3 * MIN);
  const all = approved || done >= LIVE_TOTAL;
  const acts = retime(LIVE_ACTS_3.slice(0, all ? LIVE_TOTAL : done + 1), LIVE_START, T0 - 20, ends);
  return writeSession(sessions(ws), LIVE_ID, {
    skill: "review-impl", mode: "branch", inputs: [LIVE_IN1, LIVE_IN2, LIVE_IN3],
    state: approved ? { ended_at: now, end_outcome: "finalized" } : { pid: LIVE_PID, pgid: LIVE_PID },
    meta: approved ? "APPROVE" : null,
    rounds: [r1, r2, approved
      ? { status: "completed", started: LIVE_R3_START, acts, review: LIVE_R3 }
      : { status: "running", started: LIVE_R3_START, acts, open: !all }],
  });
}

// ---------- orchard-api: a plan review running in the list ----------

const ORCH_REQUEST = "Check the plan for per-token rate limits on the public search API.";
const ORCH_ACTS = [
  sh("sed -n '1,200p' .cross-review/plans/search-rate-limits-plan.md", 1), sh("rg -n 'rateLimit|RateLimiter|429' src", 1),
  sh("nl -ba src/middleware/auth.ts | sed -n '1,80p'", 1), sh("nl -ba src/routes/search.ts | sed -n '1,120p'", 1),
  think("The plan keys the bucket on the token id; anonymous search has no token. Check how anonymous requests reach the route.", 7),
  sh("rg -n 'anonymous|publicKey' src/middleware src/routes", 1), sh("cat config/default.yaml", 1), sh("rg -n 'redis' src package.json", 1),
  sh("nl -ba src/cache/redis.ts | sed -n '1,70p'", 1), sh("cat test/routes/search.test.ts | head -120", 1),
  think("The plan's 600 requests a minute has no source; the gateway logs would give the real peak.", 6),
  sh("rg -n 'X-RateLimit|Retry-After' src docs", 1), sh("sed -n '/^## Phase 2/,/^## Phase 3/p' .cross-review/plans/search-rate-limits-plan.md", 1),
  sh("npm test -- routes/search 2>&1 | tail -15", 18), sh("rg -n 'MULTI|EVAL|INCR' src/cache", 1),
  think("A fixed window in INCR + EXPIRE lets a client send twice the limit across a window edge. The plan should say whether that is acceptable.", 8),
  sh("nl -ba src/cache/redis.ts | sed -n '70,140p'", 1), sh("sed -n '/^## Capacity/,/^## Global Gates/p' .cross-review/plans/search-rate-limits-plan.md", 1),
];
export const ORCH_START = 5;
export const ORCH_TOTAL = ORCH_ACTS.length;
const ORCH_ID = "review-plan-20261016-003";
const ORCH_R1_START = T0 - 15 - ORCH_ACTS.slice(0, ORCH_START).reduce((n, a) => n + a.s, 0);

/** The orchard-api plan review, running, after `done` acts. */
export function writeOrchard(ws, { done, ends }) {
  const acts = retime(ORCH_ACTS.slice(0, Math.min(ORCH_TOTAL, done + 1)), ORCH_START, T0 - 15, ends);
  return writeSession(sessions(ws), ORCH_ID, {
    skill: "review-plan", inputs: [`PLAN_PATH: ${ws}/.cross-review/plans/search-rate-limits-plan.md\n\n## USER_REQUEST\n${ORCH_REQUEST}\n\n## SESSION_CONTEXT\nThe API sits behind the gateway in infra/; Redis is already used for the search cache.\n`],
    state: { pid: LIVE_ORCHARD_PID, pgid: LIVE_ORCHARD_PID, caller: { name: "codex-mcp-client", title: "Codex", version: "0.46.0" } },
    rounds: [{ status: "running", started: ORCH_R1_START, acts, open: done < ORCH_TOTAL }],
  });
}

// ---------- the other sessions ----------

const sessions = ws => path.join(ws, ".cross-review", "sessions");

/** Generic reading for a project: enough commands that a finished round looks like real work. */
const reads = (files, tests, extra = []) => [
  sh("git status --short", 1), sh("git diff --stat", 1),
  ...files.flatMap(f => [sh(`nl -ba ${f} | sed -n '1,120p'`, 1), sh(`rg -n '${path.basename(f).replace(/\..*$/, "")}' src test`, 1)]),
  ...extra,
  ...tests.map(t => sh(t, 12)),
];

function others(ws) {
  const { harbor, orchard, inkwell, atlas } = ws;

  // harbor-app
  const waitR1 = [
    issue(1, "Permissions are checked after the notebook is loaded", { cat: "security", sev: "high", where: "plan, Phase 2 (Notebook access)", problem: "Phase 2 loads the notebook, then checks the member's role. A missing notebook and a forbidden one give different answers, so an outsider can tell which ids exist.", fix: "Check membership in the query and answer 404 for both." }),
    issue(2, "No migration for existing shared links", { sev: "medium", where: "plan, Phase 3", problem: "Shared links created before this change carry no role; the plan does not say what they become.", fix: "Add a step that gives existing links the viewer role, with a rerun-safe migration." }),
    issue(3, "Role names differ between the plan and the API", { sev: "low", where: "plan, Fixed decisions", problem: "The plan says reader/writer; src/api/roles.ts:4 already exports viewer/editor.", fix: "Use the existing names." }),
    issue(4, "No test that an editor cannot change roles", { cat: "tests", sev: "medium", where: "plan, Phase 2 Tests first", problem: "The tests cover owners and viewers only; the rule the target names for editors is never exercised." }),
    verdict("REVISE", "One security gap and a missing migration; the phases are otherwise in the right order."),
  ].join("\n");
  writeSession(sessions(harbor), "review-plan-20261016-002", {
    skill: "review-plan", inputs: [`PLAN_PATH: ${harbor}/.cross-review/plans/shared-notebooks-plan.md\n\n## USER_REQUEST\nShared notebooks with per-member roles: owner, editor, viewer.\n`],
    rounds: [{ status: "completed", started: T0 - 31 * MIN, review: waitR1, acts: [
      sh("sed -n '1,260p' .cross-review/plans/shared-notebooks-plan.md", 1), sh("rg -n 'role|permission' src/api", 1), sh("nl -ba src/api/roles.ts", 1),
      sh("nl -ba src/api/notebooks.ts | sed -n '1,140p'", 1), think("Load-then-check leaks which notebook ids exist.", 7),
      sh("rg -n 'shared_links' migrations src", 1), sh("ls migrations | tail -12", 1), sh("nl -ba migrations/0031_shared_links.sql", 1),
      sh("rg -n 'editor' test", 1), sh("npm test -- api/notebooks 2>&1 | tail -12", 14), think("Existing links have no role column. The plan is silent on them.", 6),
    ] }],
  });

  const stalemate = issue(3, "Session cookie lacks SameSite=Strict", { cat: "security", sev: "medium", where: "src/auth/cookies.ts:22", problem: "The cookie is `SameSite=Lax`; a top-level POST from another site still carries it.", fix: "Use Strict." });
  writeSession(sessions(harbor), "review-impl-20261015-004", {
    skill: "review-impl", mode: "working-tree",
    inputs: [
      "## USER_REQUEST\nMove session tokens from localStorage to HttpOnly cookies.\n",
      "## FIXED_ITEMS\nISSUE-1: Token still read from localStorage on boot — fixed in src/auth/boot.ts:14\nISSUE-2: Logout does not clear the cookie — fixed in src/auth/logout.ts:9\n\n## DISPUTED_ITEMS\nISSUE-3: SameSite=Strict — the sign-in link in our emails opens the app from another site; Strict would sign every such user out (docs/decisions/0012-cookies.md).\n",
      "## FIXED_ITEMS\nNone\n\n## DISPUTED_ITEMS\nISSUE-3: SameSite=Strict — no new evidence; every state-changing route already checks the CSRF token (src/auth/csrf.ts:30).\n",
    ],
    state: { ended_at: T0 - 22 * HOUR, end_outcome: "finalized" }, meta: "REVISE",
    rounds: chain(T0 - 23 * HOUR, [
      { acts: reads(["src/auth/cookies.ts", "src/auth/boot.ts", "src/auth/logout.ts"], ["npm test -- auth"], [think("Boot still reads localStorage first.", 5)]), review: [issue(1, "Token still read from localStorage on boot", { sev: "high", where: "src/auth/boot.ts:14", problem: "Old tokens keep working after the move." }), issue(2, "Logout does not clear the cookie", { sev: "medium", where: "src/auth/logout.ts:9", problem: "Only the in-memory session is dropped." }), stalemate, verdict("REVISE", "Three issues.")].join("\n") },
      { acts: reads(["src/auth/boot.ts", "src/auth/logout.ts"], ["npm test -- auth"]), review: [stalemate, verdict("REVISE", "ISSUE-1 and ISSUE-2 hold; ISSUE-3 maintained.")].join("\n") },
      { acts: [sh("sed -n '1,80p' docs/decisions/0012-cookies.md", 1), sh("nl -ba src/auth/csrf.ts", 1)], review: [stalemate, verdict("REVISE", "Positions unchanged.")].join("\n"), convergence: { stalemate: true, reason: "Same 1 open issue(s) for 2 consecutive rounds, no new issues", unchanged_issue_ids: [3] } },
    ]),
  });

  writeSession(sessions(harbor), "review-impl-20261014-002", {
    skill: "review-impl", mode: "branch",
    inputs: ["BASE_BRANCH: 0b7d2a4\n\n## USER_REQUEST\nReview phase 2 of `export-formats-plan.md` (the export command).\n", "BASE_BRANCH: 0b7d2a4\n\n## FIXED_ITEMS\nISSUE-1: --out overwrites without --force — fixed in src/cli/export.ts:47; test test/cli.test.js:88\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n"],
    state: { ended_at: T0 - 2 * DAY + 3 * HOUR, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 2 * DAY + 2 * HOUR, [
      { acts: reads(["src/cli/export.ts", "src/export/rows.ts"], ["node --test test/cli.test.js", "npm test 2>&1 | tail -20"], [sh("d=$(mktemp -d) && touch \"$d/a.csv\" && node bin/harbor.js export --out \"$d/a.csv\"; echo $?", 3)]), review: [issue(1, "--out overwrites without --force", { sev: "high", where: "src/cli/export.ts:47", problem: "AC-2.3 forbids it; the file is opened with flag `w`." }), verdict("REVISE", "One defect.")].join("\n") },
      { acts: reads(["src/cli/export.ts"], ["node --test test/cli.test.js"]), review: verdict("APPROVE", "ISSUE-1 holds; AC-2.1 to AC-2.3 met.") },
    ]),
  });

  writeSession(sessions(harbor), "review-plan-20261012-002", {
    skill: "review-plan", inputs: [`PLAN_PATH: ${harbor}/.cross-review/plans/export-formats-plan.md\n\n## USER_REQUEST\nCSV and JSON export for every list, streaming above 50 000 rows.\n`, `PLAN_PATH: ${harbor}/.cross-review/plans/export-formats-plan.md\n\n## FIXED_ITEMS\nISSUE-1: No page size — fixed in the plan, Fixed decisions\nISSUE-2: Time zone of dates unstated — fixed, AC-1.3\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n`],
    state: { ended_at: T0 - 4 * DAY + HOUR, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 4 * DAY, [
      { acts: [sh("sed -n '1,240p' .cross-review/plans/export-formats-plan.md", 1), sh("rg -n 'limit|page' src/api/list.ts", 1), think("The list API pages by 1 000 already.", 5), sh("node -e \"console.log(require('./package.json').engines)\"", 1)], review: [issue(1, "No page size", { sev: "medium", where: "plan, Phase 3", problem: "Streaming without a page size is unbounded." }), issue(2, "Time zone of dates unstated", { sev: "low", where: "plan, Phase 1", problem: "CSV readers will guess." }), verdict("REVISE", "Two gaps.")].join("\n") },
      { acts: [sh("sed -n '1,240p' .cross-review/plans/export-formats-plan.md", 1)], review: verdict("APPROVE", "Both gaps closed.") },
    ]),
  });

  // orchard-api
  writeSession(sessions(orchard), "review-impl-20261016-001", {
    skill: "review-impl", mode: "working-tree", inputs: ["## USER_REQUEST\nPaginate the audit log export instead of loading it whole.\n"],
    state: { ended_at: T0 - 5 * HOUR - 20 * MIN, end_outcome: "stopped", caller: { name: "codex-mcp-client", title: "Codex", version: "0.46.0" } },
    rounds: [{ status: "failed", started: T0 - 5 * HOUR - 40 * MIN, error: "You've hit your usage limit. Try again at 13:05.", acts: reads(["src/audit/export.ts", "src/audit/query.ts"], ["npm test -- audit"]) }],
  });
  writeSession(sessions(orchard), "review-impl-20261015-003", {
    skill: "review-impl", mode: "working-tree", inputs: ["## USER_REQUEST\nFix the N+1 queries in the project listing.\n"],
    state: { ended_at: T0 - 26 * HOUR, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 26 * HOUR - 9 * MIN, [{ acts: reads(["src/projects/list.ts", "src/db/loaders.ts"], ["npm test -- projects", "npm run bench:list"], [think("One query per page now, plus one for owners.", 5)]), review: verdict("APPROVE", "Two queries per page instead of 51; the tests cover an empty page and a page of 50.") }]),
  });
  writeSession(sessions(orchard), "review-plan-20261013-001", {
    skill: "review-plan",
    inputs: [`PLAN_PATH: ${orchard}/.cross-review/plans/search-reindex-plan.md\n\n## USER_REQUEST\nRebuild the search index without downtime.\n`, `PLAN_PATH: ${orchard}/.cross-review/plans/search-reindex-plan.md\n\n## FIXED_ITEMS\nISSUE-1: Writes during the rebuild are lost — fixed: dual writes in Phase 2\n\n## DISPUTED_ITEMS\nISSUE-2: Alias swap is not atomic — it is: one \`_aliases\` call with remove and add (docs link in the plan)\n`, `PLAN_PATH: ${orchard}/.cross-review/plans/search-reindex-plan.md\n\n## FIXED_ITEMS\nISSUE-3: No rollback step — fixed: Phase 4 keeps the old index for 24 h\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n`],
    state: { ended_at: T0 - 3 * DAY, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 3 * DAY - 2 * HOUR, [
      { acts: [sh("sed -n '1,300p' .cross-review/plans/search-reindex-plan.md", 1), sh("rg -n 'index|alias' src/search", 1), sh("nl -ba src/search/indexer.ts | sed -n '1,120p'", 1), think("Writes between snapshot and swap go to the old index only.", 8)], review: [issue(1, "Writes during the rebuild are lost", { sev: "high", where: "plan, Phase 2", problem: "Documents changed during the rebuild never reach the new index." }), issue(2, "Alias swap is not atomic", { sev: "medium", where: "plan, Phase 3", problem: "Two calls leave a moment with no alias." }), verdict("REVISE", "Two issues.")].join("\n") },
      { acts: [sh("sed -n '1,300p' .cross-review/plans/search-reindex-plan.md", 1)], review: [issue(3, "No rollback step", { sev: "medium", where: "plan, Phase 4", problem: "The old index is deleted at once." }), verdict("REVISE", "ISSUE-1 fixed; ISSUE-2 withdrawn, one call is atomic; one new gap.")].join("\n") },
      { acts: [sh("sed -n '1,300p' .cross-review/plans/search-reindex-plan.md", 1)], review: verdict("APPROVE", "All three closed.") },
    ]),
  });

  // inkwell
  writeSession(sessions(inkwell), "review-pr-20261016-001", {
    skill: "review-pr", inputs: ["PR_TITLE: Render Markdown tables in the editor preview (#212)\nBASE_BRANCH: origin/main\nHEAD_REF: 7c1e0d9\n\n## PR_DESCRIPTION\nAdds GFM tables to the preview, with alignment.\n"],
    analysis: "### FINDING-1: Escaped pipes split cells\nA `\\|` inside a cell starts a new column.\n",
    state: { ended_at: T0 - 2 * HOUR, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 2 * HOUR - 14 * MIN, [{ acts: reads(["src/preview/tables.ts", "src/preview/render.ts"], ["npm test -- preview"], [sh("git log --oneline origin/main..7c1e0d9", 1)]), review: [issue(1, "Escaped pipes split cells", { sev: "medium", where: "src/preview/tables.ts:31", problem: "`\\|` inside a cell starts a new column." }), "### Overall Assessment\n- The description matches the change; ready once ISSUE-1 is fixed.\n", verdict("APPROVE", "One fix before merge; the rest is sound.")].join("\n") }]),
  });
  writeSession(sessions(inkwell), "review-think-20261015-001", {
    skill: "review-think",
    inputs: ["## QUESTION\nShould offline sync merge notes by paragraph or keep last-writer-wins per note?\n", "## AGREED_POINTS\n- Merge by paragraph.\n\n## DISAGREED_POINTS\n- None left.\n\n## NEW_PERSPECTIVES\n- Keep both versions when one paragraph changed on both sides.\n\n## CONTINUE_OR_CONSENSUS_OR_STALEMATE\nCONSENSUS\n"],
    analysis: "### FINDING-1: Last writer wins loses edits\nTwo devices editing one note offline lose one side.\n",
    state: { ended_at: T0 - 30 * HOUR, end_outcome: "finalized" }, meta: "CONSENSUS",
    rounds: chain(T0 - 31 * HOUR, [
      { acts: [sh("rg -n 'sync|merge' src/sync", 1), sh("nl -ba src/sync/apply.ts | sed -n '1,90p'", 1), think("Paragraph merge needs stable paragraph ids.", 6)], review: "### Position\nMerge by paragraph, with stable ids.\n\n### Key Insights\n- Notes are edited a paragraph at a time.\n\n### Suggested Status\nCONTINUE\n" },
      { acts: [sh("nl -ba src/sync/ids.ts", 1)], review: "### Position\nAgreed.\n\n### Key Insights\n- Keep both versions on a real conflict.\n\n### Suggested Status\nCONSENSUS\n" },
    ]),
  });
  writeSession(sessions(inkwell), "review-impl-20261013-002", {
    skill: "review-impl", mode: "working-tree", inputs: ["## USER_REQUEST\nSpell-check only the visible paragraphs while typing.\n", "## FIXED_ITEMS\nISSUE-1: Scrolling never re-checks — fixed in src/editor/spell.ts:58\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n"],
    state: { ended_at: T0 - 3 * DAY + 5 * HOUR, end_outcome: "finalized" }, meta: "APPROVE",
    rounds: chain(T0 - 3 * DAY + 4 * HOUR, [
      { acts: reads(["src/editor/spell.ts", "src/editor/viewport.ts"], ["npm test -- editor"]), review: [issue(1, "Scrolling never re-checks", { sev: "medium", where: "src/editor/spell.ts:58", problem: "Paragraphs scrolled into view keep no marks." }), verdict("REVISE", "One defect.")].join("\n") },
      { acts: reads(["src/editor/spell.ts"], ["npm test -- editor"]), review: verdict("APPROVE", "ISSUE-1 holds.") },
    ]),
  });

  // atlas-notes
  writeSession(sessions(atlas), "review-think-20261014-001", {
    skill: "review-think",
    inputs: ["## QUESTION\nWhich full-text search engine for 2 million notes on one small server: SQLite FTS5, Meilisearch or Postgres?\n"],
    analysis: "### FINDING-1: FTS5 is enough at this size\nOne file, no service to run.\n",
    state: { ended_at: T0 - 2 * DAY, end_outcome: "finalized" }, meta: "CONSENSUS",
    rounds: chain(T0 - 2 * DAY - HOUR, [{ acts: [sh("du -sh data/", 1), sh("sqlite3 data/notes.db 'select count(*) from notes'", 2), think("2.1 million rows, 3.4 GB. FTS5 handles that on one disk.", 7)], review: "### Position\nSQLite FTS5.\n\n### Key Insights\n- No new service to run or back up.\n\n### Suggested Status\nCONSENSUS\n" }]),
  });
}

// ---------- plans ----------

const PLAN_DIR = ws => path.join(ws, ".cross-review", "plans");

/** The export plan: phases 1 and 2 done, phase 3 under review; `ticked` of its last three criteria met. */
export function exportPlan({ ticked = 0 } = {}) {
  const box = n => (ticked >= n ? "x" : " ");
  const phase3Done = ticked >= 3;
  return `# CSV and JSON export

## Plan schema
loop-plan/v1

## Target
Users export any list (tasks, projects, tags) as CSV or JSON from the toolbar and from \`harbor export\`. Lists over 50 000 rows stream in pages instead of loading into memory. The default format is a setting.

## Scope
**In**
- Task, project and tag lists
- The toolbar's Export button and the \`harbor export\` command
- A default format setting

**Out**
- Excel files
- Scheduled exports

## Invariants
- CSV and JSON contain the same rows in the same order.
- An export never overwrites a file without \`--force\`.

## Fixed decisions
| Decision | Reason |
|---|---|
| Dates in UTC, ISO 8601 | Files move between time zones (user, 2026-10-12) |
| Pages of 1 000 rows | The list API already pages by 1 000 |
| No new dependency | The CSV rules fit in 60 lines; RFC 4180 is the reference |

## Baseline
- \`npm test\`: 412 passed in 38 s.
- \`npm run lint\` 9 s, \`npm run typecheck\` 14 s.

## Design and project patterns
- One row model (\`src/export/rows.ts\`) behind both writers, as \`src/import/\` does for imports.
- Streaming reuses the list API's pages (\`src/api/list.ts\`).

## Feasibility evidence
| Assumption | Spike or source | Result | Date |
|---|---|---|---|
| Streaming keeps memory flat | spike: 1 million rows | 96 MB peak | 2026-10-11 |
| Node streams honour backpressure on stdout | Node.js stream docs | yes, \`write()\` returns false | 2026-10-11 |

## Capacity
Pages of 1 000 rows protect memory: a page is at most 1.2 MB. A slow disk applies backpressure through \`drain\`; nothing is dropped.

## Global Gates
\`\`\`bash
npm test && npm run lint && npm run typecheck
\`\`\`

## Review checkpoints
- After Phase 1 (the row model is a contract) and Phase 3 (cancel and paging hold state), and a final one on the whole diff.

## Plan Review
APPROVE (review-plan review-plan-20261012-002, 2026-10-12)

## Phase 1: Export model and formats
### Goal
One row model behind both formats, so CSV and JSON can never disagree.

### Acceptance criteria
- [x] AC-1.1: CSV and JSON writers produce the same rows for every list type — proven by \`test/rows.test.js\`.
- [x] AC-1.2: Values with commas, quotes and line breaks round-trip through CSV — proven by \`test/csv.test.js\`.
- [x] AC-1.3: Dates are written as ISO 8601 in UTC — proven by \`test/dates.test.js\`.
- [x] AC-1.4: An empty list exports a header line only — proven by \`test/rows.test.js\`.

### Review
Checkpoint: \`/review-impl\`

### Commit
\`feat(export): one row model behind CSV and JSON\`

## Phase 2: The export command
### Goal
A scriptable \`harbor export\` on top of the model.

### Acceptance criteria
- [x] AC-2.1: \`export --format csv|json\` writes to stdout or to \`--out\` — proven by \`test/cli.test.js\`.
- [x] AC-2.2: An unknown format exits 2 with the list of formats — proven by \`test/cli.test.js\`.
- [x] AC-2.3: \`--out\` never overwrites a file without \`--force\` — proven by \`test/cli.test.js\`.

### Review
None (covered by the checkpoint after Phase 3)

### Commit
\`feat(export): the export command\`

## Phase 3: Streaming large exports
### Goal
Big lists export in pages without loading everything into memory, and a cancel leaves nothing behind.

### Acceptance criteria
- [x] AC-3.1: Lists over 50 000 rows stream in pages of 1 000 — proven by \`test/stream.test.js\`.
- [x] AC-3.2: Peak memory stays under 120 MB while exporting 1 million rows — proven by \`test/stream.test.js\`.
- [${box(1)}] AC-3.3: A cancelled export leaves no partial file behind — proven by \`test/stream.test.js\`.
- [${box(2)}] AC-3.4: The toolbar shows rows written so far — proven by \`test/toolbar.test.js\`.
- [${box(3)}] AC-3.5: No row is written twice or skipped across page boundaries — proven by \`test/pager.test.js\`.

### Review
Checkpoint: \`/review-impl\`

### Commit
\`feat(export): stream large exports in pages\`

## Phase 4: Default format setting
### Goal
Users pick the format once instead of on every export.

### Acceptance criteria
- [ ] AC-4.1: The setting accepts csv or json and rejects anything else — proven by \`test/settings.test.js\`.
- [ ] AC-4.2: The toolbar and the command use the setting when no format is given — proven by \`test/settings.test.js\`.
- [ ] AC-4.3: A user's value survives an app update — proven by \`test/settings.test.js\`.

### Review
None (covered by the final checkpoint)

### Commit
\`feat(export): default format setting\`

## Phase 5: Docs and release notes
### Goal
The user guide and the changelog describe the new export.

### Acceptance criteria
- [ ] AC-5.1: The user guide has an Export page with both formats and the setting — proven by inspection.
- [ ] AC-5.2: The changelog lists the command, the toolbar button and the setting — proven by inspection.

### Review
None (covered by the final checkpoint)

### Commit
\`docs(export): user guide and changelog\`

## Completion Criteria
- [ ] Every criterion is ticked and the global gates pass.
- [ ] End to end: \`harbor export --format csv --out tasks.csv\` on 1 000 000 tasks writes 1 000 001 lines.

## Progress Log
- 2026-10-12 Discovery: the list API already pages by 1 000; streaming reuses it.
- 2026-10-13 Phase 1 done: 4 of 4 criteria; checkpoint review-impl-20261013-004 approved in round 2.
- 2026-10-14 Decision: dates in UTC instead of local time (AC-1.3), approved by the user.
- 2026-10-14 Phase 2 done: 3 of 3 criteria; \`node --test test/cli.test.js\` 12 passed.
- 2026-10-15 Discovery: rows sharing an \`updated_at\` repeat across pages; the cursor becomes \`(updated_at, id)\` and AC-3.5 is added (user, 2026-10-15).
- 2026-10-16 Phase 3: AC-3.1 and AC-3.2 met (96 MB peak on 1 million rows); checkpoint review in progress.${phase3Done ? "\n- 2026-10-16 Phase 3 done: 5 of 5 criteria; checkpoint review-impl-20261016-007 approved in round 3 (7 issues: 6 fixed, 1 withdrawn)." : ""}
`;
}

/** A shorter plan with `done` of its phases complete. */
function smallPlan(title, target, phases, { review = "APPROVE (user, 2026-10-14)", done = 0, log = [] } = {}) {
  const head = `# ${title}\n\n## Plan schema\nloop-plan/v1\n\n## Target\n${target}\n\n## Scope\n- As the target says.\n\n## Invariants\n- Existing data keeps working.\n\n## Fixed decisions\nNone.\n\n## Baseline\n- \`npm test\` passes.\n\n## Design and project patterns\n- Follows the existing modules.\n\n## Feasibility evidence\nNone.\n\n## Capacity\nN/A\n\n## Global Gates\n\`npm test\`\n\n## Review checkpoints\n- Final only.\n\n## Plan Review\n${review}\n`;
  const body = phases.map(([name, goal, acs, commit], i) => `\n## Phase ${i + 1}: ${name}\n### Goal\n${goal}\n\n### Acceptance criteria\n${acs.map((a, j) => `- [${i < done ? "x" : " "}] AC-${i + 1}.${j + 1}: ${a}`).join("\n")}\n\n### Review\nNone (covered by the final checkpoint)\n\n### Commit\n\`${commit}\`\n`).join("");
  return `${head}${body}\n## Completion Criteria\n- [${done === phases.length ? "x" : " "}] Every criterion is ticked and the global gates pass.\n\n## Progress Log\n${log.map(l => `- ${l}`).join("\n")}\n`;
}

const PLANS = {
  sharedNotebooks: smallPlan("Shared notebooks", "Members of a notebook are owners, editors or viewers; links shared before keep working as viewer links.", [
    ["Roles in the API", "The three roles exist and are checked in one place.", ["The roles are owner, editor and viewer — proven by `test/api/roles.test.ts`.", "Membership is checked in the query; missing and forbidden both answer 404 — proven by `test/api/notebooks.test.ts`."], "feat(notebooks): owner, editor and viewer roles"],
    ["Sharing UI", "Owners invite members and change roles.", ["Only owners see the Members panel — proven by `test/ui/members.test.tsx`.", "An editor cannot change a role — proven by `test/api/notebooks.test.ts`."], "feat(notebooks): members panel"],
    ["Existing links", "Links shared before this change keep working.", ["Existing links get the viewer role by a rerun-safe migration — proven by `test/migrations/0032.test.ts`."], "feat(notebooks): migrate shared links to viewer"],
  ], { review: "pending" }),
  rateLimits: smallPlan("Per-token rate limits on search", "The public search API answers 429 with Retry-After once a token passes its limit; anonymous requests are limited by IP.", [
    ["Token bucket in Redis", "A bucket per token, refilled per second.", ["600 requests a minute per token pass, the 601st gets 429 — proven by `test/limits/bucket.test.ts`.", "Retry-After gives whole seconds — proven by `test/limits/bucket.test.ts`."], "feat(limits): token bucket in redis"],
    ["Search route", "The route uses the bucket.", ["Anonymous requests are limited by IP — proven by `test/routes/search.test.ts`.", "Limit headers on every answer — proven by `test/routes/search.test.ts`."], "feat(search): rate limit the public route"],
    ["Settings and docs", "Limits are configurable and documented.", ["Limits come from `config/default.yaml` — proven by `test/config.test.ts`.", "The API docs list the headers — proven by inspection."], "docs(search): rate limit headers"],
  ], { review: "pending" }),
  reindex: smallPlan("Search reindex without downtime", "The search index rebuilds while the API keeps answering; the old index stays for a day.", [
    ["Build the new index", "A second index fills from a snapshot.", ["The new index has every document of the snapshot — proven by `test/search/rebuild.test.ts`."], "feat(search): rebuild into a second index"],
    ["Dual writes", "Changes during the rebuild reach both indexes.", ["A document changed during the rebuild is current in the new index — proven by `test/search/dual-write.test.ts`."], "feat(search): write to both indexes while rebuilding"],
    ["Swap", "One alias call swaps the indexes.", ["The alias moves in one `_aliases` call — proven by `test/search/swap.test.ts`."], "feat(search): swap the alias atomically"],
    ["Rollback", "The old index stays 24 hours.", ["`orchard search rollback` restores the old index — proven by `test/search/rollback.test.ts`."], "feat(search): keep the old index for rollback"],
  ], { review: "APPROVE (review-plan review-plan-20261013-001, 2026-10-13)", done: 4, log: ["2026-10-14 Phase 1 done.", "2026-10-14 Phase 2 done.", "2026-10-15 Phase 3 done.", "2026-10-15 Phase 4 done; final review approved."] }),
  tables: smallPlan("Markdown tables in the editor", "The editor previews GFM tables with alignment, and Tab moves between cells.", [
    ["Preview", "Tables render in the preview.", ["Alignment rows set left, center and right — proven by `test/preview/tables.test.ts`.", "An escaped pipe stays in its cell — proven by `test/preview/tables.test.ts`."], "feat(preview): GFM tables"],
    ["Editing", "Tab and Shift+Tab move between cells.", ["Tab at the last cell adds a row — proven by `test/editor/table-keys.test.ts`.", "Columns re-pad on blur — proven by `test/editor/table-keys.test.ts`."], "feat(editor): table keys"],
    ["Paste", "Pasting cells from a spreadsheet makes a table.", ["Tab-separated text becomes a table — proven by `test/editor/paste.test.ts`."], "feat(editor): paste tables"],
  ], { done: 1, log: ["2026-10-16 Phase 1 done: 2 of 2 criteria; review-pr-20261016-001 approved."] }),
  tags: smallPlan("Tags with colours", "Notes carry tags from a fixed set of colours; a tag can be renamed everywhere at once.", [
    ["Tag model", "Tags and their colours.", ["Eight colours, chosen by name — proven by `test/tags/model.test.ts`."], "feat(tags): tag model"],
    ["Rename", "Renaming a tag renames it on every note.", ["One rename updates every note in one transaction — proven by `test/tags/rename.test.ts`."], "feat(tags): rename everywhere"],
  ], { review: "APPROVE (user, 2026-10-15)" }),
};
const NOTES = "# Search engine notes\n\nWhy SQLite FTS5 for 2 million notes, from the review-think session of 14 October.\n\n## Options\n\n| Option | Cost | Run |\n|---|---|---|\n| SQLite FTS5 | none | in process |\n| Meilisearch | a service, 2 GB RAM | separate |\n| Postgres tsvector | a migration | already running elsewhere |\n\n## Decision\n\nFTS5: one file to back up, queries under 40 ms on the full set.\n";

// ---------- git ----------

const GIT_ENV = { GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.invalid", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
function git(dir, args, when) {
  const date = when ? new Date(when * 1000).toISOString() : undefined;
  return execFileSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, encoding: "utf8" });
}
/** An invented history whose subjects include the plan's planned commit messages. */
function gitRepo(dir, subjects) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  write(path.join(dir, "README.md"), `# ${path.basename(dir)}\n\nAn invented project for the cross-review demo.\n`);
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "chore: start"], T0 - 30 * DAY);
  subjects.forEach(([subject, when]) => git(dir, ["commit", "-q", "--allow-empty", "-m", subject], when));
}
export function commit(dir, subject, when) {
  git(dir, ["commit", "-q", "--allow-empty", "-m", subject], when);
}

// ---------- the tree ----------

/**
 * Write every workspace under root (the dashboard's --root): sessions, plans, git history.
 * Returns the workspace paths and the ids the demo's tabs open.
 */
export function buildTree(root) {
  const ws = {
    harbor: path.join(root, "harbor-app"),
    orchard: path.join(root, "services", "orchard-api"),
    inkwell: path.join(root, "inkwell"),
    atlas: path.join(root, "atlas-notes"),
  };
  gitRepo(ws.harbor, [["feat(export): one row model behind CSV and JSON", T0 - 3 * DAY], ["fix(sync): retry a failed push once", T0 - 3 * DAY + HOUR], ["feat(export): the export command", T0 - 2 * DAY + 3 * HOUR]]);
  gitRepo(ws.orchard, [["feat(search): rebuild into a second index", T0 - 2 * DAY], ["feat(search): write to both indexes while rebuilding", T0 - 2 * DAY + HOUR], ["feat(search): swap the alias atomically", T0 - DAY - 2 * HOUR], ["feat(search): keep the old index for rollback", T0 - DAY]]);
  gitRepo(ws.inkwell, [["feat(preview): GFM tables", T0 - 2 * HOUR + 10 * MIN]]);
  gitRepo(ws.atlas, []);
  for (const dir of Object.values(ws)) write(path.join(dir, ".cross-review", ".gitignore"), "*\n");

  writePlan(ws.harbor, "export-formats-plan.md", exportPlan(), T0 - 52 * MIN);
  writePlan(ws.harbor, "shared-notebooks-plan.md", PLANS.sharedNotebooks, T0 - 34 * MIN);
  writePlan(ws.orchard, "search-rate-limits-plan.md", PLANS.rateLimits, T0 - 6 * MIN);
  writePlan(ws.orchard, "search-reindex-plan.md", PLANS.reindex, T0 - DAY);
  writePlan(ws.inkwell, "editor-tables-plan.md", PLANS.tables, T0 - 2 * HOUR + 10 * MIN);
  writePlan(ws.inkwell, "tag-colours-plan.md", PLANS.tags, T0 - 20 * HOUR);
  writePlan(ws.atlas, "search engine notes.md", NOTES, T0 - 2 * DAY);

  others(ws);
  return ws;
}

export function writePlan(dir, file, text, mtime) {
  write(path.join(PLAN_DIR(dir), file), text, mtime);
}

export { LIVE_ID, ORCH_ID };
