#!/usr/bin/env node
// Verify an installation made with HOME=<home>: node tests/install-check.mjs <home>
// Reads the installed files and starts the installed MCP server; it does not trust installer output.
// CODEX_HOME defaults to <home>/.codex, as in the installer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { commandAvailable, resolveSpawn } from "../skill-packs/cross-review/scripts/lib/command.js";

const home = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(home)) {
  console.error("usage: node tests/install-check.mjs <home>");
  process.exit(2);
}
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
const IS_WIN = process.platform === "win32";

const RUNNER_SKILLS = ["review-plan", "review-impl", "review-think", "review-pr"];
const PLAIN_SKILLS = ["loop-plan", "loop-implement"];
const SKILLS = [...RUNNER_SKILLS, ...PLAIN_SKILLS];
// The earlier codex-review pack: its runtime, skills and MCP server must be gone after install
const LEGACY_RUNTIME = "codex-review";
const LEGACY_SKILLS = [
  "codex-plan-review", "codex-impl-review", "codex-think-about", "codex-commit-review", "codex-pr-review",
  "codex-parallel-review", "codex-codebase-review", "codex-security-review",
];
// Skills this pack dropped; an install of them (this pack's runner path) must be gone
const RETIRED_SKILLS = ["review-commit"];
const TOOLS = ["review_begin", "review_end", "review_reply", "review_wait"];

const claudeRoot = path.join(home, ".claude", "skills");
const agentsRoot = path.join(home, ".agents", "skills");
const legacyRoot = path.join(codexHome, "skills");
const runtime = path.join(claudeRoot, "cross-review");
const runner = path.join(runtime, "scripts", "review-runner.js");
const mcpServer = path.join(runtime, "scripts", "mcp-server.js");
// The earlier pack's runtime lived only here: its skills had the runner path rendered (escaped for a
// double-quoted shell string) and its MCP server was registered at this path ('/' separators)
const legacyRuntime = path.join(claudeRoot, LEGACY_RUNTIME);
const legacyRunnerRef = path.join(legacyRuntime, "scripts", "codex-runner.js").replace(/[\\"$`]/g, "\\$&");
const runnerRef = runner.replace(/[\\"$`]/g, "\\$&");
const slashed = s => String(s).replace(/\\+/g, "/");
const legacyServer = slashed(path.join(legacyRuntime, "scripts", "mcp-server.js"));

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

/** The directory holds a retired skill of this pack (its SKILL.md renders this pack's runner path). */
function isRetiredCopy(dir, name) {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;
  const text = fs.readFileSync(skillMd, "utf8");
  return new RegExp(`^name:\\s*${name}\\s*$`, "m").test(text) && text.includes(runnerRef);
}

/** The directory was installed by the earlier codex-review pack (not a foreign skill that shares the name). */
function isLegacyCopy(dir, name) {
  if (name === LEGACY_RUNTIME) return fs.existsSync(path.join(dir, "scripts", "codex-runner.js"));
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;
  const text = fs.readFileSync(skillMd, "utf8");
  return new RegExp(`^name:\\s*${name}\\s*$`, "m").test(text) && text.includes(legacyRunnerRef);
}

const onPath = cmd => commandAvailable(cmd);

/** Runs a CLI the way the installer does: no shell; an npm .cmd shim as what it points at. */
function runCli(cmd, args, opts) {
  const r = resolveSpawn(cmd, args, { allowCmdShell: true });
  return execFileSync(r.cmd, r.args, { windowsVerbatimArguments: r.windowsVerbatimArguments, ...opts });
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
    check(text.includes(`node "${runnerRef}"`), `${client}: ${skill} does not point at the installed runner`);
  }
  for (const skill of [...SKILLS, "cross-review"]) {
    for (const f of walk(path.join(root, skill))) {
      check(!/^(protocol|flavor-text)\.md$/.test(path.basename(f)), `${client}: stale file ${f}`);
      if (f.endsWith(".md")) check(!/flavor/i.test(fs.readFileSync(f, "utf8")), `${client}: flavor text in ${f}`);
    }
  }
  for (const name of [LEGACY_RUNTIME, ...LEGACY_SKILLS]) check(!isLegacyCopy(path.join(root, name), name), `${client}: old ${name} still installed`);
  for (const name of RETIRED_SKILLS) check(!isRetiredCopy(path.join(root, name), name), `${client}: retired ${name} still installed`);
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    check(!/^\.cross-review-staging-|^\..+-backup-/.test(name), `${client}: leftover ${path.join(root, name)}`);
  }
}

// Codex copies of the loop skills speak Codex
for (const skill of PLAIN_SKILLS) {
  const file = path.join(agentsRoot, skill, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  check(!text.includes("CLAUDE.md"), `codex: ${skill} mentions CLAUDE.md`);
  check(!/(^|[\s`(])\/(loop|review)-/.test(text), `codex: ${skill} uses slash commands`);
  check(text.includes("$review-") || text.includes("$loop-"), `codex: ${skill} lacks $skill references`);
  check(fs.existsSync(path.join(agentsRoot, skill, "agents", "openai.yaml")), `codex: ${skill} lacks agents/openai.yaml`);
}

// The loop skills' plans command runs from the install (HOME is the install's home, never the real one)
{
  const ws = fs.mkdtempSync(path.join(home, "plans-check-"));
  try {
    const out = JSON.parse(execFileSync(process.execPath, [runner, "plans", "--working-dir", ws], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } }));
    check(out.dir === path.join(fs.realpathSync(ws), ".cross-review", "plans") && fs.existsSync(out.dir), `plans: unexpected dir ${out.dir}`);
    check(Array.isArray(out.plans), "plans: no plans list");
  } catch (e) {
    failures.push(`plans: the installed runner failed: ${e.message}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// The earlier pack's copies are gone from Codex's deprecated skills root
const installedReal = new Set([...SKILLS.flatMap(s => [path.join(claudeRoot, s), path.join(agentsRoot, s)]), runtime]
  .filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)));
for (const name of [LEGACY_RUNTIME, ...LEGACY_SKILLS]) {
  const dir = path.join(legacyRoot, name);
  if (!fs.existsSync(dir) || installedReal.has(fs.realpathSync(dir))) continue;
  check(!isLegacyCopy(dir, name), `legacy: old ${name} still in ${dir}`);
}

// Runtime: runner, modules, MCP server, SDK
for (const p of [runner, mcpServer, path.join(runtime, "scripts", "lib", "review-core.js"), path.join(runtime, "scripts", "lib", "config.js"), path.join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "package.json")]) {
  check(fs.existsSync(p), `runtime: missing ${p}`);
}

// Dashboard: server, UI, the Lucide licence and the pack version it shows
const ui = path.join(runtime, "scripts", "lib", "dashboard", "ui");
for (const p of [path.join(runtime, "scripts", "lib", "dashboard", "server.js"), path.join(ui, "index.html"), path.join(ui, "app.js"), path.join(ui, "settings.js"), path.join(ui, "LICENSE-lucide.txt"), path.join(ui, "avatars", "reviewer.png"), path.join(runtime, "manifest.json")]) {
  check(fs.existsSync(p), `dashboard: missing ${p}`);
}
if (fs.existsSync(path.join(ui, "LICENSE-lucide.txt"))) {
  check(fs.readFileSync(path.join(ui, "LICENSE-lucide.txt"), "utf8").includes("ISC License"), "dashboard: LICENSE-lucide.txt is not the ISC licence");
}
try {
  const version = execFileSync(process.execPath, [runner, "version"], { encoding: "utf8" }).trim();
  check(version === "15", `runtime: runner version ${version}, expected 15`);
} catch (e) {
  failures.push(`runtime: runner version failed: ${e.message}`);
}

// The cross-review command: a small shell script in ~/.local/bin that runs the installed runner
if (!IS_WIN) {
  const command = path.join(home, ".local", "bin", "cross-review");
  try {
    const st = fs.lstatSync(command);
    check(st.isFile() && (st.mode & 0o111) !== 0, "command: ~/.local/bin/cross-review is not an executable file");
    const text = fs.readFileSync(command, "utf8");
    check(text.startsWith("#!/bin/sh\n") && text.includes("# cross-review command"), "command: ~/.local/bin/cross-review has no cross-review marker");
    // the runner path as a POSIX shell single-quoted word (each ' written as '\'')
    check(text.includes(`'${runner.replace(/'/g, `'\\''`)}'`), "command: ~/.local/bin/cross-review does not run the installed runner");
    const version = execFileSync(command, ["version"], { encoding: "utf8" }).trim();
    check(version === "15", `command: cross-review version printed ${version}, expected 15`);
  } catch (e) {
    failures.push(`command: ~/.local/bin/cross-review: ${e.message}`);
  }
}

// Windows: cross-review.cmd, .ps1 and sh in npm's global folder, each with the marker and the installed runner
if (IS_WIN) {
  try {
    const dir = process.env.npm_config_prefix || runCli("npm", ["prefix", "-g"], { encoding: "utf8" }).trim().split(/\r?\n/).pop().trim();
    const cmd = path.join(dir, "cross-review.cmd");
    const expected = [
      // the .cmd names the profile through %USERPROFILE% (cmd.exe does not read batch files as UTF-8)
      [cmd, `"%USERPROFILE%${runner.slice(home.length)}"`],
      [path.join(dir, "cross-review.ps1"), `'${runner.replace(/'/g, "''")}'`],
      [path.join(dir, "cross-review"), `'${slashed(runner).replace(/'/g, `'\\''`)}'`],
    ];
    for (const [file, ref] of expected) {
      const text = fs.readFileSync(file, "utf8");
      check(text.includes("cross-review command, written by the cross-review installer"), `command: ${file} has no cross-review marker`);
      check(text.includes(ref), `command: ${file} does not run the installed runner`);
    }
    const version = runCli(cmd, ["version"], { encoding: "utf8" }).trim();
    check(version === "15", `command: cross-review.cmd version printed ${version}, expected 15`);
  } catch (e) {
    failures.push(`command: Windows cross-review command: ${e.message}`);
  }
}

// The installed MCP server starts and lists the four tools
try {
  const sdk = path.join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client");
  const { Client } = await import(pathToFileURL(path.join(sdk, "index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdk, "stdio.js")).href);
  const client = new Client({ name: "install-check", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpServer], env: { ...process.env, HOME: home, USERPROFILE: home } }));
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
  const entry = servers["cross-review"];
  check(entry && entry.args?.includes(mcpServer), "claude: cross-review MCP server not registered at the installed path");
  check(!Object.values(servers).some(s => (s.args || []).some(a => slashed(a) === legacyServer)), "claude: the old codex-review MCP server is still registered");
  check(entry?.env?.REVIEW_WAIT_DEFAULT_S === "270", "claude: REVIEW_WAIT_DEFAULT_S is not 270");
  check(Object.values(servers).filter(s => s.args?.includes(mcpServer)).length === 1, "claude: MCP server registered more than once");
}
if (onPath("codex")) {
  const file = path.join(codexHome, "config.toml");
  const toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  check((toml.match(/^\[mcp_servers\.cross-review\]$/gm) || []).length === 1, "codex: [mcp_servers.cross-review] is not present exactly once");
  // Windows paths sit in TOML strings with escaped backslashes
  check(slashed(toml).includes(slashed(mcpServer)), "codex: MCP server path not in config.toml");
  // Global server args as Codex itself parses config.toml, read from the filesystem root:
  // a project's config could shadow them
  if (toml) {
    try {
      const listed = JSON.parse(runCli("codex", ["mcp", "list", "--json"], { encoding: "utf8", cwd: path.parse(home).root, env: { ...process.env, CODEX_HOME: codexHome } }));
      check(!listed.some(s => (s.transport?.args || []).some(a => slashed(a) === legacyServer)), "codex: the old codex-review MCP server is still registered");
    } catch (e) {
      failures.push(`codex: mcp list failed: ${e.message}`);
    }
  }
  check(/REVIEW_WAIT_DEFAULT_S\s*=\s*"270"/.test(toml), "codex: REVIEW_WAIT_DEFAULT_S is not 270");
  // review_wait blocks up to 270 s; Codex's default 60 s tool timeout would cut it off
  const serverTable = (toml.match(/^\[mcp_servers\.cross-review\]\n(?:(?!\[).*\n?)*/m) || [""])[0];
  check((serverTable.match(/^tool_timeout_sec = 300\.0$/gm) || []).length === 1, "codex: cross-review tool_timeout_sec is not 300 exactly once");
  for (const tool of TOOLS) {
    const tables = toml.match(new RegExp(`^\\[mcp_servers\\.cross-review\\.tools\\.${tool}\\]\\napproval_mode = "approve"$`, "gm")) || [];
    check(tables.length === 1, `codex: ${tool} is not pre-approved exactly once (codex exec rejects unapproved MCP calls)`);
  }
}

if (failures.length) {
  console.error(`install-check: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("install-check: ok");
