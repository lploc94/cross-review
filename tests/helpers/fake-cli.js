// A fake command-line program for tests, written the way the platform installs real ones:
// POSIX gets an executable `#!/usr/bin/env node` file; Windows, which cannot run that, gets the
// script under node_modules plus an npm-style `<name>.cmd` shim the runtime resolves to node + script.
import fs from "node:fs";
import path from "node:path";

/** Writes the fake `name` (node source, CommonJS) into binDir; returns the file to put on PATH. */
export function writeFakeCli(binDir, name, source) {
  if (process.platform !== "win32") {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, source.startsWith("#!") ? source : `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
    return file;
  }
  const dir = path.join(binDir, "node_modules", `fake-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.js`), source);
  const shim = path.join(binDir, `${name}.cmd`);
  fs.writeFileSync(shim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    `node  "%dp0%\\node_modules\\fake-${name}\\${name}.js" %*`,
    "",
  ].join("\r\n"));
  return shim;
}
