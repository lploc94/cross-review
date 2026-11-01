// Stalemate detection between two consecutive rounds: the same open ISSUE ids twice, no new
// ones, and the agent's reply in between disputed every one of them instead of fixing it.
// A reviewer that reopens an issue the agent says it fixed (a partial fix) is still making
// progress, and an APPROVE that lists closed issues again is not a stalemate either.
// Used by the runner's poll and by the dashboard.

/** Sorted ISSUE ids of a parsed review, or null when it has no blocks. */
export function issueIds(review) {
  if (!review || !review.blocks) return null;
  return review.blocks.filter(b => b.prefix === "ISSUE").map(b => b.id).sort((a, b) => a - b);
}

/**
 * A reply line that is an issue entry: it starts with `ISSUE-N`, after an optional list
 * marker (`-`, `*`, `+`, `1.`) and `**`, `` ` `` or `[`. An id elsewhere in the line is a
 * mention, not an entry ("None — all issues addressed (ISSUE-3 closed in round 2)").
 * Returns { id, rest } or null. In the stored replies, 852 of the 854 FIXED_ITEMS /
 * DISPUTED_ITEMS / DISAGREED_POINTS lines naming an issue start this way; the other two are
 * that "None" line and a sentence that mentions an issue.
 */
export function issueEntry(line) {
  const m = String(line).match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|`|\[)?ISSUE-(\d+)\b[*`\]]*\s*:?\s*(.*)$/);
  return m ? { id: Number(m[1]), rest: m[2].trim() } : null;
}

function lineIds(text) {
  const out = new Set();
  for (const line of String(text || "").split("\n")) {
    const e = issueEntry(line);
    if (e) out.add(e.id);
  }
  return out;
}

/**
 * Sorted ISSUE ids the agent's reply disputed (DISPUTED_ITEMS, or DISAGREED_POINTS for the
 * peer skills) and did not also list as fixed; null when there is no reply to read.
 */
export function disputedIds(values) {
  if (!values) return null;
  const fixed = lineIds(values.FIXED_ITEMS);
  const disputed = new Set([...lineIds(values.DISPUTED_ITEMS), ...lineIds(values.DISAGREED_POINTS)]);
  return [...disputed].filter(id => !fixed.has(id)).sort((a, b) => a - b);
}

/**
 * The `convergence` object for a completed round, or null when either round has no ids.
 * `disputed`: disputedIds() of the reply that started this round (null: unknown, never a
 * stalemate); `approved`: the round's verdict is APPROVE.
 */
export function convergence(prevIds, currIds, { disputed = null, approved = false } = {}) {
  if (!prevIds || !currIds) return null;
  // No ISSUE blocks on either side (think format, RESPONSE-only rounds): nothing to compare
  if (currIds.length === 0 && prevIds.length === 0) {
    return { stalemate: false, reason: "no_issue_blocks_tracked" };
  }
  const prevSet = new Set(prevIds);
  const currSet = new Set(currIds);
  const newIssues = currIds.filter(id => !prevSet.has(id));
  const resolvedIssues = prevIds.filter(id => !currSet.has(id));
  const sameSet = prevIds.length === currIds.length && prevIds.every(id => currSet.has(id));
  if (!sameSet || newIssues.length > 0) return { stalemate: false, new_issues: newIssues, resolved_issues: resolvedIssues };
  const disputedSet = new Set(disputed || []);
  const notDisputed = currIds.filter(id => !disputedSet.has(id));
  if (approved || !disputed || notDisputed.length > 0) {
    const reason = approved ? "approved" : !disputed ? "no_reply_recorded" : "reopened_after_fix";
    return { stalemate: false, reason, unchanged_issue_ids: currIds, new_issues: [], resolved_issues: [] };
  }
  return {
    stalemate: true,
    reason: `Same ${currIds.length} disputed issue(s) for 2 consecutive rounds, no new issues`,
    unchanged_issue_ids: currIds,
  };
}
