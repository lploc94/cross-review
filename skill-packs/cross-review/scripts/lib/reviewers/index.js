// Reviewer registry. A reviewer module exports: name, label, installHint, sandboxes,
// defaultSandbox, fullAccessSandbox, isAvailable(), buildCommand(), parseEvents(),
// matchesCmdline(). See codex.js.

import * as codex from "./codex.js";

const REVIEWERS = { codex };

export const DEFAULT_REVIEWER = "codex";
export const REVIEWER_NAMES = Object.keys(REVIEWERS);

/** The reviewer module for name (default codex); throws UNKNOWN_REVIEWER otherwise. */
export function getReviewer(name) {
  const key = name || DEFAULT_REVIEWER;
  const reviewer = Object.hasOwn(REVIEWERS, key) ? REVIEWERS[key] : undefined;
  if (!reviewer) {
    const err = new Error(`Unknown reviewer "${key}". Available: ${REVIEWER_NAMES.join(", ")}`);
    err.code = "UNKNOWN_REVIEWER";
    throw err;
  }
  return reviewer;
}
