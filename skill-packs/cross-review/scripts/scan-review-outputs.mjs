#!/usr/bin/env node
// Local regression check for the output parser: finds every review.md under a root
// directory, parses it, and prints counts by format and verdict status.
// Prints counts only (and, with --list, paths of suspect files) — never review content.
//
// Usage: node scan-review-outputs.mjs <root> [--list]

import fs from "node:fs";
import path from "node:path";
import { parseOutputMarkdown } from "./lib/parse.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function* findReviewFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* findReviewFiles(full);
    } else if (entry.isFile() && entry.name === "review.md") {
      yield full;
    }
  }
}

const args = process.argv.slice(2);
const root = args.find(a => !a.startsWith("--"));
const list = args.includes("--list");
if (!root) {
  process.stderr.write("Usage: node scan-review-outputs.mjs <root> [--list]\n");
  process.exit(1);
}

const byFormat = {};
const byStatus = {};
const suspects = [];
let total = 0;

for (const file of findReviewFiles(path.resolve(root))) {
  const md = fs.readFileSync(file, "utf8");
  const parsed = parseOutputMarkdown(md);
  total++;
  byFormat[parsed.format] = (byFormat[parsed.format] || 0) + 1;
  const status = parsed.verdict?.status || parsed.suggested_status || "none";
  byStatus[status] = (byStatus[status] || 0) + 1;
  // Suspect: the text mentions a verdict, yet no status was extracted
  if (/VERDICT/i.test(md) && (parsed.format === "unknown" || status === "none")) {
    suspects.push(file);
  }
}

console.log(JSON.stringify({ total, by_format: byFormat, by_status: byStatus, verdict_text_without_status: suspects.length }, null, 2));
if (list) for (const file of suspects) console.log(file);
