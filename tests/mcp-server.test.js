import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeFakeCodex } from "./helpers/fake-codex.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "skill-packs/codex-review");
const SERVER = path.join(PACK, "scripts/mcp-server.js");

// The SDK is a dependency of the skill pack, not of the repo root: resolve it from there.
const packRequire = createRequire(path.join(PACK, "package.json"));
let Client;
let StdioClientTransport;
try {
  ({ Client } = await import(pathToFileURL(packRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href));
  ({ StdioClientTransport } = await import(pathToFileURL(packRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href));
} catch (e) {
  throw new Error(`MCP SDK not installed for the skill pack. Run: npm ci --prefix skill-packs/codex-review (${e.message})`);
}

let tmp;
let workDir;
let env;
let outputPath;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-test-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  writeFakeCodex(bin);
  workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir);
  outputPath = path.join(tmp, "codex-output.md");
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_CODEX_LOG: path.join(tmp, "codex-log.jsonl"),
    FAKE_CODEX_OUTPUT: outputPath,
  };
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...env, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), body: JSON.parse(res.content[0].text) };
}

const PLAN_INPUT = "---\nPLAN_PATH: /tmp/plan.md\n---\n## USER_REQUEST\nReview the plan\n";

test("lists the four review tools", async () => {
  const { client } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["review_begin", "review_end", "review_reply", "review_wait"]);
  } finally {
    await client.close();
  }
});

test("review_begin → review_wait → review_end over stdio", async () => {
  fs.writeFileSync(outputPath, "### VERDICT\n- Status: APPROVE\n- Reason: ok\n");
  const { client } = await connect();
  try {
    const begun = await call(client, "review_begin", { skill: "codex-plan-review", input: PLAN_INPUT, working_dir: workDir });
    assert.equal(begun.isError, false);
    assert.equal(begun.body.status, "running");
    const waited = await call(client, "review_wait", { session_dir: begun.body.session_dir, max_wait_seconds: 30 });
    assert.equal(waited.body.status, "completed");
    assert.equal(waited.body.next, "done");
    const ended = await call(client, "review_end", { session_dir: begun.body.session_dir });
    assert.equal(ended.body.finalized, true);
    assert.equal(ended.body.verdict, "APPROVE");
  } finally {
    await client.close();
  }
});

test("tool errors come back as isError results and the server keeps serving", async () => {
  const { client } = await connect();
  try {
    const bad = await call(client, "review_wait", { session_dir: path.join(tmp, "missing-session") });
    assert.equal(bad.isError, true);
    assert.equal(bad.body.code, "INVALID_SESSION");
    const badMode = await call(client, "review_begin", { skill: "codex-impl-review", input: "", working_dir: workDir });
    assert.equal(badMode.isError, true);
    assert.equal(badMode.body.code, "INVALID_INPUT");
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
  } finally {
    await client.close();
  }
});

test("review_end reports a failed finalize as isError and still stops the session", async () => {
  fs.writeFileSync(outputPath, "### VERDICT\n- Status: APPROVE\n");
  const { client } = await connect();
  try {
    const begun = await call(client, "review_begin", { skill: "codex-plan-review", input: PLAN_INPUT, working_dir: workDir });
    await call(client, "review_wait", { session_dir: begun.body.session_dir, max_wait_seconds: 30 });
    // A non-empty directory where meta.json goes makes finalize fail
    fs.mkdirSync(path.join(begun.body.session_dir, "meta.json", "blocker"), { recursive: true });
    const ended = await call(client, "review_end", { session_dir: begun.body.session_dir });
    assert.equal(ended.isError, true);
    assert.equal(ended.body.finalized, false);
    assert.ok(ended.body.error);
    const rounds = JSON.parse(fs.readFileSync(path.join(begun.body.session_dir, "rounds.json"), "utf8"));
    assert.notEqual(rounds.at(-1).status, "running");
  } finally {
    await client.close();
  }
});

test("a review survives the server being killed; a new server continues it", async () => {
  fs.writeFileSync(outputPath, "### VERDICT\n- Status: APPROVE\n");
  const first = await connect({ FAKE_CODEX_SLOW_MS: "3000" });
  const begun = await call(first.client, "review_begin", { skill: "codex-plan-review", input: PLAN_INPUT, working_dir: workDir });
  const pid = first.transport.pid;
  assert.ok(pid, "server pid is known");
  process.kill(pid, "SIGKILL");
  await first.transport.close().catch(() => {});

  const second = await connect();
  try {
    const waited = await call(second.client, "review_wait", { session_dir: begun.body.session_dir, max_wait_seconds: 30 });
    assert.equal(waited.body.status, "completed");
    assert.equal(waited.body.next, "done");
    await call(second.client, "review_end", { session_dir: begun.body.session_dir });
  } finally {
    await second.client.close();
  }
});

test("review_wait default comes from REVIEW_WAIT_DEFAULT_S", async () => {
  const { client } = await connect({ REVIEW_WAIT_DEFAULT_S: "7" });
  try {
    const { tools } = await client.listTools();
    const wait = tools.find(t => t.name === "review_wait");
    assert.match(wait.description, /default 7\)/);
  } finally {
    await client.close();
  }
});
