import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable, parseNpmShim, programOf, resolveSpawn } from "../skill-packs/cross-review/scripts/lib/command.js";

const IS_WIN = process.platform === "win32";
const WINDOWS_ONLY = { skip: !IS_WIN && "Windows resolution" };
const POSIX_ONLY = { skip: IS_WIN && "POSIX resolution" };

// The shim texts npm writes for a node script (codex) and for a native binary (claude)
const NODE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@acme\\tool\\bin\\tool.js\" %*",
].join("\r\n");
const EXE_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
  "\"%dp0%\\node_modules\\@acme\\other\\bin\\other.exe\"   %*",
].join("\r\n");
// npm.cmd itself is a batch file, not a shim
const BATCH = [
  ":: Created by npm, please don't edit manually.", "@ECHO OFF", "SETLOCAL",
  "SET \"NODE_EXE=%~dp0\\node.exe\"", "SET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"",
  "\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*",
].join("\r\n");

test("parseNpmShim: the target of a node-script shim and of a binary shim; null for other batch files", () => {
  assert.equal(parseNpmShim(NODE_SHIM), "node_modules\\@acme\\tool\\bin\\tool.js");
  assert.equal(parseNpmShim(EXE_SHIM), "node_modules\\@acme\\other\\bin\\other.exe");
  assert.equal(parseNpmShim("@\"%~dp0\\node_modules\\old\\cli.js\" %*"), "node_modules\\old\\cli.js");
  assert.equal(parseNpmShim(BATCH), null);
  assert.equal(parseNpmShim(""), null);
});

test("programOf: the program's lower-cased name and its arguments, quotes kept together, a node host skipped", () => {
  assert.deepEqual(programOf("\"C:\\Program Files\\Acme\\Tool.EXE\" -p --output-format stream-json"),
    { program: "tool.exe", words: ["-p", "--output-format", "stream-json"] });
  assert.deepEqual(programOf("C:\\tools\\tool.exe exec \"a b\""), { program: "tool.exe", words: ["exec", "a b"] });
  assert.deepEqual(programOf("\"C:\\Program Files\\nodejs\\node.exe\" C:\\t\\node_modules\\fake\\tool.js exec --json"),
    { program: "tool.js", words: ["exec", "--json"] });
  assert.deepEqual(programOf("node --no-warnings /x/bin/tool exec"), { program: "tool", words: ["exec"] });
  assert.deepEqual(programOf("/opt/homebrew/bin/node /opt/homebrew/bin/tool --print= stream-json"),
    { program: "tool", words: ["--print=", "stream-json"] });
  assert.deepEqual(programOf("/usr/bin/vim tool.md"), { program: "vim", words: ["tool.md"] });
  assert.deepEqual(programOf("  "), { program: "", words: [] });
});

test("POSIX: resolveSpawn keeps the name; commandAvailable asks which", POSIX_ONLY, () => {
  assert.deepEqual(resolveSpawn("codex", ["exec", "-"]), { cmd: "codex", args: ["exec", "-"] });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "command-posix-"));
  try {
    fs.writeFileSync(path.join(bin, "acme-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    assert.equal(commandAvailable("acme-tool", { env }), true);
    assert.equal(commandAvailable("acme-tool"), false);
    assert.equal(commandAvailable("acme-tool-missing", { env }), false);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

/** A temp bin folder with the env that puts only it on PATH, the key spelled `Path` as Windows does. */
function winBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "command-win-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "PATH") delete env[k];
  env.Path = bin;
  return { bin, env };
}

test("Windows: an npm shim to a node script runs as node + script", WINDOWS_ONLY, () => {
  const { bin, env } = winBin();
  try {
    fs.writeFileSync(path.join(bin, "tool.cmd"), NODE_SHIM);
    const script = path.join(bin, "node_modules", "@acme", "tool", "bin", "tool.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    assert.deepEqual(resolveSpawn("tool", ["exec", "a b"], { env }), { cmd: process.execPath, args: [script, "exec", "a b"] });
    assert.equal(commandAvailable("tool", { env }), true);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("Windows: an npm shim to a binary runs the binary; an .exe on PATH runs directly", WINDOWS_ONLY, () => {
  const { bin, env } = winBin();
  try {
    fs.writeFileSync(path.join(bin, "other.cmd"), EXE_SHIM);
    const exe = path.join(bin, "node_modules", "@acme", "other", "bin", "other.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), exe);
    assert.deepEqual(resolveSpawn("other", ["-p"], { env }), { cmd: exe, args: ["-p"] });
    assert.equal(commandAvailable("other", { env }), true);
    fs.copyFileSync(exe, path.join(bin, "direct.exe"));
    assert.deepEqual(resolveSpawn("direct", ["x"], { env }), { cmd: path.join(bin, "direct.exe"), args: ["x"] });
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("Windows: a batch file that is not a shim runs through cmd only when allowed, never with quotes or % in its arguments", WINDOWS_ONLY, () => {
  const { bin, env } = winBin();
  try {
    const file = path.join(bin, "batch.cmd");
    fs.writeFileSync(file, BATCH);
    assert.deepEqual(resolveSpawn("batch", ["prefix", "-g"], { env }), { cmd: "batch", args: ["prefix", "-g"] });
    assert.equal(commandAvailable("batch", { env }), false);
    const viaCmd = resolveSpawn("batch", ["prefix", "-g"], { env, allowCmdShell: true });
    assert.deepEqual(viaCmd, {
      cmd: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `""${file}" "prefix" "-g""`],
      windowsVerbatimArguments: true,
    });
    assert.equal(commandAvailable("batch", { env, allowCmdShell: true }), true);
    // a path is that file only, PATH aside
    assert.deepEqual(resolveSpawn(file, ["x"], { env: { ...env, Path: "" }, allowCmdShell: true }).args.at(-1), `""${file}" "x""`);
    for (const bad of ["a\"b", "100%"]) {
      assert.deepEqual(resolveSpawn("batch", [bad], { env, allowCmdShell: true }), { cmd: "batch", args: [bad] });
    }
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("Windows: an extensionless script alone, or nothing at all, is not a command", WINDOWS_ONLY, () => {
  const { bin, env } = winBin();
  try {
    fs.writeFileSync(path.join(bin, "tool"), "#!/bin/sh\nexit 0\n");
    assert.deepEqual(resolveSpawn("tool", ["x"], { env }), { cmd: "tool", args: ["x"] });
    assert.equal(commandAvailable("tool", { env }), false);
    assert.equal(commandAvailable("missing", { env }), false);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
