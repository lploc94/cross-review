#!/usr/bin/env node
// Synthetic review sessions for dashboard tests and demos. Every workspace name, request,
// review and command here is invented; nothing is copied from real sessions.
//
//   buildFixture(root, { now, livePid }) → { root, now, workspaces, sessions }
//   node tests/helpers/dashboard-fixture.js <dir>   (writes the same tree for a demo)
//
// Session files follow the runner's layout: state.json, rounds.json, final.txt,
// outputs/{final,review,output,times}-round-NNN.*, prompts/, inputs/, meta.json, analysis.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { parseOutputMarkdown } = await import(pathToFileURL(path.join(ROOT, "skill-packs/cross-review/scripts/lib/parse.js")).href);

const pad = n => String(n).padStart(3, "0");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = v => JSON.stringify(v, null, 2);

// ---------- invented activity ----------

let itemSeq = 0;
const cmd = (command, exit = 0, output = "") => ({ kind: "command", command: `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`, exit, output });
const think = text => ({ kind: "reasoning", text });
const note = text => ({ kind: "message", text });

const ACTIVITY = [
  cmd("sed -n '41,80p' scripts/lib/config.js"),
  cmd("cat tests/config.test.js"),
  cmd("rg -n 'mergeLevel' scripts tests"),
  cmd("node --test tests/config.test.js"),
  cmd("git diff a91c2e0...HEAD -- scripts/lib/config.js"),
  think("an effort-only workspace entry should keep the global model"),
  cmd("d=$(mktemp -d) && cd \"$d\" && node -e 'console.log(1)'"),
  note("Checking the merge order next."),
  cmd("nl -ba scripts/lib/config.js | sed -n '55,70p'"),
  cmd("npm test -- config", 1, "1 failing"),
];

function activity(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ACTIVITY[(i + offset) % ACTIVITY.length]);
}

/** Codex JSONL for one turn: commands start then complete, messages/reasoning only complete. */
function turnEvents(acts, { review = null, threadId = "thread-invented-1", completed = true, failed = null, openLast = false } = {}) {
  const lines = [{ type: "thread.started", thread_id: threadId }, { type: "turn.started" }];
  acts.forEach((a, i) => {
    const id = `item_${++itemSeq}`;
    if (a.kind === "command") {
      lines.push({ type: "item.started", item: { id, type: "command_execution", command: a.command, aggregated_output: "", exit_code: null, status: "in_progress" } });
      const last = openLast && i === acts.length - 1;
      if (!last) {
        lines.push({ type: "item.completed", item: { id, type: "command_execution", command: a.command, aggregated_output: a.output, exit_code: a.exit, status: a.exit === 0 ? "completed" : "failed" } });
      }
    } else if (a.kind === "reasoning") {
      lines.push({ type: "item.completed", item: { id, type: "reasoning", text: a.text } });
    } else {
      lines.push({ type: "item.completed", item: { id, type: "agent_message", text: a.text } });
    }
  });
  if (failed) lines.push({ type: "turn.failed", error: { message: failed } });
  if (review !== null) lines.push({ type: "item.completed", item: { id: `item_${++itemSeq}`, type: "agent_message", text: review } });
  if (completed && !failed) lines.push({ type: "turn.completed", usage: {} });
  return lines.map(l => JSON.stringify(l)).join("\n") + "\n";
}

/** One times row per line, two seconds apart from the round start. */
function timesFor(jsonl, startedAt) {
  const n = jsonl.split("\n").length - 1;
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(JSON.stringify([i, startedAt + 2 * i]));
  return rows.join("\n") + "\n";
}

// ---------- session writer ----------

/**
 * spec: { skill, mode, created, inputs: [md per round], analysis?, state: {...}, meta?,
 *   rounds: [{ status, started, elapsed, review?, acts?, error?, convergence?, openLast? }] }
 * The last round's result is the live final.txt; earlier rounds are archived under outputs/.
 */
export function writeSession(sessionsDir, id, spec) {
  const dir = path.join(sessionsDir, id);
  fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  const threadId = spec.threadId === undefined ? `thread-${id}` : spec.threadId;
  const roundsJson = [];
  spec.rounds.forEach((r, i) => {
    const round = i + 1;
    const last = i === spec.rounds.length - 1;
    const running = r.status === "running";
    const jsonl = turnEvents(r.acts || [], {
      review: running || r.status === "failed" || r.status === "stopped" ? null : (r.review ?? null),
      threadId: threadId || "",
      completed: !running && r.status !== "stopped",
      failed: r.status === "failed" ? r.error : null,
      openLast: r.openLast,
    });
    write(path.join(dir, "prompts", `round-${pad(round)}.txt`), `Invented prompt for round ${round}.\n`);
    const review = r.review ? parseOutputMarkdown(r.review, spec.skill) : null;
    const final = running || r.status === "stopped" ? null : {
      status: r.status,
      round,
      elapsed_seconds: r.elapsed,
      thread_id: threadId || null,
      review: r.status === "completed" ? review : null,
      activities: [],
      ...(r.status !== "completed" ? { error: r.error, failure_reason: r.status === "failed" ? "turn_failed" : r.status, recoverable: false } : {}),
      convergence: r.convergence || { stalemate: false },
    };
    if (last) {
      write(path.join(dir, "output.jsonl"), jsonl);
      if (final) write(path.join(dir, "final.txt"), JSON.stringify(final));
      if (r.review && !running) write(path.join(dir, "review.md"), r.review);
    } else {
      write(path.join(dir, "outputs", `output-round-${pad(round)}.jsonl`), jsonl);
      if (final) write(path.join(dir, "outputs", `final-round-${pad(round)}.json`), JSON.stringify(final));
      if (r.review) write(path.join(dir, "outputs", `review-round-${pad(round)}.md`), r.review);
    }
    write(path.join(dir, "outputs", `times-round-${pad(round)}.jsonl`), timesFor(jsonl, r.started));
    roundsJson.push({
      round,
      started_at: r.started,
      completed_at: running ? null : r.started + r.elapsed,
      elapsed_seconds: running ? null : r.elapsed,
      status: r.status,
      verdict: review?.verdict?.status || null,
      issues_found: review?.blocks ? review.blocks.length : null,
      issue_ids: (review?.blocks || []).map(b => b.id),
    });
  });
  (spec.inputs || []).forEach((text, i) => write(path.join(dir, "inputs", `round-${pad(i + 1)}.md`), text));
  if (spec.analysis) write(path.join(dir, "analysis.md"), spec.analysis);
  const lastRound = spec.rounds[spec.rounds.length - 1];
  write(path.join(dir, "state.json"), json({
    session_id: id,
    runner_version: 15,
    skill_name: spec.skill,
    reviewer: "codex",
    state_dir: dir,
    working_dir: path.dirname(path.dirname(path.dirname(sessionsDir))),
    round: spec.rounds.length,
    created_at: spec.created,
    pid: 999999,
    pgid: 999999,
    watchdog_pid: 999998,
    effort: "high",
    sandbox: "danger-full-access",
    timeout: 18000,
    started_at: lastRound.started,
    thread_id: threadId,
    mode: spec.mode || "default",
    model: null,
    ...spec.state,
  }));
  write(path.join(dir, "rounds.json"), json(roundsJson));
  if (spec.meta) {
    write(path.join(dir, "meta.json"), json({ skill: spec.skill, reviewer: "codex", runner_version: 15, rounds: spec.rounds.length, verdict: spec.meta, timing: {}, session_dir: dir }));
  }
  return dir;
}

// ---------- the invented story (the mock's) ----------

const ISSUE = {
  1: "### ISSUE-1: Workspace config read before the working dir is known\n- Category: correctness\n- Severity: high\n- Location: scripts/lib/config.js:41\n- Problem: `loadConfig()` runs at import time, before `begin` knows the working dir, so workspace values are never read.\n- Suggested fix: Load inside `beginSession` from the session's working dir.\n",
  2: "### ISSUE-2: Model list cached forever\n- Category: performance\n- Severity: medium\n- Location: scripts/lib/reviewers/codex.js:88\n- Problem: The catalog from `codex debug models` never expires, so new models never appear.\n- Suggested fix: Refetch on refresh and when older than a day.\n",
  3: "### ISSUE-3: Per-skill override ignored when the workspace sets only effort\n- Category: correctness\n- Severity: medium\n- Location: scripts/lib/config.js:63\n- Problem: A workspace `skills.review-impl` entry with only `effort` replaces the global per-skill `model` instead of merging.\n- Evidence: `mergeLevel()` assigns the whole object at config.js:63.\n",
};
const verdict = (status, reason) => `### VERDICT\n- Status: ${status}\n- Reason: ${reason}\n`;
const R1 = ISSUE[1] + "\n" + ISSUE[2] + "\n" + verdict("REVISE", "Two defects; otherwise the change follows the plan.");
const R2 = ISSUE[3] + "\n" + verdict("REVISE", "ISSUE-1 holds. ISSUE-2 withdrawn: the catalog is not persisted. The ISSUE-1 fix introduced one new defect.");
const R3 = verdict("APPROVE", "ISSUE-3 holds; nothing new. All tests pass.");
const IMPL_IN1 = "BASE_BRANCH: a91c2e0\n\n## USER_REQUEST\nReview phase 2 of `dashboard-plan.md` before moving on.\n\n## SESSION_CONTEXT\nInvented context.\n";
const IMPL_IN2 = "BASE_BRANCH: a91c2e0\n\n## FIXED_ITEMS\nISSUE-1: Workspace config read before the working dir is known — fixed in scripts/lib/config.js:41, loaded per session; test tests/config.test.js:22\n\n## DISPUTED_ITEMS\nISSUE-2: Model list cached forever — the list is fetched only when Settings opens or on refresh (dashboard/server.js:57); nothing keeps it between launches.\n";
const IMPL_IN3 = "BASE_BRANCH: a91c2e0\n\n## FIXED_ITEMS\nISSUE-3: Per-skill override ignored — fixed in scripts/lib/config.js:63, merged per key\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n";
const IMPL_IN3_DISPUTE = "BASE_BRANCH: a91c2e0\n\n## FIXED_ITEMS\nNone\n\n## DISPUTED_ITEMS\nISSUE-3: Per-skill override ignored — the plan's decision says a workspace per-skill entry replaces the global one (dashboard-plan.md:212).\n";

export const STORY_TITLE = "Review phase 2 of `dashboard-plan.md` before moving on.";

/**
 * Build the fixture tree under root. `now` (epoch seconds) anchors every time; `livePid`
 * is written as the pid of running sessions, so a live process makes them "running".
 */
export function buildFixture(root, { now = Math.floor(Date.now() / 1000), livePid = process.pid } = {}) {
  itemSeq = 0;
  const harbor = path.join(root, "harbor-app");
  const orchard = path.join(root, "services", "orchard-api");
  const inkwell = path.join(root, "inkwell");
  const sess = ws => path.join(ws, ".cross-review", "sessions");
  const s = {};
  const impl = { skill: "review-impl", mode: "branch" };
  const t0 = now - 3 * 3600;
  const done2 = [
    { status: "completed", started: t0, elapsed: 412, review: R1, acts: activity(12) },
    { status: "completed", started: t0 + 900, elapsed: 188, review: R2, acts: activity(9, 3) },
  ];

  s.approved = writeSession(sess(harbor), "review-impl-20261015-001", {
    ...impl, created: t0, inputs: [IMPL_IN1, IMPL_IN2, IMPL_IN3], meta: "APPROVE",
    state: { ended_at: t0 + 1600, end_outcome: "finalized", caller: { name: "claude-code", title: "Claude Code", version: "2.0.0" } },
    rounds: [...done2, { status: "completed", started: t0 + 1400, elapsed: 74, review: R3, acts: activity(5, 6) }],
  });
  s.running = writeSession(sess(harbor), "review-impl-20261015-002", {
    ...impl, created: now - 1500, inputs: [IMPL_IN1, IMPL_IN2, IMPL_IN3],
    state: { pid: livePid, pgid: livePid, caller: { name: "claude-code", title: "Claude Code", version: "2.0.0" }, model: null, effort: "xhigh", settings_sources: { effort: "workspace:review-impl" } },
    rounds: [
      { status: "completed", started: now - 1500, elapsed: 412, review: R1, acts: activity(12) },
      { status: "completed", started: now - 1000, elapsed: 188, review: R2, acts: activity(9, 3) },
      { status: "running", started: now - 120, elapsed: 0, acts: activity(45, 1), openLast: true },
    ],
  });
  s.waiting = writeSession(sess(harbor), "review-impl-20261015-003", {
    ...impl, created: now - 1400, inputs: [IMPL_IN1, IMPL_IN2],
    state: { caller: { name: "codex-mcp-client", title: "Codex", version: "0.1.0" } },
    rounds: [
      { status: "completed", started: now - 1400, elapsed: 412, review: R1, acts: activity(12) },
      { status: "completed", started: now - 400, elapsed: 220, review: R2, acts: activity(9, 3) },
    ],
  });
  s.stopped = writeSession(sess(harbor), "review-impl-20261015-004", {
    ...impl, created: now - 2400, inputs: [IMPL_IN1, IMPL_IN2, IMPL_IN3],
    state: { ended_at: now - 1100, end_outcome: "stopped" },
    rounds: [
      ...done2.map((r, i) => ({ ...r, started: now - 2400 + i * 600 })),
      { status: "failed", started: now - 1300, elapsed: 112, error: "You've hit your usage limit. Try again at 15:40.", acts: activity(7, 2) },
    ],
  });
  s.stalemate = writeSession(sess(harbor), "review-impl-20261015-005", {
    ...impl, created: t0, inputs: [IMPL_IN1, IMPL_IN2, IMPL_IN3_DISPUTE, IMPL_IN3_DISPUTE], meta: "REVISE",
    state: { ended_at: t0 + 2600, end_outcome: "finalized" },
    rounds: [
      ...done2,
      { status: "completed", started: t0 + 1500, elapsed: 240, review: ISSUE[3] + "\n" + verdict("REVISE", "ISSUE-3 maintained: replacing silently drops the global model."), acts: activity(4) },
      { status: "completed", started: t0 + 2200, elapsed: 95, review: ISSUE[3] + "\n" + verdict("REVISE", "No new evidence on either side; positions unchanged."), acts: activity(3), convergence: { stalemate: true, reason: "Same 1 open issue(s) for 2 consecutive rounds, no new issues", unchanged_issue_ids: [3] } },
    ],
  });
  s.warn = writeSession(sess(orchard), "review-plan-20261015-001", {
    skill: "review-plan", created: now - 1700, inputs: ["PLAN_PATH: /work/orchard-api/search-index-plan.md\n\n## USER_REQUEST\nCheck the search index plan.\n"],
    rounds: [{ status: "completed", started: now - 1700, elapsed: 440, review: ISSUE[2] + "\n" + verdict("REVISE", "One gap."), acts: activity(6) }],
  });
  s.noReply = writeSession(sess(orchard), "review-plan-20261014-001", {
    skill: "review-plan", created: now - 90000, inputs: ["PLAN_PATH: /work/orchard-api/cache-plan.md\n"],
    rounds: [{ status: "completed", started: now - 90000, elapsed: 300, review: ISSUE[2] + "\n" + verdict("REVISE", "One gap."), acts: activity(3) }],
  });
  s.stoppedOld = writeSession(sess(orchard), "review-plan-20261013-001", {
    skill: "review-plan", created: now - 200000, inputs: ["PLAN_PATH: /work/orchard-api/queue-plan.md\n"],
    rounds: [{ status: "timeout", started: now - 200000, elapsed: 18000, error: "Timeout after 18000s", acts: activity(3) }],
  });
  s.endedOpen = writeSession(sess(orchard), "review-impl-20261013-001", {
    skill: "review-impl", mode: "working-tree", created: now - 7200, inputs: ["## USER_REQUEST\nRetry failed uploads with backoff. The second line is not part of the title.\n"],
    state: { ended_at: now - 6000, end_outcome: "stopped" },
    rounds: [{ status: "completed", started: now - 7200, elapsed: 300, review: ISSUE[1] + "\n" + verdict("REVISE", "One defect."), acts: activity(3) }],
  });
  s.deadPid = writeSession(sess(orchard), "review-impl-20261015-009", {
    skill: "review-impl", mode: "working-tree", created: now - 600, inputs: ["## USER_REQUEST\nCache the settings file.\n"],
    rounds: [{ status: "running", started: now - 600, elapsed: 0, acts: activity(4) }],
  });
  // The reviewer finished, but nobody polled: output.jsonl has the completed turn, no final.txt
  fs.appendFileSync(path.join(s.deadPid, "output.jsonl"), [
    { type: "item.completed", item: { id: "late_review", type: "agent_message", text: verdict("APPROVE", "Looks right.") } },
    { type: "turn.completed", usage: {} },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  s.think = writeSession(sess(inkwell), "review-think-20261015-001", {
    skill: "review-think", created: now - 5000, meta: "CONSENSUS",
    inputs: [
      "## QUESTION\nShould tags be user-defined?\n",
      "## AGREED_POINTS\n- Fixed tags first.\n\n## DISAGREED_POINTS\n- None left.\n\n## NEW_PERSPECTIVES\n- Import from the old tool.\n\n## CONTINUE_OR_CONSENSUS_OR_STALEMATE\nCONSENSUS\n",
    ],
    analysis: "### FINDING-1: Fixed tags first\nUser-defined tags can come later.\n",
    state: { ended_at: now - 3000, end_outcome: "finalized" },
    rounds: [
      { status: "completed", started: now - 5000, elapsed: 300, review: "### Position\nStart with a fixed set.\n\n### Key Insights\n- Fewer migrations.\n\n### Suggested Status\nCONTINUE\n", acts: activity(4) },
      { status: "completed", started: now - 4000, elapsed: 200, review: "### Position\nAgreed.\n\n### Key Insights\n- The import path settles it.\n\n### Suggested Status\nCONSENSUS\n", acts: activity(2) },
    ],
  });
  s.pr = writeSession(sess(inkwell), "review-pr-20261015-001", {
    skill: "review-pr", created: now - 900, inputs: ["PR_TITLE: Add CSV export\nBASE_BRANCH: origin/main\nHEAD_REF: 0d1e2f3\n\n## PR_DESCRIPTION\nAdds an export button.\n"],
    rounds: [{ status: "completed", started: now - 900, elapsed: 280, review: ISSUE[2] + "\n### Overall Assessment\n- Fine.\n\n" + verdict("CONTINUE", "One finding."), acts: activity(5) }],
  });
  s.missingInput = writeSession(sess(inkwell), "review-plan-20261012-001", {
    skill: "review-plan", created: now - 400000, meta: "APPROVE", state: { ended_at: now - 399000, end_outcome: "finalized" },
    rounds: [{ status: "completed", started: now - 400000, elapsed: 60, review: verdict("APPROVE", "Fine."), acts: activity(2) }],
  });
  return { root, now, workspaces: { harbor, orchard, inkwell }, sessions: s };
}

// ---------- invented plans ----------

const PLAN_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const EXPORT_PLAN = fs.readFileSync(path.join(PLAN_FIXTURES, "export-formats-plan.md"), "utf8");
export const SYNC_PLAN = fs.readFileSync(path.join(PLAN_FIXTURES, "sync-offline-plan.md"), "utf8");
const retitle = (text, title) => text.replace(/^# .*$/m, `# ${title}`);
const approve = text => text.replace(/^pending$/m, "APPROVE (user, 2026-10-14)");
export const PLANS = {
  progress: EXPORT_PLAN,
  draft: SYNC_PLAN,
  pending: retitle(SYNC_PLAN, "Tag colours"),
  ready: retitle(approve(SYNC_PLAN), "Shared notebooks"),
  done: retitle(approve(SYNC_PLAN).replace(/- \[ \] AC-/g, "- [x] AC-"), "Search by date"),
  doc: "# Notes on the sync protocol\n\nWhy last writer wins loses edits.\n\n## Options\n\n| Option | Cost |\n|---|---|\n| Merge by paragraph | A diff per save |\n",
};

export function writePlan(ws, file, text) {
  const dir = path.join(ws, ".cross-review", "plans");
  fs.mkdirSync(dir, { recursive: true });
  const file_ = path.join(dir, file);
  fs.writeFileSync(file_, text);
  return file_;
}

/**
 * Invented plans in five states across three workspaces of `fx` (buildFixture's result), plus
 * `atlas-notes`, a workspace with plans and no sessions. Returns { atlas, files }.
 */
export function buildPlans(fx) {
  const { harbor, orchard, inkwell } = fx.workspaces;
  const atlas = path.join(fx.root, "atlas-notes");
  const files = {
    progress: writePlan(harbor, "export-formats-plan.md", PLANS.progress),
    draft: writePlan(harbor, "sync-offline-plan.md", PLANS.draft),
    doc: writePlan(harbor, "sync notes.md", PLANS.doc),
    ready: writePlan(orchard, "shared-notebooks-plan.md", PLANS.ready),
    done: writePlan(inkwell, "search-by-date-plan.md", PLANS.done),
    pending: writePlan(atlas, "kế-hoạch.md", PLANS.pending),
  };
  return { atlas, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: node tests/helpers/dashboard-fixture.js <dir>\n");
    process.exit(1);
  }
  const out = buildFixture(path.resolve(dir));
  process.stdout.write(`Invented sessions written under ${out.root}\n`);
}
