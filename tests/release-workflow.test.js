// The release workflow: a v* tag publishes @tlelabs/cross-review to npm by trusted publishing,
// only after the version checks, the tests and an install check. Read as text (no YAML parser).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(REPO, ".github", "workflows", "release.yml");
const text = () => fs.readFileSync(FILE, "utf8");
/** The step whose `- name:` line matches `name`, up to the next step. */
const step = name => {
  const steps = text().split(/\n(?=\s+- (?:name|uses|run):)/);
  const found = steps.find(s => s.trimStart().startsWith(`- name: ${name}`));
  assert.ok(found, `step "${name}" exists`);
  return found;
};
const at = (re, label) => {
  const m = text().match(re);
  assert.ok(m, label);
  return m.index;
};

test("release: runs on v* tags with OIDC and release-writing permissions, on Node 24", () => {
  assert.match(text(), /^on:\n\s+push:\n\s+tags: \["v\*"\]/m);
  assert.match(text(), /^permissions:\n\s+contents: write\n\s+id-token: write/m);
  assert.match(text(), /node-version: "24"/);
  assert.match(text(), /registry-url: "https:\/\/registry\.npmjs\.org"/);
});

test("release: the tag, package.json and manifest.json must carry one version", () => {
  const s = step("Check the tag matches both versions");
  assert.match(s, /require\("\.\/package\.json"\)\.version/);
  assert.match(s, /require\("\.\/skill-packs\/cross-review\/manifest\.json"\)\.version/);
  assert.match(s, /"v\$\{version\}" = "\$\{GITHUB_REF_NAME\}"/);
  assert.match(s, /"\$\{version\}" = "\$\{manifest\}"/);
});

test("release: checks, tests and the install check run before anything is packed or published", () => {
  const check = at(/- name: Check the tag matches both versions/, "version check");
  const deps = at(/npm ci --prefix skill-packs\/cross-review/, "runtime dependencies");
  const tests = at(/node test-default-timeout\.js && node test-stall-recovery\.js && node test-timeout-resume\.js && node --test "tests\/\*\.test\.js"/, "tests");
  const install = at(/node tests\/install-check\.mjs "\$H"/, "install check");
  const pack = at(/npm pack --ignore-scripts/, "pack");
  const publish = at(/- name: Publish to npm/, "publish");
  const release = at(/gh release create/, "GitHub release");
  assert.ok(check < deps && deps < tests && tests < install && install < pack && pack < publish && publish < release, "steps in order");
});

test("release: publishes once per version, by OIDC only", () => {
  const s = step("Publish to npm");
  assert.match(s, /if npm view "@tlelabs\/cross-review@\$\{version\}" version >\/dev\/null 2>&1; then/);
  assert.match(s, /npm publish "tlelabs-cross-review-\$\{version\}\.tgz" --access public --provenance/);
  assert.doesNotMatch(text(), /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./, "no npm token anywhere");
});
