// Stalemate detection between two consecutive rounds: the same open ISSUE ids twice and no
// new ones. Used by the runner's poll and by the dashboard for rounds nobody polled yet.

/** Sorted ISSUE ids of a parsed review, or null when it has no blocks. */
export function issueIds(review) {
  if (!review || !review.blocks) return null;
  return review.blocks.filter(b => b.prefix === "ISSUE").map(b => b.id).sort((a, b) => a - b);
}

/** The `convergence` object for a completed round, or null when either round has no ids. */
export function convergence(prevIds, currIds) {
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
  if (sameSet && newIssues.length === 0) {
    return {
      stalemate: true,
      reason: `Same ${currIds.length} open issue(s) for 2 consecutive rounds, no new issues`,
      unchanged_issue_ids: currIds,
    };
  }
  return { stalemate: false, new_issues: newIssues, resolved_issues: resolvedIssues };
}
