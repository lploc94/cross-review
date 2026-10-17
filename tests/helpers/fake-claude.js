// Fake `claude` executable for tests: logs its args, stdin prompt and CROSS_REVIEW_REVIEWER to
// FAKE_CLAUDE_LOG, then prints a stream-json turn whose result is the content of FAKE_CLAUDE_OUTPUT.
// The session id is "session-fake-1"; FAKE_CLAUDE_ERROR ends the turn with is_error (subtype "success").
import { writeFakeCli } from "./fake-cli.js";

export function writeFakeClaude(binDir) {
  writeFakeCli(binDir, "claude", `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
try { prompt = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), prompt, reviewerEnv: process.env.CROSS_REVIEW_REVIEWER ?? null }) + "\\n");
const sid = "session-fake-1";
const text = fs.readFileSync(process.env.FAKE_CLAUDE_OUTPUT, "utf8");
const out = [
  { type: "system", subtype: "init", session_id: sid },
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git diff" } }] }, session_id: sid },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] }, session_id: sid },
];
if (process.env.FAKE_CLAUDE_ERROR) {
  out.push({ type: "result", subtype: "success", is_error: true, result: process.env.FAKE_CLAUDE_ERROR, session_id: sid });
} else {
  out.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text }] }, session_id: sid });
  out.push({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid });
}
process.stdout.write(out.map(e => JSON.stringify(e)).join("\\n") + "\\n");
process.exit(process.env.FAKE_CLAUDE_ERROR ? 1 : 0);
`);
}
