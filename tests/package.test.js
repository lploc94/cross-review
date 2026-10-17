// The npm package @tlelabs/cross-review: its metadata, its one version number, and what `npm pack` ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => JSON.parse(fs.readFileSync(path.join(REPO, file), "utf8"));
const pkg = read("package.json");
const manifest = read("skill-packs/cross-review/manifest.json");

test("package: scoped name, the cross-review command, and the manifest's version", () => {
  assert.equal(pkg.name, "@tlelabs/cross-review");
  assert.deepEqual(pkg.bin, { "cross-review": "./bin/cross-review.js" });
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version, "package.json and manifest.json carry one version");
});

test("package: homepage, repository, issues and license point at the project", () => {
  assert.equal(pkg.homepage, "https://cross-review.tlelabs.com");
  assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/lploc94/cross-review.git" });
  assert.deepEqual(pkg.bugs, { url: "https://github.com/lploc94/cross-review/issues" });
  assert.equal(pkg.license, "MIT");
  assert.match(fs.readFileSync(path.join(REPO, "LICENSE"), "utf8"), /^MIT License\n/);
});

/**
 * Run npm without a shell. Windows has only npm.cmd, which Node does not spawn without one, so npm's own
 * npm-cli.js runs under this node: npm_execpath (under npm) or the copy next to node.exe.
 */
function npm(args, opts) {
  const nextToNode = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const cli = [process.env.npm_execpath, process.platform === "win32" ? nextToNode : null]
    .find(p => p && p.endsWith(".js") && fs.existsSync(p));
  return cli ? execFileSync(process.execPath, [cli, ...args], opts) : execFileSync("npm", args, opts);
}

test("package: npm pack ships the runtime lock file and LICENSE, never the runtime's node_modules", () => {
  // a copy of the working tree (tracked and new files) with a planted node_modules, as on a
  // developer's machine after `npm ci --prefix skill-packs/cross-review`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pack-check-"));
  try {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: REPO, encoding: "utf8" })
      .split("\0").filter(Boolean).filter(f => fs.existsSync(path.join(REPO, f)));
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, f), path.join(tmp, f));
    }
    const probe = path.join(tmp, "skill-packs/cross-review/node_modules/.pack-probe/x.js");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "// planted by the test\n");

    const [packed] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const paths = packed.files.map(f => f.path);
    for (const want of ["package.json", "README.md", "LICENSE", "bin/cross-review.js", "skill-packs/cross-review/manifest.json", "skill-packs/cross-review/package-lock.json", "skill-packs/cross-review/scripts/review-runner.js"]) {
      assert.ok(paths.includes(want), `${want} is packed`);
    }
    assert.deepEqual(paths.filter(p => p.includes("node_modules")), [], "nothing under node_modules is packed");
    assert.equal(packed.name, "@tlelabs/cross-review");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
