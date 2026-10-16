// Fake `agy` executable for tests. `agy models` prints an invented catalog (FAKE_AGY_MODELS_FAIL
// makes it fail). A turn reads NDJSON from stdin like the real CLI: a line without "event" fails
// with the CLI's message. It logs {args, stdin, prompt, reviewerEnv} to FAKE_AGY_LOG, then prints a
// stream-json turn whose response is the content of FAKE_AGY_OUTPUT; the conversation id is
// "conv-fake-1". FAKE_AGY_ERROR ends the turn with status ERROR.
import fs from "node:fs";
import path from "node:path";

export const FAKE_AGY_MODELS = [
  "gemini-x-flash-high\tGemini X Flash (High)",
  "gemini-x-flash-medium\tGemini X Flash (Medium)",
  "gemini-x-flash-low\tGemini X Flash (Low)",
  "claude-y\tClaude Y (Thinking)",
  "oss-z-medium\tOSS Z (Medium)",
].join("\n") + "\n";

export function writeFakeAgy(binDir) {
  const fake = path.join(binDir, "agy");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stderr.write("Fetching available models...\\n");
  if (process.env.FAKE_AGY_MODELS_FAIL) { process.stderr.write("error: not signed in\\n"); process.exit(1); }
  process.stdout.write(${JSON.stringify(FAKE_AGY_MODELS)});
  process.exit(0);
}
if (args[0] === "--version") { process.stdout.write("9.9.9\\n"); process.exit(0); }
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const log = rec => process.env.FAKE_AGY_LOG && fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(rec) + "\\n");
let prompt = null;
for (const line of stdin.split("\\n").filter(l => l.trim())) {
  let d;
  try { d = JSON.parse(line); } catch { d = null; }
  if (!d || !d.event) {
    log({ args, stdin, prompt: null, reviewerEnv: process.env.CROSS_REVIEW_REVIEWER ?? null });
    process.stderr.write('error: stream input message is missing the "event" field\\n');
    process.exit(1);
  }
  if (d.event === "user") prompt = d.message.content;
}
log({ args, stdin, prompt, reviewerEnv: process.env.CROSS_REVIEW_REVIEWER ?? null });
const c = "conv-fake-1";
const out = [{ event: "init", conversation_id: c, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } }];
const step = (i, state, step_type, extra) => out.push({ event: "step_update", step_update: { conversation_id: c, step_index: i, state, step_type, ...extra } });
step(0, "DONE", "user_input", {});
step(1, "ACTIVE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git diff" } } });
step(1, "DONE", "tool", { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git diff" }, output: "" } });
if (process.env.FAKE_AGY_ERROR) {
  out.push({ event: "result", result: { conversation_id: c, status: "ERROR", response: "", error: process.env.FAKE_AGY_ERROR } });
} else {
  const text = fs.readFileSync(process.env.FAKE_AGY_OUTPUT, "utf8");
  step(2, "DONE", "agent_response", { text_delta: text });
  out.push({ event: "result", result: { conversation_id: c, status: "SUCCESS", response: text } });
}
process.stdout.write(out.map(e => JSON.stringify(e)).join("\\n") + "\\n");
process.exit(process.env.FAKE_AGY_ERROR ? 1 : 0);
`, { mode: 0o755 });
}
