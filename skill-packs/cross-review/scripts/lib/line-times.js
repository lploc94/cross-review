// Wall-clock times for the reviewer's event log. Codex's JSONL has no timestamps, so the
// runner appends `[completeLineCount, epochSeconds]` rows to outputs/times-round-NNN.jsonl
// whenever the count of complete lines in output.jsonl grows. A line is stamped with the
// time of the first row whose count exceeds its index (accurate to about a second).
//
// Writers: the watchdog (every second), and poll/stop/resume/deadline once before they kill
// the watchdog or reopen output.jsonl. Rows are short single appends, so concurrent writers
// cannot interleave; readers ignore rows whose count does not increase.

import fs from "node:fs";
import path from "node:path";

export function timesFile(stateDir, round) {
  return path.join(stateDir, "outputs", `times-round-${String(round).padStart(3, "0")}.jsonl`);
}

/** Rows with strictly increasing counts; malformed or non-increasing rows are skipped. */
export function parseLineTimes(text) {
  const rows = [];
  let last = 0;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(row) || !Number.isInteger(row[0]) || typeof row[1] !== "number") continue;
    if (row[0] <= last) continue;
    rows.push([row[0], row[1]]);
    last = row[0];
  }
  return rows;
}

export function readLineTimes(stateDir, round) {
  try {
    return parseLineTimes(fs.readFileSync(timesFile(stateDir, round), "utf8"));
  } catch {
    return [];
  }
}

function lastStamped(file) {
  try {
    const rows = parseLineTimes(fs.readFileSync(file, "utf8"));
    return rows.length ? rows[rows.length - 1][0] : 0;
  } catch {
    return 0;
  }
}

function countNewlines(buf, n) {
  let count = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 10) count++;
  return count;
}

/**
 * Count complete lines of output.jsonl. With a cursor `{offset, lines}` only the bytes
 * after `offset` are read and the cursor advances; without one the whole file is counted.
 */
function countCompleteLines(jsonlFile, cursor) {
  let offset = (cursor && cursor.offset) || 0;
  let lines = (cursor && cursor.lines) || 0;
  const fd = fs.openSync(jsonlFile, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      lines += countNewlines(buf, n);
      offset += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (cursor) {
    cursor.offset = offset;
    cursor.lines = lines;
  }
  return lines;
}

/**
 * Append a row when output.jsonl has more complete lines than the times file already covers.
 * Never throws: a failure here must not break the watchdog, poll, stop or resume.
 * Returns the number of complete lines now stamped (or null on error).
 */
export function flushLineTimes(stateDir, round, cursor = null, now = () => Date.now()) {
  try {
    if (!stateDir || !Number.isInteger(round) || round < 1) return null;
    const file = timesFile(stateDir, round);
    const jsonlFile = path.join(stateDir, "output.jsonl");
    if (!fs.existsSync(jsonlFile)) return null;
    const lines = countCompleteLines(jsonlFile, cursor);
    if (cursor && cursor.stamped === undefined) cursor.stamped = lastStamped(file);
    const stamped = cursor ? cursor.stamped : lastStamped(file);
    if (lines <= stamped) return stamped;
    fs.appendFileSync(file, `${JSON.stringify([lines, Math.floor(now() / 1000)])}\n`);
    if (cursor) cursor.stamped = lines;
    return lines;
  } catch {
    return null;
  }
}
