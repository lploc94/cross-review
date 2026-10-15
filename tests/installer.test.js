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

test("upgrading from the codex-review pack removes its skills, runtime and MCP server and keeps foreign ones", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-upgrade-"));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  try {
    // codex-review pack install for Claude Code: runtime, skills, a skill removed even earlier
    const claude = path.join(home, ".claude", "skills");
    write(path.join(claude, "codex-review", "scripts", "codex-runner.js"), "// v14\n");
    write(path.join(claude, "codex-plan-review", "SKILL.md"), "---\nname: codex-plan-review\n---\nold\n");
    write(path.join(claude, "codex-plan-review", "references", "flavor-text.md"), "flavor\n");
    write(path.join(claude, "codex-security-review", "SKILL.md"), "---\nname: codex-security-review\n---\n");
    // ... for Codex, plus a foreign skill that happens to share an old name
    const agents = path.join(home, ".agents", "skills");
    write(path.join(agents, "codex-impl-review", "SKILL.md"), "---\nname: codex-impl-review\n---\nold\n");
    write(path.join(agents, "codex-pr-review", "SKILL.md"), "---\nname: my-own-pr-skill\n---\n");
    // ... and in Codex's deprecated root
    const legacy = path.join(home, ".codex", "skills");
    write(path.join(legacy, "codex-review", "scripts", "codex-runner.js"), "// v13\n");
    write(path.join(legacy, "codex-think-about", "SKILL.md"), "---\nname: codex-think-about\n---\nold\n");
    write(path.join(legacy, "codex-parallel-review", "SKILL.md"), "---\nname: codex-parallel-review\n---\n");
    write(path.join(legacy, "unrelated", "SKILL.md"), "---\nname: unrelated\n---\n");
    // Old MCP registrations next to a foreign server
    const oldServer = path.join(claude, "codex-review", "scripts", "mcp-server.js");
    write(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      "codex-review": { type: "stdio", command: "node", args: [oldServer], env: {} },
      other: { type: "stdio", command: "other-server", args: [], env: {} },
    } }));
    write(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.codex-review]", 'command = "node"', `args = ["${oldServer}"]`, "",
      "[mcp_servers.codex-review.tools.review_begin]", 'approval_mode = "approve"', "",
      "[mcp_servers.other]", 'command = "other-server"', "",
    ].join("\n"));
    // Guidance block written by the old --auto, inside user content
    write(path.join(home, ".claude", "CLAUDE.md"),
      "# Mine\n\n<!-- codex-auto-review-start -->\nold guidance\n<!-- codex-auto-review-end -->\n\nkeep me\n");

    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    execFileSync(process.execPath, [INSTALLER, "--auto"], { env, stdio: "pipe" });
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);

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
    assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /^\[mcp_servers\.other\]$/m, "foreign Codex MCP server kept");

    const md = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    assert.ok(!md.includes("codex-auto-review") && !md.includes("old guidance"), "old guidance block replaced");
    assert.equal(md.split("<!-- cross-review-start -->").length, 2, "one new guidance block");
    assert.ok(md.startsWith("# Mine\n") && md.includes("keep me"), "user content kept");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
    write(path.join(home, ".claude", "skills", "codex-plan-review", "SKILL.md"), "---\nname: codex-plan-review\n---\n");
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
