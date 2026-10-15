import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "bin", "codex-skill.js");
const CHECK = path.join(ROOT, "tests", "install-check.mjs");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("installing over an old install leaves a clean, registered install and keeps foreign skills", { timeout: 600_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-upgrade-"));
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  try {
    // Old Claude install: flavor text, protocol copies, a removed skill
    const claude = path.join(home, ".claude", "skills");
    write(path.join(claude, "codex-plan-review", "SKILL.md"), "---\nname: codex-plan-review\n---\nold\n");
    write(path.join(claude, "codex-plan-review", "references", "flavor-text.md"), "flavor\n");
    write(path.join(claude, "codex-plan-review", "references", "protocol.md"), "old protocol\n");
    write(path.join(claude, "codex-security-review", "SKILL.md"), "---\nname: codex-security-review\n---\n");
    // Old Codex install in the deprecated root, plus a foreign skill that happens to share a name
    const legacy = path.join(home, ".codex", "skills");
    write(path.join(legacy, "codex-review", "scripts", "codex-runner.js"), "// v13\n");
    write(path.join(legacy, "codex-impl-review", "SKILL.md"), "---\nname: codex-impl-review\n---\nold\n");
    write(path.join(legacy, "codex-parallel-review", "SKILL.md"), "---\nname: codex-parallel-review\n---\n");
    write(path.join(legacy, "codex-pr-review", "SKILL.md"), "---\nname: my-own-pr-skill\n---\n");
    write(path.join(legacy, "unrelated", "SKILL.md"), "---\nname: unrelated\n---\n");

    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    execFileSync(process.execPath, [INSTALLER], { env, stdio: "pipe" });
    const out = execFileSync(process.execPath, [CHECK, home], { env, encoding: "utf8" });
    assert.match(out, /install-check: ok/);

    assert.ok(!fs.existsSync(path.join(legacy, "codex-review")), "old Codex runtime removed");
    assert.ok(!fs.existsSync(path.join(legacy, "codex-impl-review")), "old Codex skill removed");
    assert.ok(!fs.existsSync(path.join(legacy, "codex-parallel-review")), "removed skill gone from Codex root");
    assert.ok(fs.existsSync(path.join(legacy, "codex-pr-review", "SKILL.md")), "foreign skill with a pack name kept");
    assert.ok(fs.existsSync(path.join(legacy, "unrelated", "SKILL.md")), "unrelated skill kept");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install-check rejects a broken install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-broken-"));
  try {
    write(path.join(home, ".claude", "skills", "loop-plan", "SKILL.md"), "Run {{CLIENT_SKILL}}loop-implement\n");
    let failed = false;
    try {
      execFileSync(process.execPath, [CHECK, home], { env: { ...process.env, CODEX_HOME: path.join(home, ".codex") }, stdio: "pipe" });
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr), /unrendered placeholder/);
      assert.match(String(e.stderr), /missing .*codex-runner\.js/);
    }
    assert.ok(failed, "install-check exits non-zero");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
