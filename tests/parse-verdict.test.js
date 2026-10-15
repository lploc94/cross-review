import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeVerdictStatus,
  parseOutputMarkdown,
  parseVerdict,
} from "../skill-packs/codex-review/scripts/lib/parse.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "skill-packs/codex-review/scripts/codex-runner.js");

const ISSUE_BLOCK = `### ISSUE-1: Missing guard
- Category: correctness
- Severity: high
- Plan section: Phase 2
- Problem: The guard is missing.
- Evidence: line 10
- Why it matters: crashes
- Suggested fix: add guard
`;

test("verdict-only APPROVE is a review with no blocks", () => {
  const r = parseOutputMarkdown("### VERDICT\n\n- Status: APPROVE\n- Reason: all fixed\n");
  assert.equal(r.format, "review");
  assert.deepEqual(r.blocks, []);
  assert.equal(r.verdict.status, "APPROVE");
  assert.equal(r.verdict.reason, "all fixed");
});

test("REVISE with ISSUE blocks keeps the block parser", () => {
  const r = parseOutputMarkdown(`${ISSUE_BLOCK}\n### VERDICT\n- Status: REVISE\n- Reason: one issue\n`);
  assert.equal(r.format, "review");
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].id, 1);
  assert.equal(r.blocks[0].severity, "high");
  assert.equal(r.verdict.status, "REVISE");
});

test("an ISSUE block ends at a ## VERDICT heading", () => {
  const md = "### ISSUE-1: x\n- Severity: high\n- Suggested fix: Add guard.\n\n## VERDICT\n- Status: REVISE\n";
  const r = parseOutputMarkdown(md);
  assert.equal(r.blocks[0].suggested_fix, "Add guard.");
  assert.equal(r.blocks[0].extra.status, undefined);
  assert.equal(r.verdict.status, "REVISE");
});

test("markdown headings inside fenced evidence stay in the ISSUE block", () => {
  const md = "### ISSUE-1: x\n- Severity: low\n- Evidence:\n```md\n## Not a boundary\n```\n- Suggested fix: f\n\n### VERDICT\n- Status: REVISE\n";
  const r = parseOutputMarkdown(md);
  assert.match(r.blocks[0].evidence, /## Not a boundary/);
  assert.equal(r.blocks[0].suggested_fix, "f");
});

test("## VERDICT heading is accepted, case-insensitive", () => {
  assert.equal(parseOutputMarkdown("## Verdict\n- Status: REVISE\n").verdict.status, "REVISE");
});

test("inline VERDICT: X line is accepted", () => {
  const r = parseOutputMarkdown("Everything checks out.\n\nVERDICT: APPROVE\n");
  assert.equal(r.format, "review");
  assert.equal(r.verdict.status, "APPROVE");
});

test("standalone bold **VERDICT** line is accepted", () => {
  assert.equal(parseOutputMarkdown("Summary.\n\n**VERDICT**\n- Status: APPROVE\n- Reason: ok\n").verdict.status, "APPROVE");
});

test("heading with words around Verdict and an inline status is accepted", () => {
  assert.equal(parseOutputMarkdown("## Final Plan Review Verdict: APPROVE\n\nLooks good.\n").verdict.status, "APPROVE");
});

test("bare status line under a verdict heading is accepted", () => {
  assert.equal(parseOutputMarkdown("## Final Verdict\n\n**APPROVE**\n\nReady.\n").verdict.status, "APPROVE");
});

test("bullets without a status under **Verdict** give no status", () => {
  assert.equal(parseOutputMarkdown("**Verdict**\n- The design is sound.\n").format, "unknown");
});

test("prose verdict without a known status has no status", () => {
  const r = parseOutputMarkdown("Verdict: request changes for visualization.\n");
  assert.equal(r.format, "unknown");
});

test("bold and backticked statuses are normalized", () => {
  assert.equal(parseVerdict("### VERDICT\n- Status: **APPROVE**\n").status, "APPROVE");
  assert.equal(parseVerdict("### VERDICT\n- Status: `APPROVE`.\n").status, "APPROVE");
  assert.equal(parseVerdict("### VERDICT\n- Status: stalemate\n").status, "STALEMATE");
});

test("normalizeVerdictStatus rejects unknown words", () => {
  assert.equal(normalizeVerdictStatus("LGTM"), null);
  assert.equal(normalizeVerdictStatus(""), null);
  assert.equal(normalizeVerdictStatus(null), null);
  assert.equal(normalizeVerdictStatus(" **Consensus** "), "CONSENSUS");
});

test("the last VERDICT block wins when the output quotes an earlier one", () => {
  const md = "The template says:\n### VERDICT\n- Status: REVISE\n\n### VERDICT\n- Status: APPROVE\n";
  assert.equal(parseOutputMarkdown(md).verdict.status, "APPROVE");
});

test("output without any verdict stays unknown", () => {
  const r = parseOutputMarkdown("Just some prose.\n");
  assert.equal(r.format, "unknown");
});

test("think-about output is unchanged", () => {
  const md = `### Key Insights
- one

### Considerations
- two

### Confidence Level
high

### Suggested Status (advisory)
CONSENSUS
`;
  const r = parseOutputMarkdown(md);
  assert.equal(r.format, "think-about");
  assert.deepEqual(r.insights, ["one"]);
  assert.equal(r.confidence, "high");
  assert.equal(r.suggested_status, "CONSENSUS");
});

function makeSession(rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ skill_name: "codex-plan-review", effort: "high" }));
  fs.writeFileSync(path.join(dir, "rounds.json"), JSON.stringify(rounds));
  return dir;
}

function finalize(dir, stdin = "") {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, [RUNNER, "finalize", dir], { input: stdin, encoding: "utf8" })) };
  } catch (e) {
    return { code: e.status, out: JSON.parse(e.stdout) };
  }
}

test("finalize uses the last round's verdict", () => {
  const dir = makeSession([
    { round: 1, status: "completed", verdict: "REVISE", elapsed_seconds: 5 },
    { round: 2, status: "completed", verdict: "APPROVE", elapsed_seconds: 3 },
  ]);
  const r = finalize(dir);
  assert.equal(r.code, 0);
  assert.equal(r.out.meta.verdict, "APPROVE");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalize fails instead of reusing an older verdict", () => {
  const dir = makeSession([
    { round: 1, status: "completed", verdict: "REVISE", elapsed_seconds: 5 },
    { round: 2, status: "completed", elapsed_seconds: 3 },
  ]);
  const r = finalize(dir);
  assert.notEqual(r.code, 0);
  assert.equal(r.out.code, "PRECONDITION_FAILED");
  assert.ok(!fs.existsSync(path.join(dir, "meta.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalize still accepts a verdict override on stdin", () => {
  const dir = makeSession([{ round: 1, status: "completed", elapsed_seconds: 5 }]);
  const r = finalize(dir, JSON.stringify({ verdict: "CONSENSUS" }));
  assert.equal(r.code, 0);
  assert.equal(r.out.meta.verdict, "CONSENSUS");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only review formats the pack still uses are detected", () => {
  const cweIssue = `${ISSUE_BLOCK}\n- Evidence: unescaped input (CWE-79)\n\n### VERDICT\n- Status: REVISE\n`;
  assert.equal(parseOutputMarkdown(cweIssue).format, "review", "a CWE mention does not switch to a security format");

  const responses = "### RESPONSE-1: Re: ISSUE-1\n- Action: accept\n- Reason: fixed\n\n### VERDICT\n- Status: CONSENSUS\n";
  const parsed = parseOutputMarkdown(responses);
  assert.equal(parsed.format, "response");
  assert.equal(parsed.blocks[0].prefix, "RESPONSE");
  assert.equal(parsed.blocks[0].action, "accept");

  const cross = "### CROSS-1: Shared cache\n- Severity: high\n\n### VERDICT\n- Status: REVISE\n";
  const crossParsed = parseOutputMarkdown(cross);
  assert.equal(crossParsed.blocks.length, 0, "CROSS blocks belonged to the removed codebase review");
  assert.equal(crossParsed.verdict.status, "REVISE");
});
