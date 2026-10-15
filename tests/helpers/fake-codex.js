// Fake `codex` executable for tests: logs its args and stdin prompt to FAKE_CODEX_LOG,
// then prints a JSONL turn whose agent message is the content of FAKE_CODEX_OUTPUT.
// FAKE_CODEX_SLOW_MS keeps it running (after some progress events) for that long.
// FAKE_CODEX_FAIL fails the turn after the thread started, with that message (e.g. a usage limit).
import fs from "node:fs";
import path from "node:path";

export function writeFakeCodex(binDir) {
  const fake = path.join(binDir, "codex");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
try { prompt = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");
const text = fs.readFileSync(process.env.FAKE_CODEX_OUTPUT, "utf8");
if (process.env.FAKE_CODEX_FAIL) {
  const failed = [
    { type: "thread.started", thread_id: "thread-fake-1" },
    { type: "turn.started" },
    { type: "turn.failed", error: { message: process.env.FAKE_CODEX_FAIL } },
  ];
  process.stdout.write(failed.map(e => JSON.stringify(e)).join("\\n") + "\\n");
  process.exit(1);
}
const slowMs = parseInt(process.env.FAKE_CODEX_SLOW_MS || "0", 10);
if (slowMs > 0) {
  fs.writeSync(1, JSON.stringify({ type: "thread.started", thread_id: "thread-fake-1" }) + "\\n");
  fs.writeSync(1, JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "reading source.js" } }) + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowMs);
}
const out = [
  { type: "thread.started", thread_id: "thread-fake-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text } },
  { type: "turn.completed" },
];
process.stdout.write(out.map(e => JSON.stringify(e)).join("\\n") + "\\n");
`, { mode: 0o755 });
}
