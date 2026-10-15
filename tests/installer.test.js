import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "bin", "cross-review.js");
const CHECK = path.join(ROOT, "tests", "install-check.mjs");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A skill as the codex-review pack installed it: its name and the runner path it rendered, which was
// always in the Claude Code skills root
function writeOldSkill(home, root, name) {
  const runner = path.join(home, ".claude", "skills", "codex-review", "scripts", "codex-runner.js");
  write(path.join(root, name, "SKILL.md"), `---\nname: ${name}\n---\nRUNNER="${runner}"\n`);
}

function onPath(cmd) {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
}

test("upgrading from the codex-review pack removes its skills, runtime, MCP server and guidance, and keeps foreign ones", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-upgrade-"));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
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
    // The old MCP registration in Claude Code; in Codex a foreign server uses the old name (a comment quotes the old path)
    const oldServer = path.join(claude, "codex-review", "scripts", "mcp-server.js");
    const foreignServer = path.join(home, "opt", "foreign-codex-review", "scripts", "mcp-server.js");
    write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "codex-review": { type: "stdio", command: "node", args: [oldServer], env: {} },
      other: { type: "stdio", command: "other-server", args: [], env: {} },
    } }));
    write(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.codex-review]", `# was "${oldServer}"`, 'command = "node"', "args = [", `  # "${oldServer}",`, `  "${foreignServer}",`, "]", "",
      "[mcp_servers.other]", 'command = "other-server"', "",
    ].join("\n"));
    // Guidance block written by the old --auto, inside user content
    write(path.join(home, ".claude", "CLAUDE.md"),
      "# Mine\n\n<!-- codex-auto-review-start -->\nold guidance\n<!-- codex-auto-review-end -->\n\nkeep me\n");

    // A plain install (no --auto) refreshes the guidance block the old pack wrote
    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);
    const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(!md.includes("codex-auto-review") && !md.includes("old guidance"), "old guidance block replaced");
    assert.equal(md.split("<!-- cross-review-start -->").length, 2, "one new guidance block");
    assert.ok(md.startsWith("# Mine\n") && md.includes("keep me"), "user content kept");
    execFileSync(process.execPath, [INSTALLER, "--auto"], { env, stdio: "pipe" });
    assert.equal(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8"), md, "--auto leaves a current block as it is");

    for (const dir of [
      path.join(claude, "codex-review"), path.join(claude, "codex-plan-review"), path.join(claude, "codex-security-review"),
      path.join(agents, "codex-impl-review"),
      path.join(legacy, "codex-review"), path.join(legacy, "codex-think-about"), path.join(legacy, "codex-parallel-review"),
    ]) assert.ok(!fs.existsSync(dir), `${dir} removed`);
    assert.ok(fs.existsSync(path.join(agents, "codex-pr-review", "SKILL.md")), "foreign skill with an old pack name kept");
    assert.ok(fs.existsSync(path.join(legacy, "unrelated", "SKILL.md")), "unrelated skill kept");

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
  write(path.join(bin, "npm"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  try {
    const claude = path.join(home, ".claude", "skills");
    write(path.join(claude, "codex-review", "scripts", "codex-runner.js"), "// v14\n");
    const oldServer = path.join(claude, "codex-review", "scripts", "mcp-server.js");
    write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "codex-review": { type: "stdio", command: "node", args: [oldServer], env: {} },
    } }));
    write(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.codex-review]", 'command = "node"', `args = ["${oldServer}"]`, "",
      "[mcp_servers.codex-review.tools.review_begin]", 'approval_mode = "approve"', "",
    ].join("\n"));

    const out = execFileSync(process.execPath, [INSTALLER], { env, encoding: "utf8", stdio: "pipe" });
    assert.match(out, /not registered \(runner CLI fallback\)/);
    assert.ok(!fs.existsSync(path.join(claude, "codex-review")), "old runtime removed");
    const servers = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers || {};
    assert.ok(!servers["codex-review"], "old Claude MCP registration removed");
    assert.ok(!fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").includes("codex-review"), "old Codex MCP registration and approvals removed");
    assert.ok(!fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), "no guidance without --auto");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a trusted project's Codex config does not decide which global registration is removed",
  { timeout: 600_000, skip: !onPath("codex") ? "needs the codex CLI" : false }, () => {
  for (const globalIsOld of [false, true]) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-project-")));
    // TMPDIR inside the project too: the lookup must not depend on where temp files go
    const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"), TMPDIR: path.join(home, "proj", ".tmp") };
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    try {
      const oldServer = path.join(home, ".claude", "skills", "codex-review", "scripts", "mcp-server.js");
      const foreignServer = path.join(home, "opt", "foreign", "mcp-server.js");
      const [globalArg, projectArg] = globalIsOld ? [oldServer, foreignServer] : [foreignServer, oldServer];
      const project = path.join(home, "proj");
      write(path.join(project, ".codex", "config.toml"), `[mcp_servers.codex-review]\ncommand = "node"\nargs = ["${projectArg}"]\n`);
      execFileSync("git", ["init", "-q"], { cwd: project });
      write(path.join(home, ".codex", "config.toml"),
        `[mcp_servers.codex-review]\ncommand = "node"\nargs = ["${globalArg}"]\n\n[projects."${project}"]\ntrust_level = "trusted"\n`);

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
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
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

test("install-check rejects a broken install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-broken-"));
  try {
    write(path.join(home, ".claude", "skills", "loop-plan", "SKILL.md"), "Run {{CLIENT_SKILL}}loop-implement\n");
    writeOldSkill(home, path.join(home, ".claude", "skills"), "codex-plan-review");
    let failed = false;
    try {
      execFileSync(process.execPath, [CHECK, home], { env: { ...process.env, CODEX_HOME: path.join(home, ".codex") }, stdio: "pipe" });
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
