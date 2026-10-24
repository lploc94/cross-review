#!/usr/bin/env node
/**
 * Builds the Production Reviewer System Prompts for `cross-review`:
 * 1. `production-reviewer-base.md` (Core Identity, Authority, Tool Orchestration, Spike & Web Verification, Signal Filter, Multi-Round)
 * 2. Compact Always-On Recon/Spike Tactics
 * 3. `skills/review-{impl,plan,pr,think}.system.md` (Skill-specific rubric & Output Format Contract)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_PROMPTS_DIR = path.resolve(__dirname, "../prompts");

export const REVIEW_SKILLS = ["review-impl", "review-plan", "review-pr", "review-think"];

export function buildAlwaysOnTactics() {
  return [
    "## 9. Always-On Core Tactics",
    "",
    "### 9.1. Always-On Universal Tactics (Use on Every Review)",
    "- **One-Shot Recon (`Turn 1`)**: Batch `git status --porcelain=v1 -uall`, `git diff`, reading any untracked (`??`) files, `CLAUDE.md`/`AGENTS.md`, and `rg -n` caller searches in a single parallel turn.",
    "- **Batched Edge-Case Hypothesis & Falsification Spike (`mktemp -d`)**:",
    "  Formulate 3–5 concrete edge-case hypotheses (empty/duplicate/oversized inputs, missing cold-start state, old-schema state upgrade, validate-before-normalize bypass, concurrent calls) and test them all in one self-cleaning run:",
    "  ```bash",
    '  ( tmp=$(mktemp -d); trap \'rm -rf "$tmp"\' EXIT; cat <<\'EOF\' > "$tmp/spike.mjs"',
    '  import * as target from "file:///ABS/PATH/TO/REPO/src/module.js";',
    "  // Hypothesis 1: What if state/data does not exist yet (cold start) or has old schema?",
    "  // Hypothesis 2: What if input has nested delimiters, trailing whitespace, or >100 items?",
    "  // Hypothesis 3: What if 2 concurrent calls race across await, or Step 2 fails after Step 1?",
    "  EOF",
    '  node "$tmp/spike.mjs" )',
    "  ```",
  ].join("\n");
}

export function compilePrompts({ promptsDir = DEFAULT_PROMPTS_DIR, quiet = false } = {}) {
  const base = fs.readFileSync(path.join(promptsDir, "production-reviewer-base.md"), "utf8").trim();
  const tactics = buildAlwaysOnTactics();

  fs.writeFileSync(path.join(promptsDir, "reviewer-system.md"), `${base}\n\n---\n\n${tactics}\n`, "utf8");

  const compiledDir = path.join(promptsDir, "compiled");
  fs.mkdirSync(compiledDir, { recursive: true });

  const outputs = {};
  for (const skill of REVIEW_SKILLS) {
    const skillMd = fs.readFileSync(path.join(promptsDir, "skills", `${skill}.system.md`), "utf8").trim();
    const compiled = `${base}\n\n---\n\n${tactics}\n\n---\n\n${skillMd}\n`;
    const outPath = path.join(compiledDir, `${skill}.compiled.md`);
    fs.writeFileSync(outPath, compiled, "utf8");
    outputs[skill] = outPath;
    if (!quiet) {
      console.log(
        `${skill}.compiled.md: ${compiled.split("\n").length} lines, ${compiled.length} bytes (~${Math.round(compiled.length / 4)} tokens)`
      );
    }
  }
  return outputs;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
  }
})();
if (isMain) {
  compilePrompts();
}
