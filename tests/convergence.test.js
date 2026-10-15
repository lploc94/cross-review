// Stalemate detection shared by the runner's poll and the dashboard (lib/convergence.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convergence, issueIds } from "../skill-packs/cross-review/scripts/lib/convergence.js";
import { writeSession } from "./helpers/dashboard-fixture.js";
import { classify, readSession } from "../skill-packs/cross-review/scripts/lib/dashboard/model.js";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skill-packs/cross-review/scripts/review-runner.js");

test("convergence: same open issues twice is a stalemate; new or resolved ones are not; no ids, no answer", () => {
  assert.deepEqual(convergence([1, 2], [1, 2]), { stalemate: true, reason: "Same 2 open issue(s) for 2 consecutive rounds, no new issues", unchanged_issue_ids: [1, 2] });
  assert.deepEqual(convergence([1, 2], [2, 3]), { stalemate: false, new_issues: [3], resolved_issues: [1] });
  assert.deepEqual(convergence([1], []), { stalemate: false, new_issues: [], resolved_issues: [1] });
  assert.deepEqual(convergence([], []), { stalemate: false, reason: "no_issue_blocks_tracked" });
  assert.equal(convergence(undefined, [1]), null);
  assert.equal(convergence([1], null), null);
  assert.deepEqual(issueIds({ blocks: [{ prefix: "ISSUE", id: 3 }, { prefix: "FINDING", id: 9 }, { prefix: "ISSUE", id: 1 }] }), [1, 3]);
  assert.equal(issueIds({}), null);
});

test("runner poll and the dashboard agree on a round that repeats the open issues", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "convergence-")));
  const now = Math.floor(Date.now() / 1000);
  try {
    const review = "### ISSUE-1: Invented unresolved issue\n- Severity: medium\n- Problem: Invented problem.\n\n### VERDICT\n- Status: REVISE\n- Reason: Still open.\n";
    const dir = writeSession(path.join(tmp, ".cross-review", "sessions"), "review-impl-20261015-091", {
      skill: "review-impl", created: now - 100, state: { working_dir: tmp, pid: 0, pgid: 0, watchdog_pid: 0 },
      inputs: ["## USER_REQUEST\nInvented task.\n", "## DISPUTED_ITEMS\nISSUE-1: Disputed.\n"],
      rounds: [{ status: "completed", started: now - 100, elapsed: 10, review }, { status: "running", started: now - 40, elapsed: 0, acts: [] }],
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
    const r = spawnSync(process.execPath, [RUNNER, "poll", dir], { encoding: "utf8", env: { ...process.env, HOME: tmp, CODEX_HOME: path.join(tmp, ".codex") } });
    const final = JSON.parse(fs.readFileSync(path.join(dir, "final.txt"), "utf8"));
    assert.equal(final.convergence?.stalemate, true, r.stdout + r.stderr);
    assert.deepEqual(final.convergence.unchanged_issue_ids, [1]);
    assert.equal(before, "history/stalemate");
    assert.equal(state(), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
