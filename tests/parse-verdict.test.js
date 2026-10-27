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
} from "../skill-packs/cross-review/scripts/lib/parse.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "skill-packs/cross-review/scripts/review-runner.js");

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
  assert.equal(r.position, null);
});

test("PR review issues expose Blocking; withdrawn notes do not leak into the last block", () => {
  const md = `### ISSUE-1: Token never refreshed
- Category: bug
- Severity: high
- Blocking: yes
- File: src/auth.js:40-52
- Problem: p
- Evidence: e
- Why it matters: w
- Suggested fix: f

### Withdrawn or Rejected
- ISSUE-2: covered by the retry in src/http.js:12

### Overall Assessment
- Delivers what it claims: partly
- Merge recommendation: request changes
- Summary: s

### VERDICT
- Status: CONTINUE
- Reason: r
`;
  const r = parseOutputMarkdown(md);
  assert.equal(r.format, "commit-pr-review");
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].blocking, "yes");
  assert.equal(r.blocks[0].suggested_fix, "f");
  assert.equal(r.verdict.status, "CONTINUE");
});

test("think-about output exposes the Position section", () => {
  const md = `### Position
- Use SQLite here; switch to Postgres once writers exceed one process.

### Key Insights
- one — Source: src/db.js:12
`;
  const r = parseOutputMarkdown(md);
  assert.equal(r.format, "think-about");
  assert.equal(r.position, "Use SQLite here; switch to Postgres once writers exceed one process.");
  assert.deepEqual(r.insights, ["one — Source: src/db.js:12"]);
});

function makeSession(rounds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ skill_name: "review-plan", effort: "high" }));
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

test("verdict markers and blocks inside code fences are ignored", () => {
  const quotedInVerdict = `${ISSUE_BLOCK}\n### VERDICT\n- Status: REVISE\n- Reason: once fixed, the output should read\n\`\`\`\n### VERDICT\n- Status: APPROVE\n\`\`\`\n`;
  assert.equal(parseVerdict(quotedInVerdict).status, "REVISE");
  assert.equal(parseOutputMarkdown(quotedInVerdict).verdict.status, "REVISE");

  const quotedBefore = "```\nVERDICT: APPROVE\n```\n\n### VERDICT\n- Status: REVISE\n";
  assert.equal(parseVerdict(quotedBefore).status, "REVISE");

  const fencedOnly = "Example output:\n```\n### VERDICT\n- Status: APPROVE\n```\n";
  assert.equal(parseVerdict(fencedOnly), null, "a verdict that only appears in a fence is no verdict");

  const fencedIssue = `${ISSUE_BLOCK}\n- Evidence: the template reads\n\`\`\`\n### ISSUE-9: Example\n\`\`\`\n\n### VERDICT\n- Status: REVISE\n`;
  assert.deepEqual(parseOutputMarkdown(fencedIssue).blocks.map(b => b.id), [1], "a quoted ISSUE heading is not a block");
});

test("an answer wrapped entirely in one fence is parsed as its content", () => {
  const wrapped = "```markdown\n### Key Insights\n- a\n\n### Considerations\n- b\n```\n";
  assert.equal(parseOutputMarkdown(wrapped).format, "think-about");
  const wrappedReview = `\`\`\`markdown\n${ISSUE_BLOCK}\n### VERDICT\n- Status: REVISE\n\`\`\``;
  assert.equal(parseOutputMarkdown(wrappedReview).verdict.status, "REVISE");
  assert.equal(parseVerdict(wrappedReview).status, "REVISE");
});

test("fences close only with a matching fence of at least the opening length", () => {
  const evidence = "- Evidence:\n```js\nconst x = 1;\n```\n";
  const four = `\`\`\`\`markdown\n${ISSUE_BLOCK}\n${evidence}\n### VERDICT\n- Status: REVISE\n\`\`\`\`\n`;
  const parsed = parseOutputMarkdown(four);
  assert.equal(parsed.format, "review");
  assert.equal(parsed.verdict.status, "REVISE");
  assert.deepEqual(parsed.blocks.map(b => b.id), [1]);
  assert.equal(parseOutputMarkdown("````\n### VERDICT\n- Status: APPROVE\n````").verdict.status, "APPROVE");

  // Inside a four-backtick example, a triple-backtick line does not end the example
  const example = `${ISSUE_BLOCK}\n### VERDICT\n- Status: REVISE\n- Reason: expected shape\n\`\`\`\`\n\`\`\`\n### VERDICT\n- Status: APPROVE\n\`\`\`\`\n`;
  assert.equal(parseVerdict(example).status, "REVISE");
});

const LEDGER = `### Decision Ledger
| Decision point | Source | Counter-examples tried (miss side / block side) | Result |
|---|---|---|---|
| \`src/a.js:3\` | samples/app.log | ### x / VERDICT: APPROVE | a\\|b | grounded |
`;

test("a Decision Ledger between issues and the verdict changes neither issues nor verdict", () => {
  const plain = parseOutputMarkdown(`${ISSUE_BLOCK}\n\n### VERDICT\n- Status: REVISE\n- Reason: r\n`);
  const withLedger = parseOutputMarkdown(`${ISSUE_BLOCK}\n\n${LEDGER}\n### VERDICT\n- Status: REVISE\n- Reason: r\n`);
  assert.equal(withLedger.blocks.length, plain.blocks.length);
  assert.deepEqual(withLedger.blocks[0].problem, plain.blocks[0].problem);
  assert.equal(withLedger.blocks[0].suggested_fix, plain.blocks[0].suggested_fix);
  assert.equal(withLedger.verdict.status, "REVISE");
});

test("APPROVE with a ledger only, and a PR ledger before the overall assessment", () => {
  const approve = parseOutputMarkdown(`${LEDGER}\n### VERDICT\n- Status: APPROVE\n- Reason: ok\n`);
  assert.equal(approve.blocks.length, 0);
  assert.equal(approve.verdict.status, "APPROVE");
  const pr = parseOutputMarkdown(`${ISSUE_BLOCK}\n\n${LEDGER}\n### Overall Assessment\n- Delivers what it claims: partly\n- Merge recommendation: request changes\n- Summary: s\n\n### VERDICT\n- Status: CONTINUE\n- Reason: r\n`);
  assert.equal(pr.blocks.length, 1);
  assert.equal(pr.verdict.status, "CONTINUE");
  const none = parseOutputMarkdown(`### Decision Ledger\nNone in this change\n\n### VERDICT\n- Status: APPROVE\n- Reason: ok\n`);
  assert.equal(none.verdict.status, "APPROVE");
});

test("a ledger heading inside a fenced evidence block is not a section", () => {
  const fencedEvidence = ISSUE_BLOCK.replace("- Evidence: line 10", "- Evidence:\n```\n### Decision Ledger\n| x |\n```\nstill evidence");
  const r = parseOutputMarkdown(`${fencedEvidence}\n\n### VERDICT\n- Status: REVISE\n- Reason: r\n`);
  assert.equal(r.blocks.length, 1);
  assert.match(r.blocks[0].evidence, /Decision Ledger/);
  assert.equal(r.blocks[0].suggested_fix, "add guard");
});
