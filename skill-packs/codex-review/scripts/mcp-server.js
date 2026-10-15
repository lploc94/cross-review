#!/usr/bin/env node
// MCP stdio server exposing the review verbs as typed tools:
// review_begin, review_wait, review_reply, review_end.
//
// Session state lives on disk under <working_dir>/.codex-review/sessions/ and Codex runs
// detached, so a review survives this server exiting; call review_wait again with the
// same session_dir to continue.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  SKILL_TEMPLATES,
  beginSession,
  endSession,
  replySession,
  waitSession,
} from "./lib/review-core.js";
import { DEFAULT_REVIEWER, REVIEWER_NAMES } from "./lib/reviewers/index.js";

// Codex allows 60 s per tool call by default (tool_timeout_sec); Claude Code allows far
// longer. The installer sets REVIEW_WAIT_DEFAULT_S per client at registration.
const FALLBACK_WAIT_S = 50;
const envWait = parseInt(process.env.REVIEW_WAIT_DEFAULT_S || "", 10);
const DEFAULT_WAIT_S = Number.isFinite(envWait) && envWait > 0 ? envWait : FALLBACK_WAIT_S;

const SKILLS = Object.keys(SKILL_TEMPLATES);

function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error) {
  const body = { error: error.message, code: error.code || "UNKNOWN_ERROR" };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

function tool(handler) {
  return async (args) => {
    try {
      const result = await handler(args);
      // review_end reports a failed finalize in `error` after still stopping the session
      if (result && result.error) return { ...ok(result), isError: true };
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  };
}

const INPUT_HELP = "Markdown with the skill's placeholder values: optional front-matter of `NAME: value` lines between `---` lines, then one `## NAME` section per multi-line value (e.g. `## USER_REQUEST`).";

// The tools never edit the project: they keep session state under .codex-review/ and run a
// reviewer told not to modify project files. Claude Code plan mode refuses MCP tools without this hint.
const ANNOTATIONS = { readOnlyHint: true };

function createServer() {
  const server = new McpServer({ name: "codex-review", version: "14.0.0" });

  server.registerTool("review_begin", {
    title: "Begin a Codex review",
    annotations: ANNOTATIONS,
    description: "Start a review session: render round 1 for the skill and launch Codex in the background. Returns session_dir; peer skills (think-about, commit-review, pr-review) also return analysis_prompt for the orchestrator's independent analysis.",
    inputSchema: {
      skill: z.enum(SKILLS),
      mode: z.string().optional().describe("impl-review: working-tree | branch; commit-review: staged | last"),
      input: z.string().describe(INPUT_HELP),
      working_dir: z.string().describe("Absolute path of the repository under review"),
      model: z.string().optional().describe("Codex model; omit to use the Codex default. Remembered for later rounds."),
      effort: z.string().optional().describe("Reasoning effort, default high. Remembered for later rounds."),
      timeout_seconds: z.number().int().positive().optional(),
      reviewer: z.enum(REVIEWER_NAMES).optional().describe(`Reviewer CLI, default ${DEFAULT_REVIEWER}. Remembered for later rounds.`),
    },
  }, tool(a => beginSession({
    skill: a.skill,
    mode: a.mode,
    inputText: a.input,
    workingDir: a.working_dir,
    model: a.model,
    effort: a.effort,
    timeout: a.timeout_seconds,
    reviewer: a.reviewer,
  })));

  server.registerTool("review_wait", {
    title: "Wait for the current review round",
    annotations: ANNOTATIONS,
    description: `Wait up to max_wait_seconds (default ${DEFAULT_WAIT_S}) for Codex. Returns the round status, parsed review, activities, and next: running (call again), respond (reply), cross_check (peer skills: compare with your analysis, then reply or end with an outcome), done (end), ask_user, or stopped.`,
    inputSchema: {
      session_dir: z.string(),
      max_wait_seconds: z.number().int().min(0).optional(),
    },
  }, tool(a => waitSession(a.session_dir, { maxWaitSeconds: a.max_wait_seconds ?? DEFAULT_WAIT_S })));

  server.registerTool("review_reply", {
    title: "Send the next review round",
    annotations: ANNOTATIONS,
    description: "Render the skill's next-round template from the input and resume the Codex thread. Model and effort default to the session's stored values.",
    inputSchema: {
      session_dir: z.string(),
      input: z.string().describe(INPUT_HELP),
      model: z.string().optional(),
      effort: z.string().optional(),
    },
  }, tool(a => replySession(a.session_dir, { inputText: a.input, model: a.model, effort: a.effort })));

  server.registerTool("review_end", {
    title: "End a review session",
    annotations: ANNOTATIONS,
    description: "Finalize (on a normal end) and stop the session. Peer skills pass outcome consensus or stalemate when their exit rule is met; otherwise the session is only stopped.",
    inputSchema: {
      session_dir: z.string(),
      outcome: z.enum(["consensus", "stalemate"]).optional(),
    },
  }, tool(a => endSession(a.session_dir, { outcome: a.outcome })));

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`codex-review MCP server failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
