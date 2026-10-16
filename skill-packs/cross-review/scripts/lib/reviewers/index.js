// Reviewer registry. A reviewer module exports: name, label, installHint, sandboxes,
// defaultSandbox, fullAccessSandbox, isAvailable(), buildCommand(), parseEvents(),
// activityItems() and newLogState()/foldLog()/logItems()/logOutcome() (the dashboard's
// activity feed, read incrementally), matchesCmdline(). See codex.js.
// Optional: encodePrompt(text) (what goes on stdin when the CLI does not read plain text),
// efforts (the fixed effort levels, or null when they depend on the model) and
// checkSelection({model, effort}) → {ok: true} | {ok: false, message} (run before begin and
// reply launch anything; a failure is INVALID_SELECTION).

import * as agy from "./agy.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";

const REVIEWERS = { codex, claude, agy };

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
