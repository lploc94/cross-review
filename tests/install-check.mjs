#!/usr/bin/env node
// Verify an installation made with HOME=<home>: node tests/install-check.mjs <home>
// Reads the installed files and starts the installed MCP server; it does not trust installer output.
// CODEX_HOME defaults to <home>/.codex, as in the installer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(home)) {
  console.error("usage: node tests/install-check.mjs <home>");
  process.exit(2);
}
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");

const RUNNER_SKILLS = ["codex-plan-review", "codex-impl-review", "codex-think-about", "codex-commit-review", "codex-pr-review"];
const PLAIN_SKILLS = ["loop-plan", "loop-implement"];
const SKILLS = [...RUNNER_SKILLS, ...PLAIN_SKILLS];
const REMOVED_SKILLS = ["codex-parallel-review", "codex-codebase-review", "codex-security-review"];
const TOOLS = ["review_begin", "review_end", "review_reply", "review_wait"];

const claudeRoot = path.join(home, ".claude", "skills");
const agentsRoot = path.join(home, ".agents", "skills");
const legacyRoot = path.join(codexHome, "skills");
const runtime = path.join(claudeRoot, "codex-review");
const runner = path.join(runtime, "scripts", "codex-runner.js");
const mcpServer = path.join(runtime, "scripts", "mcp-server.js");

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function onPath(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
}

// Skills in both roots: present, fully rendered, no flavor text or protocol files
for (const [root, client] of [[claudeRoot, "claude"], [agentsRoot, "codex"]]) {
  for (const skill of SKILLS) {
    const file = path.join(root, skill, "SKILL.md");
    if (!fs.existsSync(file)) { failures.push(`${client}: missing ${file}`); continue; }
    const text = fs.readFileSync(file, "utf8");
    // Both clients discover a skill by its front matter: name must match the directory
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    check(fm && new RegExp(`^name: ${skill}$`, "m").test(fm[1]) && /^description: \S/m.test(fm[1]), `${client}: ${skill} front matter lacks name/description`);
    check(!text.includes("{{"), `${client}: ${skill} has an unrendered placeholder`);
    if (RUNNER_SKILLS.includes(skill)) check(text.includes(`node "${runner}"`), `${client}: ${skill} does not point at the installed runner`);
  }
  for (const skill of [...SKILLS, "codex-review"]) {
    for (const f of walk(path.join(root, skill))) {
      check(!/^(protocol|flavor-text)\.md$/.test(path.basename(f)), `${client}: stale file ${f}`);
      if (f.endsWith(".md")) check(!/flavor/i.test(fs.readFileSync(f, "utf8")), `${client}: flavor text in ${f}`);
    }
  }
  for (const skill of REMOVED_SKILLS) check(!fs.existsSync(path.join(root, skill)), `${client}: removed skill ${skill} still installed`);
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    check(!/^\.codex-staging-|^\..+-backup-/.test(name), `${client}: leftover ${path.join(root, name)}`);
  }
}

// Codex copies of the loop skills speak Codex
for (const skill of PLAIN_SKILLS) {
  const file = path.join(agentsRoot, skill, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  check(!text.includes("CLAUDE.md"), `codex: ${skill} mentions CLAUDE.md`);
  check(!/(^|[\s`(])\/(loop|codex)-/.test(text), `codex: ${skill} uses slash commands`);
  check(text.includes("$codex-") || text.includes("$loop-"), `codex: ${skill} lacks $skill references`);
  check(fs.existsSync(path.join(agentsRoot, skill, "agents", "openai.yaml")), `codex: ${skill} lacks agents/openai.yaml`);
}

// This pack's copies are gone from Codex's deprecated skills root
for (const name of ["codex-review", ...SKILLS, ...REMOVED_SKILLS]) {
  const dir = path.join(legacyRoot, name);
  if (!fs.existsSync(dir)) continue;
  const ours = name === "codex-review"
    ? fs.existsSync(path.join(dir, "scripts", "codex-runner.js"))
    : new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fs.existsSync(path.join(dir, "SKILL.md")) ? fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") : "");
  check(!ours, `legacy: pack copy still in ${dir}`);
}

// Runtime: runner, modules, MCP server, SDK
for (const p of [runner, mcpServer, path.join(runtime, "scripts", "lib", "review-core.js"), path.join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "package.json")]) {
  check(fs.existsSync(p), `runtime: missing ${p}`);
}
try {
  const version = execFileSync(process.execPath, [runner, "version"], { encoding: "utf8" }).trim();
  check(version === "14", `runtime: runner version ${version}, expected 14`);
} catch (e) {
  failures.push(`runtime: runner version failed: ${e.message}`);
}

// The installed MCP server starts and lists the four tools
try {
  const sdk = path.join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
  const { Client } = await import(pathToFileURL(path.join(sdk, "index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "stdio.js")).href);
  const client = new Client({ name: "install-check", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpServer], env: { ...process.env, HOME: home } }));
  const { tools } = await client.listTools();
  check(JSON.stringify(tools.map(t => t.name).sort()) === JSON.stringify(TOOLS), `mcp: tools ${tools.map(t => t.name).join(",")}`);
  await client.close();
} catch (e) {
  failures.push(`mcp: server did not start: ${e.message}`);
}

// Registration with each client whose CLI is installed, exactly once, pointing at the installed server
if (onPath("claude")) {
  const file = path.join(home, ".claude.json");
  const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).mcpServers || {} : {};
  const entry = servers["codex-review"];
  check(entry && entry.args?.includes(mcpServer), "claude: codex-review MCP server not registered at the installed path");
  check(entry?.env?.REVIEW_WAIT_DEFAULT_S === "300", "claude: REVIEW_WAIT_DEFAULT_S is not 300");
  check(Object.values(servers).filter(s => s.args?.includes(mcpServer)).length === 1, "claude: MCP server registered more than once");
}
if (onPath("codex")) {
  const file = path.join(codexHome, "config.toml");
  const toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  check((toml.match(/^\[mcp_servers\.codex-review\]$/gm) || []).length === 1, "codex: [mcp_servers.codex-review] is not present exactly once");
  check(toml.includes(mcpServer), "codex: MCP server path not in config.toml");
  check(/REVIEW_WAIT_DEFAULT_S\s*=\s*"50"/.test(toml), "codex: REVIEW_WAIT_DEFAULT_S is not 50");
  for (const tool of TOOLS) {
    const tables = toml.match(new RegExp(`^\\[mcp_servers\\.codex-review\\.tools\\.${tool}\\]\\napproval_mode = "approve"$`, "gm")) || [];
    check(tables.length === 1, `codex: ${tool} is not pre-approved exactly once (codex exec rejects unapproved MCP calls)`);
  }
}

if (failures.length) {
  console.error(`install-check: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("install-check: ok");
