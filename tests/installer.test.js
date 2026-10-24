import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandAvailable } from "../skill-packs/cross-review/scripts/lib/command.js";
import { writeFakeCli } from "./helpers/fake-cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "bin", "cross-review.js");
const CHECK = path.join(ROOT, "tests", "install-check.mjs");
const IS_WIN = process.platform === "win32";
const MARKER = "cross-review command, written by the cross-review installer; reinstalling rewrites it";

/** A path as the installer renders it into a double-quoted shell string in SKILL.md. */
const shellEscaped = s => s.replace(/[\\"$`]/g, "\\$&");
/** A path inside a TOML basic string. */
const tomlEscaped = s => s.replace(/[\\"]/g, "\\$&");
/** Runs a Windows .cmd file with arguments, as a user's shell would. */
const runCmdFile = (file, args, opts) => execFileSync(process.env.ComSpec || "cmd.exe",
  ["/d", "/s", "/c", `"${[file, ...args].map(a => `"${a}"`).join(" ")}"`], { encoding: "utf8", windowsVerbatimArguments: true, ...opts });

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A skill as the codex-review pack installed it: its name and the runner path it rendered, which was
// always in the Claude Code skills root
function writeOldSkill(home, root, name) {
  const runner = path.join(home, ".claude", "skills", "codex-review", "scripts", "codex-runner.js");
  write(path.join(root, name, "SKILL.md"), `---\nname: ${name}\n---\nRUNNER="${shellEscaped(runner)}"\n`);
}

const onPath = cmd => commandAvailable(cmd);

test("upgrading from the codex-review pack removes its skills, runtime, MCP server and guidance, and keeps foreign ones", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-upgrade-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global") };
  try {
    // codex-review pack install for Claude Code: runtime, skills, a skill removed even earlier
    const claude = path.join(home, ".claude", "skills");
    write(path.join(claude, "codex-review", "scripts", "codex-runner.js"), "// v14\n");
    writeOldSkill(home, claude, "codex-plan-review");
    write(path.join(claude, "codex-plan-review", "references", "flavor-text.md"), "flavor\n");
    writeOldSkill(home, claude, "codex-security-review");
    // ... for Codex, plus a foreign skill that has an old name but is not the pack's
    const agents = path.join(home, ".agents", "skills");
    writeOldSkill(home, agents, "codex-impl-review");
    write(path.join(agents, "codex-pr-review", "SKILL.md"), "---\nname: codex-pr-review\n---\nnode /opt/my-review-tools/codex-runner.js\n");
    // ... and in Codex's deprecated root
    const legacy = path.join(home, ".codex", "skills");
    write(path.join(legacy, "codex-review", "scripts", "codex-runner.js"), "// v13\n");
    writeOldSkill(home, legacy, "codex-think-about");
    writeOldSkill(home, legacy, "codex-parallel-review");
    write(path.join(legacy, "unrelated", "SKILL.md"), "---\nname: unrelated\n---\n");
    // review-commit, dropped from this pack: its installs carry this pack's runner path; a foreign one does not
    const runner = path.join(claude, "cross-review", "scripts", "review-runner.js");
    write(path.join(claude, "review-commit", "SKILL.md"), `---\nname: review-commit\n---\nnode "${shellEscaped(runner)}" begin\n`);
    write(path.join(agents, "review-commit", "SKILL.md"), `---\nname: review-commit\n---\nnode "${shellEscaped(runner)}" begin\n`);
    write(path.join(legacy, "review-commit", "SKILL.md"), "---\nname: review-commit\n---\nmy own commit reviewer\n");
    // The old MCP registration in Claude Code; in Codex a foreign server uses the old name (a comment quotes the old path)
    const oldServer = path.join(claude, "codex-review", "scripts", "mcp-server.js");
    const foreignServer = path.join(home, "opt", "foreign-codex-review", "scripts", "mcp-server.js");
    write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "codex-review": { type: "stdio", command: "node", args: [oldServer], env: {} },
      other: { type: "stdio", command: "other-server", args: [], env: {} },
    } }));
    write(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.codex-review]", `# was "${tomlEscaped(oldServer)}"`, 'command = "node"', "args = [", `  # "${tomlEscaped(oldServer)}",`, `  "${tomlEscaped(foreignServer)}",`, "]", "",
      "[mcp_servers.other]", 'command = "other-server"', "",
    ].join("\n"));
    // Guidance block written by the old --auto, inside user content
    write(path.join(home, ".claude", "CLAUDE.md"),
      "# Mine\n\n<!-- codex-auto-review-start -->\nold guidance\n<!-- codex-auto-review-end -->\n\nkeep me\n");
    write(path.join(home, ".gemini", "GEMINI.md"),
      "# Gemini Mine\n\n<!-- codex-auto-review-start -->\nold agy guidance\n<!-- codex-auto-review-end -->\n\nkeep agy\n");
    write(path.join(home, ".gemini", "config", "config.json"), JSON.stringify({
      plugins: { "other-plugin": { enabled: false } },
    }));
    write(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({
      mcpServers: { "other-mcp": { command: "node", args: [], disabled: false } },
    }));

    // The cross-review command an earlier install wrote, pointing at a runner that moved
    if (IS_WIN) write(path.join(env.npm_config_prefix, "cross-review.cmd"), `@ECHO off\r\nREM ${MARKER}\r\n"node" "C:\\old\\place\\review-runner.js" %*\r\n`);
    else write(path.join(home, ".local", "bin", "cross-review"), `#!/bin/sh\n# ${MARKER}\nexec node '/old/place/review-runner.js' "$@"\n`);

    // A plain install (no --auto) refreshes the guidance block the old pack wrote
    const run = spawnSync(process.execPath, [INSTALLER], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const log = run.stdout + run.stderr;
    // no shell for CLI calls (DEP0190: args passed to a shell are not escaped)
    assert.doesNotMatch(log, /DEP0190/);
    assert.match(log, IS_WIN ? /Command: +.*npm-global\\cross-review\.cmd/ : /Command: +.*\.local\/bin\/cross-review/);
    // the test's PATH does not hold the command folder, so the installer says how to add it
    assert.match(log, /not on your PATH/);
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);
    const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(!md.includes("codex-auto-review") && !md.includes("old guidance"), "old guidance block replaced");
    assert.equal(md.split("<!-- cross-review-start -->").length, 2, "one new guidance block");
    // Only review-plan and review-impl run automatically
    assert.ok(md.includes("the `review-plan` skill") && md.includes("the `review-impl` skill"), "block names review-plan and review-impl as skills");
    assert.ok(!/review-(commit|pr|think)/.test(md), "block names no other review skill");
    assert.ok(!/[/$](review|loop)-/.test(md), "block uses no client-specific invocation syntax");
    assert.ok(md.startsWith("# Mine\n") && md.includes("keep me"), "user content kept");
    execFileSync(process.execPath, [INSTALLER, "--auto"], { env, stdio: "pipe" });
    assert.equal(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8"), md, "--auto leaves a current block as it is");
    const agyMd = fs.readFileSync(path.join(home, ".gemini", "GEMINI.md"), "utf8");
    assert.ok(!agyMd.includes("codex-auto-review") && !agyMd.includes("old agy guidance"), "old agy guidance block replaced");
    assert.equal(agyMd.split("<!-- cross-review-start -->").length, 2, "one new agy guidance block");
    assert.ok(agyMd.startsWith("# Gemini Mine\n") && agyMd.includes("keep agy"), "agy user content kept");
    const agyCfg = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "config.json"), "utf8"));
    assert.deepEqual(agyCfg.plugins["other-plugin"], { enabled: false }, "foreign Antigravity plugin preserved");
    assert.deepEqual(agyCfg.plugins["cross-review"], { enabled: true }, "cross-review Antigravity plugin enabled");
    const agyMcp = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
    assert.ok(agyMcp.mcpServers["other-mcp"], "foreign Antigravity MCP server preserved");
    assert.ok(agyMcp.mcpServers["cross-review"], "cross-review Antigravity MCP server registered");

    for (const dir of [
      path.join(claude, "codex-review"), path.join(claude, "codex-plan-review"), path.join(claude, "codex-security-review"),
      path.join(agents, "codex-impl-review"), path.join(claude, "review-commit"), path.join(agents, "review-commit"),
      path.join(legacy, "codex-review"), path.join(legacy, "codex-think-about"), path.join(legacy, "codex-parallel-review"),
    ]) assert.ok(!fs.existsSync(dir), `${dir} removed`);
    assert.ok(fs.existsSync(path.join(agents, "codex-pr-review", "SKILL.md")), "foreign skill with an old pack name kept");
    assert.ok(fs.existsSync(path.join(legacy, "unrelated", "SKILL.md")), "unrelated skill kept");
    assert.ok(fs.existsSync(path.join(legacy, "review-commit", "SKILL.md")), "foreign review-commit kept");

    if (fs.existsSync(path.join(home, ".claude.json"))) {
      const servers = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers;
      assert.ok(servers.other, "foreign Claude MCP server kept");
    }
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, /^\[mcp_servers\.other\]$/m, "foreign Codex MCP server kept");
    if (onPath("codex")) assert.ok(toml.includes(foreignServer), "foreign server registered under the old name kept");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a failed npm ci still removes the old MCP registrations and adds no guidance without --auto",
  { timeout: 600_000, skip: !onPath("claude") || !onPath("codex") ? "needs claude and codex CLIs" : false }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-no-deps-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  writeFakeCli(bin, "npm", "process.exit(1);\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global"), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  try {
    const claude = path.join(home, ".claude", "skills");
    write(path.join(claude, "codex-review", "scripts", "codex-runner.js"), "// v14\n");
    const oldServer = path.join(claude, "codex-review", "scripts", "mcp-server.js");
    write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "codex-review": { type: "stdio", command: "node", args: [oldServer], env: {} },
    } }));
    write(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.codex-review]", 'command = "node"', `args = ["${tomlEscaped(oldServer)}"]`, "",
      "[mcp_servers.codex-review.tools.review_begin]", 'approval_mode = "approve"', "",
    ].join("\n"));

    const out = execFileSync(process.execPath, [INSTALLER], { env, encoding: "utf8", stdio: "pipe" });
    assert.match(out, /not registered \(runner CLI fallback\)/);
    assert.ok(!fs.existsSync(path.join(claude, "codex-review")), "old runtime removed");
    const servers = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers || {};
    assert.ok(!servers["codex-review"], "old Claude MCP registration removed");
    assert.ok(!fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").includes("codex-review"), "old Codex MCP registration and approvals removed");
    assert.ok(!fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), "no guidance without --auto");
    assert.ok(!fs.existsSync(path.join(home, ".gemini", "GEMINI.md")), "no agy guidance without --auto");
    assert.ok(!fs.existsSync(path.join(home, ".gemini", "config", "mcp_config.json")), "no agy MCP config when npm ci fails");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a trusted project's Codex config does not decide which global registration is removed",
  { timeout: 600_000, skip: !onPath("codex") ? "needs the codex CLI" : false }, () => {
  for (const globalIsOld of [false, true]) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-project-")));
    // TMPDIR inside the project too: the lookup must not depend on where temp files go
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global"), TMPDIR: path.join(home, "proj", ".tmp") };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    try {
      const oldServer = path.join(home, ".claude", "skills", "codex-review", "scripts", "mcp-server.js");
      const foreignServer = path.join(home, "opt", "foreign", "mcp-server.js");
      const [globalArg, projectArg] = globalIsOld ? [oldServer, foreignServer] : [foreignServer, oldServer];
      const project = path.join(home, "proj");
      write(path.join(project, ".codex", "config.toml"), `[mcp_servers.codex-review]\ncommand = "node"\nargs = ["${tomlEscaped(projectArg)}"]\n`);
      execFileSync("git", ["init", "-q"], { cwd: project });
      write(path.join(home, ".codex", "config.toml"),
        `[mcp_servers.codex-review]\ncommand = "node"\nargs = ["${tomlEscaped(globalArg)}"]\n\n[projects."${tomlEscaped(project)}"]\ntrust_level = "trusted"\n`);

      execFileSync(process.execPath, [INSTALLER], { env, cwd: project, stdio: "pipe" });
      const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      if (globalIsOld) assert.ok(!toml.includes(oldServer), "the old global registration is removed");
      else assert.ok(toml.includes(foreignServer), "the foreign global registration is kept");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cleanup never deletes the new install when the Codex skills root is an alias", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-alias-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global") };
  try {
    fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.symlinkSync(path.join(home, ".agents", "skills"), path.join(home, ".codex", "skills"));
    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the cross-review command never replaces a file or link the installer did not write", { skip: process.platform === "win32", timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-command-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global") };
  const command = path.join(home, ".local", "bin", "cross-review");
  const install = () => {
    const r = spawnSync(process.execPath, [INSTALLER], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout + r.stderr;
  };
  try {
    write(command, "#!/bin/sh\necho my own cross-review\n");
    assert.match(install(), /left .*\.local\/bin\/cross-review in place/);
    assert.equal(fs.readFileSync(command, "utf8"), "#!/bin/sh\necho my own cross-review\n");
    // a link is never followed or replaced, even to a file that looks like the installer's
    const target = path.join(home, "elsewhere", "cross-review");
    write(target, "#!/bin/sh\n# cross-review command, written by the cross-review installer; reinstalling rewrites it\n");
    fs.rmSync(command);
    fs.symlinkSync(target, command);
    assert.match(install(), /left .*\.local\/bin\/cross-review in place/);
    assert.ok(fs.lstatSync(command).isSymbolicLink());
    assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\n# cross-review command, written by the cross-review installer; reinstalling rewrites it\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Windows: the command is cross-review.cmd, .ps1 and sh in npm's global folder; a foreign file is left as it is", { skip: !IS_WIN && "Windows command", timeout: 600_000 }, () => {
  // a user name with diacritics: cmd.exe reads a .cmd in the console's code page, not UTF-8
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-wincommand-Lộc-"));
  const prefix = path.join(home, "npm-global");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: prefix };
  const install = () => {
    const r = spawnSync(process.execPath, [INSTALLER], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout + r.stderr;
  };
  try {
    install();
    for (const name of ["cross-review.cmd", "cross-review.ps1", "cross-review"]) {
      assert.ok(fs.readFileSync(path.join(prefix, name), "utf8").includes(MARKER), `${name} carries the marker`);
    }
    assert.equal(runCmdFile(path.join(prefix, "cross-review.cmd"), ["version"], { env }).trim(), "15");
    assert.match(fs.readFileSync(path.join(prefix, "cross-review.cmd"), "utf8"), /^[\x00-\x7f]*$/, "the .cmd is ASCII: the profile is named through %USERPROFILE%");

    const foreign = "@ECHO off\r\necho my own cross-review\r\n";
    fs.writeFileSync(path.join(prefix, "cross-review.cmd"), foreign);
    fs.rmSync(path.join(prefix, "cross-review.ps1"));
    const log = install();
    assert.match(log, /left .*cross-review\.cmd in place/);
    assert.match(log, /not on your PATH/);
    assert.equal(fs.readFileSync(path.join(prefix, "cross-review.cmd"), "utf8"), foreign);
    assert.ok(fs.readFileSync(path.join(prefix, "cross-review.ps1"), "utf8").includes(MARKER), "the missing .ps1 is written again");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claude mcp add gets the node path and the server path as single arguments, without a shell", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-mcp-argv-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const log = path.join(home, "claude-argv.jsonl");
  writeFakeCli(bin, "claude", `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global"), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  try {
    const r = spawnSync(process.execPath, [INSTALLER], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const add = calls.find(a => a[0] === "mcp" && a[1] === "add");
    assert.ok(add, `claude mcp add was called: ${JSON.stringify(calls)}`);
    const server = path.join(home, ".claude", "skills", "cross-review", "scripts", "mcp-server.js");
    const node = add[add.indexOf("--") + 1];
    assert.equal(fs.realpathSync(node), fs.realpathSync(process.execPath));
    assert.deepEqual(add.slice(add.indexOf("--") + 2), [server]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a HOME with an apostrophe gets a working cross-review command", { skip: process.platform === "win32", timeout: 600_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-quote-"));
  const home = path.join(tmp, "user's home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global") };
  try {
    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("install-check rejects a broken install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-broken-"));
  try {
    write(path.join(home, ".claude", "skills", "loop-plan", "SKILL.md"), "Run {{CLIENT_SKILL}}loop-implement\n");
    writeOldSkill(home, path.join(home, ".claude", "skills"), "codex-plan-review");
    let failed = false;
    try {
      execFileSync(process.execPath, [CHECK, home], { env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), npm_config_prefix: path.join(home, "npm-global") }, stdio: "pipe" });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /unrendered placeholder/);
      assert.match(String(e.stderr), /missing .*review-runner\.js/);
      assert.match(String(e.stderr), /old codex-plan-review still installed/);
    }
    assert.ok(failed, "install-check exits non-zero");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
