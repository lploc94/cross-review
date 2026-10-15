// A review session as the dashboard tells it: state, title, the conversation between the
// reviewer and the agent, each issue's history, the step trail and the status sentences.
//
// readSession(dir) reads and parses the session's files (cacheable by size/mtime).
// classify(parsed, {now, isAlive}) adds everything that depends on the clock or on a live
// process; it is cheap and runs on every tick. Neither writes files or starts processes.

import fs from "node:fs";
import path from "node:path";

import { parseOutputMarkdown } from "../parse.js";
import { computeNext, defaultSkillsDir, isPeerSkill, parseReviewInput, placeholderNames } from "../review-core.js";
import { convergence, issueIds } from "../convergence.js";
import { getReviewer } from "../reviewers/index.js";
import { readLineTimes } from "../line-times.js";
import { attachTimes, humanize } from "./activity.js";

export const WARN_AFTER_S = 1200;
export const ACTIVE_WINDOW_S = 86400;
export const TITLE_MAX = 120;

export const LABELS = {
  approve: "approved",
  consensus: "consensus",
  stalemate: "stalemate",
  running: "reviewer working",
  waiting: "agent's turn",
  noReply: "no reply",
  resumable: "stopped, resumable",
  stopped: "stopped",
};

export const TEXT = {
  warn: "Waiting over 20 minutes — the agent may have stopped. Ask it to continue.",
  nowWaitingPeer: "The reviewer's position is in; the agent has not replied.",
  nowWaiting: "The reviewer's findings are in; the agent has not replied.",
  nowNoVerdict: "The round ended without a verdict; the agent has to ask you.",
  nowStarting: "Starting.",
  noTurn: "The reviewer exited before finishing its turn.",
};

const pad = n => String(n).padStart(3, "0");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function completeLines(text) {
  if (!text) return [];
  const lines = text.split("\n");
  lines.pop(); // the part after the last newline is incomplete (or empty)
  return lines;
}

const namesBySkill = new Map();
/** The skill's placeholder names, as the runner reads them; null when its prompts are missing. */
function skillNames(skill) {
  if (!namesBySkill.has(skill)) {
    let names = null;
    try {
      names = placeholderNames(defaultSkillsDir(skill), skill);
    } catch {}
    namesBySkill.set(skill, names);
  }
  return namesBySkill.get(skill);
}

/**
 * Placeholder values of a stored round input, split the way the runner split it: only the
 * skill's own placeholders start a section, so other `## HEADINGS` stay inside the value.
 * Without the skill's prompts, every `## NAME` and `NAME:` counts.
 */
export function inputValues(text, skill) {
  if (!text) return {};
  let names = skill ? skillNames(skill) : null;
  if (!names) {
    names = new Set();
    for (const m of text.matchAll(/^##[ \t]+([A-Z][A-Z_0-9]+)[ \t]*$/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^([A-Z][A-Z_0-9]+)[ \t]*:/gm)) names.add(m[1]);
  }
  return parseReviewInput(text, names);
}

/** `ISSUE-N: …` lines of FIXED_ITEMS / DISPUTED_ITEMS → [{id, text, location}]. */
export function parseAgentReply(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/ISSUE-(\d+)\b\s*:?\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    const loc = rest.match(/(?:^|[\s(`])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)/);
    out.push({ id: Number(m[1]), text: rest, location: loc ? loc[1] : null });
  }
  return out;
}

function cleanLocation(loc) {
  return loc ? String(loc).replace(/`/g, "").trim() : null;
}

// ---------- reading ----------

/**
 * Read one session directory. Returns null when it has no readable state.json.
 * Everything here depends only on file contents.
 */
export function readSession(dir) {
  const state = readJson(path.join(dir, "state.json"));
  if (!state || typeof state !== "object") return null;
  const id = path.basename(dir);
  const skill = state.skill_name || id.replace(/-\d{8}-\d{3}$/, "");
  const entries = readJson(path.join(dir, "rounds.json"));
  const roundEntries = Array.isArray(entries) ? entries : [];
  const n = Math.max(state.round || 0, roundEntries.length);
  let reviewer = null;
  try { reviewer = getReviewer(state.reviewer); } catch {}

  const rounds = [];
  for (let r = 1; r <= n; r++) {
    const live = r === n;
    const final = readJson(live ? path.join(dir, "final.txt") : path.join(dir, "outputs", `final-round-${pad(r)}.json`));
    const log = readText(live ? path.join(dir, "output.jsonl") : path.join(dir, "outputs", `output-round-${pad(r)}.jsonl`));
    const lines = completeLines(log);
    const entry = roundEntries.find(e => e.round === r) || {};
    const items = reviewer ? reviewer.activityItems(lines) : [];
    const timed = attachTimes(items, readLineTimes(dir, r), entry.started_at || null)
      .map(it => ({ ...it, ...humanize(it), key: `${r}:${it.id}`, round: r }));
    let outcome = null;
    if (live && !final && reviewer) {
      const ev = reviewer.parseEvents(lines, [], 0);
      outcome = { turnCompleted: ev.turnCompleted, turnFailed: ev.turnFailed, failMessage: ev.failMessage, reviewText: ev.reviewText, threadId: ev.threadId };
    }
    const lastTime = (() => {
      const rows = readLineTimes(dir, r);
      return rows.length ? rows[rows.length - 1][1] : null;
    })();
    rounds.push({
      round: r,
      entry,
      final,
      items: timed,
      outcome,
      lastTime,
      input: readText(path.join(dir, "inputs", `round-${pad(r)}.md`)),
      hasPrompt: fs.existsSync(path.join(dir, "prompts", `round-${pad(r)}.txt`)),
    });
  }
  return {
    dir,
    id,
    skill,
    peer: isPeerSkill(skill),
    state,
    meta: readJson(path.join(dir, "meta.json")),
    analysis: readText(path.join(dir, "analysis.md")),
    rounds,
  };
}

// ---------- classification ----------

function verdictOf(final) {
  const review = final && final.review;
  if (final && final.convergence && final.convergence.stalemate) return "STALEMATE";
  return (review && ((review.verdict && review.verdict.status) || review.suggested_status)) || null;
}

const VERDICT_KIND = { APPROVE: "approve", REVISE: "revise", CONSENSUS: "consensus", STALEMATE: "stalemate", CONTINUE: "revise" };

/** The round results with a reviewer that died unpolled resolved from its event log. */
function effectiveRounds(parsed, { isAlive }) {
  const { state, skill } = parsed;
  return parsed.rounds.map((r, i) => {
    const live = i === parsed.rounds.length - 1;
    let final = r.final;
    let running = false;
    if (live && !final && r.entry.status === "running") {
      if (isAlive(state.pid)) {
        running = true;
      } else if (r.outcome && r.outcome.turnCompleted) {
        const review = parseOutputMarkdown(r.outcome.reviewText, skill);
        final = { status: "completed", round: r.round, review, thread_id: r.outcome.threadId || null, synthesized: true };
        // What the runner's poll would add: stalemate when the same issues stay open twice
        const prev = i > 0 ? parsed.rounds[i - 1].entry : null;
        const c = prev ? convergence(prev.issue_ids, issueIds(review)) : null;
        if (c) final.convergence = c;
      } else {
        final = { status: "failed", round: r.round, error: (r.outcome && r.outcome.turnFailed && r.outcome.failMessage) || TEXT.noTurn, thread_id: (r.outcome && r.outcome.threadId) || null, synthesized: true };
      }
    }
    const status = running ? "running" : final ? final.status : (r.entry.status || "stopped");
    const startedAt = r.entry.started_at || null;
    const completedAt = r.entry.completed_at || (final && final.synthesized ? (r.lastTime || startedAt) : null);
    const secs = r.entry.elapsed_seconds ?? (completedAt && startedAt ? completedAt - startedAt : null);
    return { ...r, final, status, running, startedAt, completedAt, secs, review: final && final.status === "completed" ? final.review || null : null };
  });
}

function finalizedState(parsed, last) {
  const v = String((parsed.meta && parsed.meta.verdict) || "").toUpperCase();
  if (v === "APPROVE") return "approve";
  if (v === "CONSENSUS") return "consensus";
  if (v === "STALEMATE") return "stalemate";
  if (last && last.final && last.final.status === "completed"
    && computeNext(last.final, parsed.state).next_reason === "stalemate") return "stalemate";
  return "stopped";
}

/** Bucket, state and label of a session at `now` (Table 1 of the plan, first match wins). */
function sessionStatus(parsed, rounds, now) {
  const { state } = parsed;
  const last = rounds[rounds.length - 1];
  const threadId = state.thread_id || (last && last.final && last.final.thread_id) || null;
  const stopped = since => {
    const at = since || state.ended_at || state.created_at || now;
    const resumable = Boolean(threadId) && now - at <= ACTIVE_WINDOW_S;
    return { group: resumable ? "active" : "history", state: "stopped", label: resumable ? LABELS.resumable : LABELS.stopped, since: at, resumable };
  };
  if (parsed.meta) {
    const s = finalizedState(parsed, last);
    return { group: "history", state: s, label: LABELS[s], since: state.ended_at || (last && last.completedAt) || state.created_at };
  }
  if (!last) return { group: "history", state: "stopped", label: LABELS.stopped, since: state.created_at };
  if (last.running) return { group: "active", state: "running", label: LABELS.running, since: last.startedAt || state.started_at };
  if (last.final && last.final.status === "completed") {
    const next = computeNext(last.final, state);
    if (next.next === "done") {
      const s = next.next_reason === "approved" ? "approve" : "stalemate";
      return { group: "history", state: s, label: LABELS[s], since: last.completedAt };
    }
    if (state.ended_at) return { group: "history", state: "stopped", label: LABELS.stopped, since: state.ended_at, ended: true };
    const since = last.completedAt || state.created_at;
    if (now - since > ACTIVE_WINDOW_S) return { group: "history", state: "waiting", label: LABELS.noReply, since, noReply: true, next: next.next };
    return { group: "active", state: "waiting", label: LABELS.waiting, since, next: next.next };
  }
  return stopped(last.completedAt);
}

// ---------- story: who said what, and what it did to each issue ----------

function issueInfo(b) {
  return { id: b.id, title: b.title || "", severity: String(b.severity || "").toLowerCase() || null, location: cleanLocation(b.location || b.file) };
}

function replyFor(parsed, round) {
  const next = parsed.rounds[round]; // round r's reply is input r+1
  if (!next || !next.input) return null;
  const values = inputValues(next.input, parsed.skill);
  if (parsed.peer) {
    const sections = [
      ["Agreed", values.AGREED_POINTS],
      ["Disagreed", values.DISAGREED_POINTS],
      ["New", values.NEW_FINDINGS || values.NEW_PERSPECTIVES],
    ].filter(([, v]) => v && v.trim());
    return { peer: true, sections: sections.map(([name, md]) => ({ name, md })) };
  }
  return { peer: false, fixed: parseAgentReply(values.FIXED_ITEMS), disputed: parseAgentReply(values.DISPUTED_ITEMS) };
}

function buildStory(parsed, rounds) {
  const issues = new Map();
  const open = new Map(); // id → { agent: null|"fixed"|"disputed", closed }
  const story = [];
  for (const r of rounds) {
    if (r.review) {
      const blocks = Array.isArray(r.review.blocks) ? r.review.blocks.filter(b => b.prefix === "ISSUE" || b.prefix === undefined) : [];
      const ids = new Set(blocks.map(b => b.id));
      const stale = verdictOf(r.final) === "STALEMATE";
      const did = {};
      for (const b of blocks) {
        issues.set(b.id, { ...issueInfo(b), first: issues.get(b.id)?.first ?? r.round });
        const st = open.get(b.id);
        if (!st || st.closed) {
          did[b.id] = "raised";
          open.set(b.id, { agent: null, closed: false });
        } else {
          if (stale) did[b.id] = "stalemate";
          else if (st.agent === "disputed") did[b.id] = "maintained";
          else if (st.agent === "fixed") did[b.id] = "still open";
          st.agent = null;
        }
      }
      for (const [id, st] of open) {
        if (st.closed || ids.has(id)) continue;
        did[id] = st.agent === "fixed" ? "verified" : st.agent === "disputed" ? "withdrawn" : "closed";
        st.closed = true;
      }
      story.push({ who: "rv", round: r.round, did, stale, verdict: verdictOf(r.final) });
    } else if (!r.running && r.final) {
      story.push({ who: "rv", round: r.round, did: {}, failed: true });
    } else if (!r.running && r.status === "stopped" && r.completedAt) {
      story.push({ who: "rv", round: r.round, did: {}, failed: true });
    }
    const reply = replyFor(parsed, r.round);
    if (reply) {
      const did = {};
      if (!reply.peer) {
        for (const [kind, list] of [["fixed", reply.fixed], ["disputed", reply.disputed]]) {
          for (const x of list) {
            const st = open.get(x.id);
            if (!st || st.closed) continue;
            did[x.id] = kind;
            st.agent = kind;
          }
        }
      }
      story.push({ who: "ag", round: r.round, did, reply });
    }
  }
  return { story, issues, open };
}

const TERMINAL = new Set(["verified", "withdrawn", "closed"]);

function buildLedger(story, issues, pending) {
  const out = [];
  for (const [id, info] of [...issues.entries()].sort((a, b) => a[0] - b[0])) {
    const trail = story.filter(x => x.did[id]).map(x => x.did[id]);
    const last = trail[trail.length - 1];
    const item = { ...info, trail, pending: null };
    if (pending && last && !TERMINAL.has(last) && last !== "stalemate") item.pending = pending;
    out.push(item);
  }
  return out;
}

const NUM = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const num = (n, cap = true) => {
  const w = n <= 10 ? NUM[n] : String(n);
  return cap ? w : w.toLowerCase();
};
const plural = (n, one, many) => (n === 1 ? one : many);

function issueOutcomeSummary(ledger) {
  const counts = { fixed: 0, withdrawn: 0, closed: 0, open: 0 };
  for (const i of ledger) {
    const last = i.trail[i.trail.length - 1];
    if (last === "verified") counts.fixed++;
    else if (last === "withdrawn") counts.withdrawn++;
    else if (last === "closed") counts.closed++;
    else counts.open++;
  }
  return counts;
}

/** History "Issues" column: "none", "1, fixed", "7: 6 fixed, 1 withdrawn"; "—" without ISSUE blocks. */
function issuesColumn(ledger, peer) {
  if (!ledger.length) return peer ? "—" : "none";
  const c = issueOutcomeSummary(ledger);
  const parts = [["fixed", c.fixed], ["withdrawn", c.withdrawn], ["closed", c.closed], ["open", c.open]].filter(([, n]) => n);
  if (ledger.length === 1) return `1, ${parts[0][0]}`;
  return `${ledger.length}: ${parts.map(([k, n]) => `${n} ${k}`).join(", ")}`;
}

function stepLabel(x, peer) {
  if (x.who === "rv") {
    const raised = Object.values(x.did).filter(d => d === "raised").length;
    let text;
    if (x.failed) text = "stopped";
    else if (x.verdict === "APPROVE") text = "approved";
    else if (x.stale) text = "stalemate";
    else if (x.verdict === "CONSENSUS") text = "consensus";
    else if (raised) text = `${raised} new`;
    else if (peer) text = "replied";
    else text = "maintained";
    return { strong: `Round ${x.round}`, text };
  }
  if (x.reply && x.reply.peer) return { strong: null, text: "agent: replied" };
  const fixed = Object.values(x.did).filter(d => d === "fixed").length;
  const disputed = Object.values(x.did).filter(d => d === "disputed").length;
  const parts = [fixed && `${fixed} fixed`, disputed && `${disputed} disputed`].filter(Boolean);
  return { strong: null, text: `agent: ${parts.length ? parts.join(", ") : "replied"}` };
}

function stopReason(last, state) {
  const f = last && last.final;
  if (f && f.error) return String(f.error).replace(/\.$/, "");
  if (f && f.status === "timeout") return "the runner's time limit was reached";
  if (f && f.status === "stalled") return "the reviewer stopped producing output";
  if (state.end_outcome === "stopped" || (last && last.status === "stopped")) return "the agent ended the session";
  return "the reviewer did not finish";
}

function statusSentences(cls, ctx) {
  const { rounds, ledger, peer, story, state } = ctx;
  const last = rounds[rounds.length - 1];
  const R = last ? last.round : 0;
  const openIds = ledger.filter(i => i.pending || (!TERMINAL.has(i.trail[i.trail.length - 1]) && i.trail.length)).map(i => i.id);
  if (cls.state === "running") {
    return {
      what: R <= 1 ? "The reviewer is reviewing." : peer ? `The reviewer is answering the agent's reply to round ${R - 1}.` : `The reviewer is checking the agent's reply to round ${R - 1}.`,
      next: `Round ${R}, running {clock}. Its activity below updates as it works.`,
    };
  }
  if (cls.state === "approve") {
    const c = issueOutcomeSummary(ledger);
    const parts = [
      c.fixed && `${num(c.fixed, false)} fixed and confirmed`,
      c.withdrawn && `${num(c.withdrawn, false)} withdrawn by the reviewer after the agent disputed ${plural(c.withdrawn, "it", "them")}`,
      c.closed && `${num(c.closed, false)} closed`,
    ].filter(Boolean);
    return {
      what: `Approved in round ${R}.`,
      next: ledger.length ? `${num(ledger.length)} ${plural(ledger.length, "issue", "issues")}: ${parts.join(", ")}.` : "No issues were raised.",
    };
  }
  if (cls.state === "consensus") {
    return { what: `Consensus in round ${R}.`, next: "Both sides agree. Their positions are in the last messages." };
  }
  if (cls.state === "stalemate") {
    const ids = ledger.filter(i => i.trail[i.trail.length - 1] === "stalemate" || i.trail[i.trail.length - 1] === "maintained").map(i => `ISSUE-${i.id}`);
    return {
      what: ids.length ? `Stalemate on ${ids.join(", ")}. You decide.` : "Stalemate. You decide.",
      next: "Both sides held their positions for two rounds without new evidence. Their arguments are in the last messages.",
    };
  }
  if (cls.state === "waiting") {
    const mins = Math.max(1, Math.round((ctx.now - cls.since) / 60));
    if (cls.next === "ask_user") {
      return { what: `Round ${R} ended without a verdict. The agent has to ask you how to go on.`, next: `Waiting ${mins} min.` };
    }
    if (peer) {
      return {
        what: `The reviewer's position for round ${R} is in. The agent has to compare it with its own and reply.`,
        next: cls.noReply ? "No reply for over a day." : `Waiting ${mins} min.`,
      };
    }
    const k = openIds.length;
    const what = k
      ? `Round ${R} left ${num(k, false)} ${plural(k, "issue", "issues")} open. The agent has to fix or dispute ${plural(k, "it", "them")}.`
      : `Round ${R} needs the agent's reply.`;
    const fresh = R > 1 ? (story.filter(x => x.who === "rv" && x.round === R)[0]?.did || {}) : {};
    const newIds = Object.entries(fresh).filter(([, d]) => d === "raised").map(([id]) => `ISSUE-${id}`);
    const origin = newIds.length ? `${newIds.join(", ")} came from the round-${R - 1} fix. ` : "";
    return { what, next: cls.noReply ? `${origin}No reply for over a day.` : `${origin}Waiting ${mins} min.` };
  }
  // stopped
  if (cls.ended) return { what: `Ended in round ${R} without a final verdict.`, next: "The agent ended the session while the reviewer's findings were open." };
  const reason = stopReason(last, state);
  const hasThread = Boolean(state.thread_id || (last && last.final && last.final.thread_id));
  return {
    what: `Stopped in round ${R}: ${reason}.`,
    next: hasThread
      ? (cls.resumable
        ? "The reviewer's thread is kept. Ask the agent to resume this session; there is no need to start over."
        : "The reviewer's thread was kept, but the session has been stopped for over a day.")
      : "The reviewer had not started; start a new review.",
  };
}

function titleOf(parsed) {
  const first = parsed.rounds[0] && parsed.rounds[0].input;
  if (!first) return parsed.id;
  const v = inputValues(first, parsed.skill);
  let t = null;
  if (parsed.skill === "review-plan") t = v.PLAN_PATH ? path.basename(v.PLAN_PATH) : null;
  else if (parsed.skill === "review-think") t = v.QUESTION || null;
  else if (parsed.skill === "review-pr") t = v.PR_TITLE || v.HEAD_REF || null;
  else t = v.USER_REQUEST || null;
  if (!t) return parsed.id;
  const line = String(t).split("\n").map(s => s.trim()).find(Boolean) || parsed.id;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > TITLE_MAX / 2 ? cut.slice(0, sp) : cut) + "…";
}

function metaLine(parsed) {
  const v = inputValues(parsed.rounds[0] && parsed.rounds[0].input, parsed.skill);
  const mode = parsed.state.mode;
  if (parsed.skill === "review-impl") {
    if (mode === "branch") return { text: `${parsed.skill}, branch since`, code: v.BASE_BRANCH || null };
    return { text: `${parsed.skill}, working tree`, code: null };
  }
  if (parsed.skill === "review-pr" && (v.HEAD_REF || v.BASE_BRANCH)) return { text: `${parsed.skill}, into ${v.BASE_BRANCH || "?"} at`, code: v.HEAD_REF || null };
  return { text: parsed.skill, code: null };
}

function reviewMessage(r, peer) {
  const review = r.review || {};
  const v = verdictOf(r.final);
  const kind = VERDICT_KIND[v] || "revise";
  const blocks = Array.isArray(review.blocks) ? review.blocks : [];
  const reason = review.verdict && review.verdict.reason;
  return {
    who: "rv",
    round: r.round,
    kind: "review",
    verdict: { kind, label: v ? v.toLowerCase() : "no verdict" },
    secs: r.secs,
    reasonMd: !peer && blocks.length ? reason || null : null,
    // Peer reviews and reviews without ISSUE blocks are shown as written
    rawMd: peer || !blocks.length ? review.raw_markdown || null : null,
    issues: peer ? [] : blocks.map(b => ({
      ...issueInfo(b),
      rows: [["Problem", b.problem], ["Evidence", b.evidence], ["Why it matters", b.why_it_matters], ["Suggested fix", b.suggested_fix]].filter(([, x]) => x),
    })),
    activityCount: r.items.length,
    hasPrompt: r.hasPrompt,
  };
}

/**
 * Everything about a session that depends on the clock or on live processes.
 * Returns { summary, detail }.
 */
export function classify(parsed, { now = Math.floor(Date.now() / 1000), isAlive = () => false } = {}) {
  const { state, peer } = parsed;
  const rounds = effectiveRounds(parsed, { isAlive });
  const cls = sessionStatus(parsed, rounds, now);
  const { story, issues } = buildStory(parsed, rounds);
  const pending = cls.state === "running" ? "checking now"
    : cls.state === "waiting" && cls.group === "active" ? "agent's turn"
      : cls.state === "stopped" && !cls.ended ? "not checked" : null;
  const ledger = buildLedger(story, issues, pending);
  const last = rounds[rounds.length - 1];
  const title = titleOf(parsed);
  const sentences = statusSentences(cls, { rounds, ledger, peer, story, state, now });
  const warn = cls.state === "waiting" && cls.group === "active" && now - cls.since > WARN_AFTER_S ? TEXT.warn : null;

  let nowText = null;
  if (cls.group === "active") {
    if (cls.state === "running") {
      const items = last ? last.items : [];
      nowText = items.length ? items[items.length - 1].text : TEXT.nowStarting;
    } else if (cls.state === "waiting") {
      nowText = cls.next === "ask_user" ? TEXT.nowNoVerdict : peer ? TEXT.nowWaitingPeer : TEXT.nowWaiting;
    } else {
      nowText = sentences.what.replace(/^Stopped in round \d+: /, "").replace(/^./, c => c.toUpperCase());
    }
  }

  const reviewerSeconds = rounds.reduce((t, r) => t + (r.running ? 0 : r.secs || 0), 0);
  const summary = {
    id: parsed.id,
    skill: parsed.skill,
    mode: state.mode || null,
    title,
    group: cls.group,
    state: cls.state,
    label: cls.label,
    since: cls.since || null,
    warn,
    now: nowText,
    round: last ? last.round : 0,
    rounds: rounds.length,
    issues: issuesColumn(ledger, peer),
    model: state.model || null,
    reviewer: state.reviewer || "codex",
    reviewerSeconds,
    running: cls.state === "running",
    createdAt: state.created_at || null,
    searchText: [title, ...ledger.flatMap(i => [i.title, i.location || ""])].join("\n").toLowerCase(),
  };

  // Steps and thread share anchors: story index i ↔ message s<i>
  const steps = story.map((x, i) => ({ ...stepLabel(x, peer), who: x.who, jump: `s${i}` }));
  if (cls.state === "running") steps.push({ strong: `Round ${last.round}`, text: "in progress", who: "tail", tone: "running", jump: "s-live" });
  else if (cls.state === "waiting" && cls.group === "active") steps.push({ strong: null, text: "agent's turn", who: "tail", tone: "waiting", jump: null });

  const thread = [];
  const v1 = inputValues(parsed.rounds[0] && parsed.rounds[0].input, parsed.skill);
  const ask = parsed.skill === "review-think" ? v1.QUESTION : v1.USER_REQUEST;
  if (ask && ask.trim()) thread.push({ who: "us", kind: "ask", md: ask.trim() });
  story.forEach((x, i) => {
    const r = rounds.find(y => y.round === x.round);
    if (x.who === "rv") {
      if (x.failed) {
        thread.push({ who: "rv", round: x.round, kind: "stopped", anchor: `s${i}`, secs: r.secs, error: stopReason(r, state), activityCount: r.items.length, hasPrompt: r.hasPrompt });
      } else {
        thread.push({ ...reviewMessage(r, peer), anchor: `s${i}` });
      }
      if (peer && x.round === 1 && parsed.analysis) thread.push({ who: "ag", kind: "analysis", md: parsed.analysis.trim() });
    } else {
      thread.push({ who: "ag", round: x.round, kind: "reply", anchor: `s${i}`, reply: x.reply });
    }
  });
  if (cls.state === "running") {
    thread.push({ who: "rv", round: last.round, kind: "running", anchor: "s-live", startedAt: last.startedAt, activityCount: last.items.length, hasPrompt: last.hasPrompt });
  }

  const meta = metaLine(parsed);
  const detail = {
    ...summary,
    meta,
    status: { state: cls.state, what: sentences.what, next: sentences.next },
    steps,
    thread,
    ledger,
    facts: {
      reviewer: state.reviewer || "codex",
      model: state.model || null,
      effort: state.effort || null,
      sources: state.settings_sources || null,
      caller: state.caller || null,
      reviewerSeconds,
      startedAt: state.created_at || null,
      runningSince: cls.state === "running" ? last.startedAt : null,
    },
    currentRound: last ? last.round : 0,
    roundStartedAt: last ? last.startedAt : null,
  };
  return { summary, detail };
}

/** Activity of one round, newest last: { items, total }. Items carry key, line, t and the humanized text. */
export function roundActivity(parsed, round) {
  const r = parsed.rounds.find(x => x.round === round);
  return r ? { items: r.items, total: r.items.length } : null;
}
