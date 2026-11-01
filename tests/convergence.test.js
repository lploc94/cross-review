// Stalemate detection shared by the runner's poll and the dashboard (lib/convergence.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convergence, disputedIds, issueIds } from "../skill-packs/cross-review/scripts/lib/convergence.js";
import { writeSession } from "./helpers/dashboard-fixture.js";
import { classify, readSession } from "../skill-packs/cross-review/scripts/lib/dashboard/model.js";
import { computeNext } from "../skill-packs/cross-review/scripts/lib/review-core.js";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skill-packs/cross-review/scripts/review-runner.js");

test("convergence: the same issues twice after a reply that disputed all of them is a stalemate", () => {
  assert.deepEqual(convergence([1, 2], [1, 2], { disputed: [1, 2] }), { stalemate: true, reason: "Same 2 disputed issue(s) for 2 consecutive rounds, no new issues", unchanged_issue_ids: [1, 2] });
  assert.equal(convergence([1, 2], [1, 2], { disputed: [1, 2, 5] }).stalemate, true);
  // The shapes of the 7 flagged sessions in the sample: none was a stalemate
  // a partial fix reopened (agent listed it under FIXED_ITEMS, disputed nothing)
  assert.deepEqual(convergence([4], [4], { disputed: [] }), { stalemate: false, reason: "reopened_after_fix", unchanged_issue_ids: [4], new_issues: [], resolved_issues: [] });
  // one fixed, one disputed: the fixed one is progress
  assert.equal(convergence([1, 2], [1, 2], { disputed: [2] }).stalemate, false);
  // an APPROVE that lists the closed issues again
  assert.equal(convergence([1, 2], [1, 2], { disputed: [1, 2], approved: true }).reason, "approved");
  // no reply on record (low-level `resume`): never a stalemate
  assert.equal(convergence([1], [1]).reason, "no_reply_recorded");
});

test("disputedIds: DISPUTED_ITEMS or DISAGREED_POINTS ids, less the ones also fixed; null without a reply", () => {
  assert.deepEqual(disputedIds({ FIXED_ITEMS: "ISSUE-4: order golden lacks seeds — fixed", DISPUTED_ITEMS: "None — all issues addressed" }), []);
  assert.deepEqual(disputedIds({ FIXED_ITEMS: "No issues fixed this round", DISPUTED_ITEMS: "ISSUE-2: x — reason\n- ISSUE-1: y, unlike ISSUE-7" }), [1, 2]);
  assert.deepEqual(disputedIds({ FIXED_ITEMS: "ISSUE-1: part fixed", DISPUTED_ITEMS: "ISSUE-1: rest disputed\nISSUE-3: no" }), [3]);
  assert.deepEqual(disputedIds({ AGREED_POINTS: "- ISSUE-1 (a): CONFIRMED", DISAGREED_POINTS: "- ISSUE-2 severity: medium, not high" }), [2]);
  // an id mentioned inside a line is not an entry (the "None" line is a stored reply's)
  assert.deepEqual(disputedIds({ DISPUTED_ITEMS: "None — all issues addressed (ISSUE-3 closed in round 2)." }), []);
  assert.deepEqual(disputedIds({ DISPUTED_ITEMS: "Additional defect found after ISSUE-1 (invented): none disputed" }), []);
  assert.deepEqual(disputedIds({ DISPUTED_ITEMS: "* **ISSUE-4**: bold\n1. ISSUE-5: numbered\n`ISSUE-6`: code\n  + ISSUE-8 indented" }), [4, 5, 6, 8]);
  assert.deepEqual(disputedIds({}), []);
  assert.equal(disputedIds(null), null);
});

test("convergence: new or resolved issues are not a stalemate; no ids, no answer", () => {
  assert.deepEqual(convergence([1, 2], [2, 3]), { stalemate: false, new_issues: [3], resolved_issues: [1] });
  assert.deepEqual(convergence([1], []), { stalemate: false, new_issues: [], resolved_issues: [1] });
  assert.deepEqual(convergence([], []), { stalemate: false, reason: "no_issue_blocks_tracked" });
  assert.equal(convergence(undefined, [1]), null);
  assert.equal(convergence([1], null), null);
  assert.deepEqual(issueIds({ blocks: [{ prefix: "ISSUE", id: 3 }, { prefix: "FINDING", id: 9 }, { prefix: "ISSUE", id: 1 }] }), [1, 3]);
  assert.equal(issueIds({}), null);
});

/** A review-impl session whose round 2 repeats round 1's ISSUE-1 after `reply`; polls it with the runner. */
function pollRepeatedRound(reply, verdict = "REVISE") {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "convergence-")));
  const now = Math.floor(Date.now() / 1000);
  const review = `### ISSUE-1: Invented unresolved issue\n- Severity: medium\n- Problem: Invented problem.\n\n### VERDICT\n- Status: ${verdict}\n- Reason: Invented reason.\n`;
  const dir = writeSession(path.join(tmp, ".cross-review", "sessions"), "review-impl-20261015-091", {
    skill: "review-impl", created: now - 100, state: { working_dir: tmp, pid: 0, pgid: 0, watchdog_pid: 0 },
    inputs: ["## USER_REQUEST\nInvented task.\n", reply],
    rounds: [{ status: "completed", started: now - 100, elapsed: 10, review: review.replace(verdict, "REVISE") }, { status: "running", started: now - 40, elapsed: 0, acts: [] }],
  });
  fs.appendFileSync(path.join(dir, "output.jsonl"), [
    { type: "item.completed", item: { id: "final-review", type: "agent_message", text: review } },
    { type: "turn.completed" },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const state = () => {
    const { summary } = classify(readSession(dir), { now, isAlive: () => false });
    return `${summary.group}/${summary.state}`;
  };
  const before = state();
  const r = spawnSync(process.execPath, [RUNNER, "poll", dir], { encoding: "utf8", env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CODEX_HOME: path.join(tmp, ".codex") } });
  const final = JSON.parse(fs.readFileSync(path.join(dir, "final.txt"), "utf8"));
  return { tmp, dir, now, before, after: state(), final, out: r.stdout + r.stderr };
}

test("runner poll and the dashboard agree: the same issue after a reply that disputed it is a stalemate", () => {
  const x = pollRepeatedRound("## FIXED_ITEMS\nNo issues fixed this round\n\n## DISPUTED_ITEMS\nISSUE-1: Disputed.\n");
  try {
    assert.equal(x.final.convergence?.stalemate, true, x.out);
    assert.deepEqual(x.final.convergence.unchanged_issue_ids, [1]);
    assert.equal(computeNext(x.final, { skill_name: "review-impl" }).next_reason, "stalemate");
    assert.equal(x.before, "history/stalemate");
    assert.equal(x.after, x.before);
  } finally {
    fs.rmSync(x.tmp, { recursive: true, force: true });
  }
});

test("runner poll and the dashboard agree: an issue reopened after the agent fixed it is still the agent's turn", () => {
  const x = pollRepeatedRound("## FIXED_ITEMS\nISSUE-1: Invented fix — fixed in a.js:1\n\n## DISPUTED_ITEMS\nNone — all issues addressed\n");
  try {
    assert.equal(x.final.convergence?.stalemate, false, x.out);
    assert.equal(x.final.convergence.reason, "reopened_after_fix");
    assert.equal(computeNext(x.final, { skill_name: "review-impl" }).next, "respond");
    assert.equal(x.before, "active/waiting");
    assert.equal(x.after, x.before);
    // A final.txt an older runner flagged is read by the rule of today
    fs.writeFileSync(path.join(x.dir, "final.txt"), JSON.stringify({ ...x.final, convergence: { stalemate: true, unchanged_issue_ids: [1] } }));
    const { summary, detail } = classify(readSession(x.dir), { now: x.now, isAlive: () => false });
    assert.equal(summary.state, "waiting");
    assert.ok(!detail.steps.some(s => s.text === "stalemate"), JSON.stringify(detail.steps));
    assert.ok(!detail.ledger.some(i => i.trail.includes("stalemate")), JSON.stringify(detail.ledger));
  } finally {
    fs.rmSync(x.tmp, { recursive: true, force: true });
  }
});

test("runner poll and the dashboard agree: an APPROVE that lists the closed issue again is approved", () => {
  const x = pollRepeatedRound("## DISPUTED_ITEMS\nISSUE-1: Disputed.\n", "APPROVE");
  try {
    assert.equal(x.final.convergence?.stalemate, false, x.out);
    assert.equal(computeNext(x.final, { skill_name: "review-impl" }).next_reason, "approved");
    assert.equal(x.after, "history/approve");
  } finally {
    fs.rmSync(x.tmp, { recursive: true, force: true });
  }
});
