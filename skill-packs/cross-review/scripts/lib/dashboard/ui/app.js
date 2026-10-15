// The dashboard page: hash routes, the Sessions view (live "In progress" and filtered
// History), the session page (status, steps, conversation, issues, live activity) and the
// header. Each view has at most one stream open; clocks tick here, against the server's clock.

import { ic } from "./icons.js";
import { esc, renderField, renderInline, renderMarkdown } from "./markdown.js";
import { PAGE, applyPage, groupReads, mergeActivity, newFeed, onSnapshot, visible } from "./feed.js";
import { OTHER, SKILLS, effortOptions, inheritedValue, mergeForm, modelOptions, resolveHere } from "./settings.js";

const $ = sel => document.querySelector(sel);
/** Escaped text with `code` spans, as titles quote file names that way. */
const inline = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const clock = s => {
  s = Math.max(0, Math.floor(s));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const st = (kind, label) => `<span class="st ${esc(kind)}">${ic(kind)}${esc(label)}</span>`;
const skillIc = skill => `<span class="skill" title="${esc(skill)}">${ic(skill)}</span>`;
const REVIEWERS = { codex: "Codex" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let data = null;
let stream = null; // this tab's one EventSource
let streamUrl = null;
let view = null; // the open session page
let skew = 0; // server clock minus this clock, in seconds
const nowS = () => Date.now() / 1000 + skew;

// ---------- routes ----------

export function parseRoute(hash) {
  const parts = String(hash || "").replace(/^#\/?/, "").split("/");
  if (parts.length === 1 && parts[0] === "") return { view: "sessions" };
  if (parts[0] === "s" && (parts.length === 3 || (parts.length === 4 && /^ISSUE-\d+$/.test(parts[3]))) && parts[1] && parts[2]) {
    try {
      return { view: "detail", ws: decodeURIComponent(parts[1]), id: parts[2], issue: parts[3] || null };
    } catch {
      return null;
    }
  }
  if (parts[0] === "settings" && parts.length <= 2) {
    try {
      return { view: "settings", ws: parts[1] ? decodeURIComponent(parts[1]) : null };
    } catch {
      return null;
    }
  }
  return null;
}

export const sessionHref = (ws, id) => `#/s/${encodeURIComponent(ws)}/${id}`;

function route() {
  const r = parseRoute(location.hash);
  if (!r) {
    location.replace("#/");
    return;
  }
  const same = r.view === "detail" && view && view.ws === r.ws && view.id === r.id;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === r.view));
  // a session's page lights the Sessions tab
  const tab = r.view === "settings" ? "settings" : "sessions";
  document.querySelectorAll(".top nav a").forEach(a => a.classList.toggle("on", a.dataset.nav === tab));
  if (r.view === "detail") {
    if (same) {
      if (r.issue) flashIssue(r.issue.slice(6));
      return;
    }
    window.scrollTo(0, 0);
    return openDetail(r);
  }
  view = null;
  window.scrollTo(0, 0);
  if (r.view === "sessions") {
    // the page size depends on the visible layout
    if (data) renderHistory();
    connect("/api/stream?view=list", { sessions: e => apply(JSON.parse(e.data)) });
  }
  else connect(null);
  if (r.view === "settings") openSettings(r);
}

/** Open `url` as the tab's stream, closing the one before; null closes it. */
function connect(url, handlers = {}) {
  if (url && url === streamUrl) return;
  if (stream) stream.close();
  stream = null;
  streamUrl = url;
  if (!url) return;
  stream = new EventSource(url);
  for (const [name, fn] of Object.entries(handlers)) stream.addEventListener(name, fn);
}

const getJson = async url => {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

// ---------- header ----------

function renderWhere() {
  const n = data.workspaces.length;
  const where = $("#where");
  where.textContent = where.title = [
    data.rootDisplay,
    `scanned ${data.depth} levels down`,
    `${n} ${n === 1 ? "workspace" : "workspaces"}`,
    data.version ? `pack ${data.version}` : null,
  ].filter(Boolean).join(" · ");
}

// ---------- Sessions ----------

function when(epoch) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const today = new Date(nowS() * 1000);
  const day = x => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(today)) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day(d) === day(yesterday)) return "yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === today.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

const modelOf = s => s.model || `${REVIEWERS[s.reviewer] || s.reviewer} default`;

function activeRow(s) {
  const where = `${s.wsName} · ${s.skill} · round ${s.round}${s.state === "waiting" ? " returned" : ""}`;
  return `<tr data-go="${esc(sessionHref(s.ws, s.id))}"><td>${st(s.state, s.label)}</td>
    <td class="clip" title="${esc(`${s.title}\n${where}`)}">${skillIc(s.skill)}${inline(s.title)}<div class="line2">${esc(where)}</div></td>
    <td class="soft clip" title="${esc(s.now)}">${esc(s.now)}${s.warn ? `<div class="warn with-i">${ic("warn")}${esc(s.warn)}</div>` : ""}</td>
    <td class="num mono" data-since="${Number(s.since) || 0}">${clock(nowS() - s.since)}</td></tr>`;
}

function historyRow(s) {
  return `<tr data-go="${esc(sessionHref(s.ws, s.id))}"><td>${st(s.state, s.label)}</td>
    <td>${skillIc(s.skill)}${inline(s.title)}<div class="line2">${esc(`${s.wsName} · ${s.skill}`)}</div></td>
    <td class="num">${s.rounds}</td><td class="soft">${esc(s.issues)}</td><td class="soft nw">${esc(modelOf(s))}</td>
    <td class="num mono nw">${s.reviewerSeconds ? clock(s.reviewerSeconds) : "—"}</td><td class="num line2 nw">${esc(when(s.createdAt))}</td></tr>`;
}

const EMPTY_ACTIVE = `<tr class="empty"><td colspan="4"><div class="empty-state">
  <img src="avatars/reviewer-full.png" alt=""><img src="avatars/agent-full.png" alt=""><span>Nothing in progress.</span></div></td></tr>`;

function renderFilters() {
  const sel = $("#f-ws");
  const keep = sel.value;
  sel.innerHTML = `<option value="">All workspaces</option>` +
    data.workspaces.map(w => `<option value="${esc(w.ws)}" title="${esc(w.path)}">${esc(w.name)}</option>`).join("");
  sel.value = data.workspaces.some(w => w.ws === keep) ? keep : "";
}

// History pages (user decision 2026-10-15): from `offset`, as many rows as fit in the window
// with the pager under them, so the Sessions page does not scroll; at least HISTORY_MIN_ROWS.
// Rows wrap differently, so the page is measured on the rows it shows. "Older" moves the
// offset past the rows shown; "Newer" goes back to the offset before.
const HISTORY_MIN_ROWS = 3;
const HISTORY_MAX_ROWS = 100; // more rows than any window holds; bounds the rows laid out to measure
const hist = { offset: 0, back: [] };

function filteredHistory() {
  const ws = $("#f-ws").value;
  const skill = $("#f-skill").value;
  const result = $("#f-result").value;
  const q = $("#f-search").value.trim().toLowerCase();
  return data.history.filter(s => (!ws || s.ws === ws) && (!skill || s.skill === skill) && (!result || s.label === result)
    && (!q || s.searchText.includes(q) || s.wsName.toLowerCase().includes(q) || s.id.includes(q)));
}

function paintHistory(rows, count, pager) {
  const shown = rows.slice(hist.offset, hist.offset + count);
  $("#history").innerHTML = shown.length ? shown.map(historyRow).join("")
    : `<tr class="empty"><td colspan="7" class="soft">${data.history.length ? "No session matches." : "No finished sessions yet."}</td></tr>`;
  $("#h-pager").innerHTML = pager
    ? `<a data-hpage="-1"${hist.offset === 0 ? ' class="off"' : ""}>‹ Newer</a><span>${hist.offset + 1}–${hist.offset + shown.length} of ${rows.length}</span><a data-hpage="1"${hist.offset + shown.length >= rows.length ? ' class="off"' : ""}>Older ›</a>`
    : "";
  hist.shown = shown.length;
}

function renderHistory() {
  const rows = filteredHistory();
  hist.offset = Math.max(0, Math.min(hist.offset, rows.length - 1));
  const left = rows.length - hist.offset;
  if (!$("#sessions").classList.contains("on")) {
    // hidden: nothing to measure; the route renders again when it shows
    paintHistory(rows, Math.min(left, 10), rows.length > 10);
    return;
  }
  // Lay out the candidates with the pager, then keep the rows that end above the pager's place
  paintHistory(rows, Math.min(left, HISTORY_MAX_ROWS), true);
  const pager = $("#h-pager");
  const main = pager.closest("main");
  const budget = window.innerHeight - (parseFloat(getComputedStyle(main).paddingBottom) || 0)
    - pager.getBoundingClientRect().height - (parseFloat(getComputedStyle(pager).marginTop) || 0);
  let fit = 0;
  for (const row of $("#history").querySelectorAll("tr[data-go]")) {
    if (row.getBoundingClientRect().bottom + window.scrollY > budget) break;
    fit++;
  }
  fit = Math.max(Math.min(HISTORY_MIN_ROWS, left), fit);
  // everything from the first row fits: no pager
  paintHistory(rows, fit, !(hist.offset === 0 && fit >= left));
}

function renderSessions() {
  $("#active").innerHTML = data.active.length ? data.active.map(activeRow).join("") : EMPTY_ACTIVE;
  renderFilters();
  renderHistory();
}

function tickClocks() {
  const t = nowS();
  document.querySelectorAll("[data-since]").forEach(el => { el.textContent = clock(t - Number(el.dataset.since)); });
}

// ---------- session page ----------

const AVATAR = { rv: "avatars/reviewer.png", ag: "avatars/agent.png", us: "avatars/you.png" };
const NAME = { rv: "Reviewer", ag: "Agent", us: "You" };
const REVIEWER_LETTERS = { codex: "CX" };
const CALLER_LETTERS = { "claude-code": "CC", "codex-mcp-client": "CX" };

/** Letters (the image's alt and fallback) and tooltip of each side. */
function party(who, d) {
  if (who === "us") return { letters: "Y", tip: "You" };
  if (who === "rv") {
    const r = d.facts.reviewer;
    return { letters: REVIEWER_LETTERS[r] || r.slice(0, 2).toUpperCase(), tip: REVIEWERS[r] || r };
  }
  const c = d.facts.caller || {};
  return { letters: CALLER_LETTERS[c.name] || initial(c.title), tip: (c.title || "").trim() || "Agent" };
}

/** An agent's letter: the first character of its title, else "AG" (no title, or a blank one). */
const initial = title => String(title || "").trim().charAt(0).toUpperCase() || "AG";

/** The avatars key of each side: the user's image when one is uploaded. */
function partyKey(who, d) {
  if (who === "us") return "you";
  if (who === "rv") return `reviewer:${d.facts.reviewer}`;
  return `agent:${(d.facts.caller && normalCaller(d.facts.caller.name)) || "unknown"}`;
}

const mark = (who, d) => {
  const p = party(who, d);
  return `<div class="mark ${who}" title="${esc(p.tip)}"><img src="${avatarSrc(who, partyKey(who, d))}" alt="${esc(p.letters)}"></div>`;
};

const msg = (d, who, head, body, anchor) => `<div class="m ${who === "rv" ? "" : "r"} ${who === "us" ? "us" : ""}"${anchor ? ` id="${esc(anchor)}"` : ""}>
  ${mark(who, d)}<div class="bubble"><div class="who"><b>${NAME[who]}</b>${head}</div>${body}</div></div>`;

const roundLabel = n => `<div class="round-label">ROUND ${Number(n)}</div>`;

const LOCATION = /((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)/g;
/** Inline markdown with file:line references set in mono (outside tags only). */
const withLocations = text => renderInline(text).split(/(<[^>]+>)/)
  .map(part => (part.startsWith("<") ? part : part.replace(LOCATION, '<span class="mono">$1</span>'))).join("");

function finding(i) {
  const sev = i.severity ? `<span class="sev ${esc(i.severity)}">${esc(i.severity)}</span>` : "";
  const rows = (i.location ? `<dt>Where</dt><dd class="mono">${esc(i.location)}</dd>` : "")
    + i.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${renderField(v)}</dd>`).join("");
  return `<div class="finding" data-issue="${Number(i.id)}"><div class="t">ISSUE-${Number(i.id)} ${renderInline(i.title)}${sev}</div>${rows ? `<dl>${rows}</dl>` : ""}</div>`;
}

function foot(x) {
  const links = [
    x.activityCount ? `<a data-past="${Number(x.round)}">activity (${Number(x.activityCount)})</a>` : "",
    x.hasPrompt ? `<a data-prompt="${Number(x.round)}">prompt sent</a>` : "",
  ].filter(Boolean);
  if (!links.length) return "";
  return `<div class="foot">${links.join(" · ")}</div><div class="past" id="past-${Number(x.round)}"></div><div class="past" id="promptbox-${Number(x.round)}"></div>`;
}

function replyBody(reply) {
  if (!reply) return "";
  if (reply.peer) {
    return reply.sections.length
      ? reply.sections.map(s => `<div class="reply-sec"><span class="k">${esc(s.name)}</span>${renderMarkdown(s.md)}</div>`).join("")
      : "<p>Replied.</p>";
  }
  const lines = [
    ...reply.fixed.map(x => `<div class="reply-line"><span class="k fixed">Fixed</span>ISSUE-${Number(x.id)} — ${withLocations(x.text)}</div>`),
    ...reply.disputed.map(x => `<div class="reply-line"><span class="k disputed">Disputed</span>ISSUE-${Number(x.id)} — ${withLocations(x.text)}</div>`),
  ];
  return lines.length ? lines.join("") : "<p>Replied without ISSUE lines.</p>";
}

/** The running round's first line: what the reviewer is looking at. */
function runningLine(d) {
  if (d.currentRound <= 1) return "Reviewing.";
  const reply = [...d.thread].reverse().find(x => x.kind === "reply");
  if (reply && reply.reply && !reply.reply.peer) {
    const ids = [...reply.reply.fixed, ...reply.reply.disputed].map(x => `ISSUE-${x.id}`);
    if (ids.length) return `Checking the reply to ${ids.join(", ")}.`;
  }
  return "Reading the agent's reply.";
}

function messageHtml(d, x) {
  if (x.kind === "ask") return msg(d, "us", "<span>asked the agent</span>", renderMarkdown(x.md));
  if (x.kind === "analysis") return msg(d, "ag", "<span>independent analysis</span>", renderMarkdown(x.md));
  if (x.kind === "reply") return msg(d, "ag", "<span>reply</span>", replyBody(x.reply), x.anchor);
  if (x.kind === "review") {
    const body = (x.reasonMd ? renderMarkdown(x.reasonMd) : "") + x.issues.map(finding).join("") + (x.rawMd ? renderMarkdown(x.rawMd) : "");
    return msg(d, "rv", `${st(x.verdict.kind, x.verdict.label)}<span>${x.secs != null ? clock(x.secs) : ""}</span>`, body + foot(x), x.anchor);
  }
  if (x.kind === "stopped") {
    const why = x.failed ? `The turn failed: <span class="mono">${esc(x.error)}.</span>` : `Stopped: ${esc(x.error)}.`;
    return msg(d, "rv", `${st("stopped", "stopped")}<span>${x.secs != null ? clock(x.secs) : ""}</span>`, `<p>${why}</p>${foot(x)}`, x.anchor);
  }
  if (x.kind === "running") {
    return msg(d, "rv", `${st("running", "working")}<span class="run-clock" data-since="${Number(x.startedAt) || 0}"></span>`,
      `${esc(runningLine(d))}<div class="acts" id="acts"></div><div class="actbar"><a id="earlier"></a><span id="act-count"></span></div>`, "s-live");
  }
  return "";
}

/**
 * The conversation in reverse, newest message on top (user decision 2026-10-15). A round is
 * the message that opened it (the user's ask, or the agent's reply) and what the reviewer
 * answered; each round's label sits above its messages, the reviewer's newest first.
 */
export function roundGroups(thread) {
  const groups = [];
  for (const x of thread) {
    if (x.kind === "ask" || x.kind === "reply" || !groups.length) groups.push({ round: null, items: [] });
    const g = groups[groups.length - 1];
    if (g.round === null && x.round != null && x.who === "rv") g.round = x.round;
    g.items.unshift(x);
  }
  return groups.reverse();
}

function threadHtml(d) {
  return roundGroups(d.thread)
    .map(g => (g.round != null ? roundLabel(g.round) : "") + g.items.map(x => messageHtml(d, x)).join(""))
    .join("");
}

function ledgerHtml(d) {
  return d.ledger.map(i => {
    const trail = [...i.trail.map(esc), ...(i.pending ? [`<b>${esc(i.pending)}</b>`] : [])].join(" <i>→</i> ");
    const sev = i.severity ? `<span class="sev ${esc(i.severity)}">${esc(i.severity)}</span>` : "";
    return `<div class="iss" data-issue-go="${Number(i.id)}"><div class="it">ISSUE-${Number(i.id)}${sev}</div>
      <div>${renderInline(i.title)}</div>${i.location ? `<div class="loc">${esc(i.location)}</div>` : ""}<div class="trail">${trail}</div></div>`;
  }).join("");
}

function started(epoch) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderFacts(d) {
  const f = d.facts;
  const reviewer = REVIEWERS[f.reviewer] || f.reviewer;
  $("#f-reviewer").textContent = reviewer;
  const fallback = catalogInfo.codexDefault ? `${modelName(catalogInfo.codexDefault, catalogInfo.models)} · ${reviewer} default` : `${reviewer} default`;
  $("#f-model").textContent = f.model ? modelName(f.model, catalogInfo.models) : fallback;
  const src = f.sources && f.sources.effort ? String(f.sources.effort).split(":").join(", ") : null;
  $("#f-effort").textContent = f.effort ? `${f.effort}${src ? ` · ${src}` : ""}` : "—";
  $("#f-caller").textContent = (f.caller && f.caller.title) || "Agent";
  $("#f-time").textContent = clock(f.reviewerSeconds || 0) + (f.runningSince ? " + running" : "");
  $("#f-started").textContent = started(f.startedAt);
}

// ----- activity lines -----

function actLine(g) {
  const a = g.items[0];
  const code = s => `<span class="mono">${esc(s)}</span>`;
  if (g.kind === "read" && g.items.length > 1) return `Read ${g.items.length} files: ${g.items.map(x => code(x.what)).join(", ")}`;
  switch (g.kind) {
    case "think": return `<span class="think">Thinking: <i>${esc(a.what)}</i></span>`;
    case "test": return `Ran tests — ${a.failed ? `<span class="bad">${esc(a.result)}</span>` : esc(a.result)}`;
    case "read": return `Read ${code(a.what)}`;
    case "search": return `Searched for ${code(a.what)}`;
    case "diff": return `Looked at the change in ${code(a.what)}`;
    case "scratch": return "Worked in a scratch dir";
    case "run": return `Ran ${code(a.what)}`;
    case "tool": return `Used ${code(a.what)}`;
    case "change": return `Changed ${code(a.what)}`;
    default: return esc(a.text);
  }
}

/** Activity lines, newest first (user decision 2026-10-15); reads are folded in log order first. */
function actsHtml(items, opened, fresh) {
  return groupReads(items).reverse().map(g => {
    const key = g.items[0].key;
    const raws = g.items.map(x => x.raw).filter(Boolean);
    const cls = ["act", opened.has(key) ? "open" : "", g.items.some(x => fresh.has(x.key)) ? "new" : ""].filter(Boolean).join(" ");
    const t = g.items[0].t;
    return `<div class="${cls}" data-act="${esc(key)}" data-n="${g.items.length}"${raws.length ? " data-raw" : ""}><span class="tm">${t != null ? clock(t) : ""}</span><span class="ai">${ic(g.kind)}</span>
      <span>${actLine(g)}</span>${raws.length ? `<span class="raw">${esc(raws.map(r => `$ ${r}`).join("\n"))}</span>` : ""}</div>`;
  }).join("");
}

const earlierText = feed => {
  const left = feed.total - Math.min(feed.shown, feed.order.length);
  return left > 0 ? `show ${Math.min(PAGE, left)} earlier` : "";
};
const countText = feed => `latest ${visible(feed).length} of ${feed.total} events`;

function renderActs(v) {
  const box = $("#acts");
  if (!box || !v.feed || !v.detail || v.feed.round !== v.detail.currentRound) return;
  box.innerHTML = actsHtml(visible(v.feed), v.opened, v.fresh);
  v.fresh.clear();
  $("#earlier").textContent = earlierText(v.feed);
  $("#act-count").textContent = countText(v.feed);
}

function renderPast(v, round) {
  const box = $(`#past-${round}`);
  const p = v.past.get(round);
  if (!box) return;
  if (!p || !p.open || !p.feed) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="acts">${actsHtml(visible(p.feed), v.opened, new Set())}</div>
    <div class="actbar"><a data-past-earlier="${round}">${earlierText(p.feed)}</a><span>${countText(p.feed)}</span></div>`;
}

function renderPrompt(v, round) {
  const box = $(`#promptbox-${round}`);
  const p = v.prompts.get(round);
  if (box) box.innerHTML = p && p.open && p.text !== null ? `<pre id="prompt-${round}">${esc(p.text)}</pre>` : "";
}

// ----- loading -----

const sessionQuery = v => `ws=${encodeURIComponent(v.ws)}&id=${encodeURIComponent(v.id)}`;

function openDetail(r) {
  const v = { ws: r.ws, id: r.id, issue: r.issue ? r.issue.slice(6) : null, detail: null, feed: null, loading: 0, buffer: [],
    opened: new Set(), fresh: new Set(), past: new Map(), prompts: new Map() };
  view = v;
  $("#d-ws").textContent = r.ws;
  $("#d-title").textContent = r.id;
  $("#d-meta").innerHTML = `<span class="mono">${esc(r.id)}</span>`;
  for (const id of ["#status", "#steps", "#thread", "#ledger"]) $(id).innerHTML = "";
  $("#status").className = "status";
  $("#issues-box").classList.remove("on");
  reloadDetail(v);
  connect(`/api/stream?view=session&${sessionQuery(v)}`, {
    snapshot: e => {
      if (view !== v) return;
      const snap = JSON.parse(e.data);
      for (const action of onSnapshot(v, snap)) {
        if (action === "resetFeed") v.feed = newFeed(snap.round);
        else if (action === "reloadDetail") reloadDetail(v);
        else if (action === "fetchActivity") fetchActivity(v);
      }
    },
    activity: e => {
      if (view !== v || !v.feed) return;
      const ev = JSON.parse(e.data);
      if (v.loading) {
        v.buffer.push(ev);
        return;
      }
      if (mergeActivity(v.feed, ev) === "add") v.fresh.add(ev.key);
      renderActs(v);
    },
    session: e => {
      if (view !== v) return;
      const { round } = JSON.parse(e.data);
      reloadDetail(v);
      if (!v.feed || v.feed.round !== round) {
        v.feed = newFeed(round);
        fetchActivity(v);
      }
    },
  });
}

/** The latest `shown` items of the feed's round; live events that arrive meanwhile wait, then merge by key. */
async function fetchActivity(v) {
  const feed = v.feed;
  if (!feed) return;
  v.loading++;
  const page = await getJson(`/api/activity?${sessionQuery(v)}&round=${feed.round}&limit=${feed.shown}`);
  if (view !== v) return;
  if (page && v.feed === feed) applyPage(feed, page, { latest: true });
  for (const ev of v.buffer) mergeActivity(v.feed, ev);
  v.buffer = [];
  v.loading--;
  renderActs(v);
}

async function reloadDetail(v) {
  const res = await fetch(`/api/session?${sessionQuery(v)}`).catch(() => null);
  if (view !== v || !res) return;
  if (!res.ok) {
    $("#thread").innerHTML = `<p class="notfound">This session is not in the scanned workspaces.</p>`;
    return;
  }
  const d = await res.json();
  if (view !== v) return;
  skew = (d.serverTime || Date.now() / 1000) - Date.now() / 1000;
  // Unchanged detail (a reconnect, a second load on open): keep the page as it is, flash included
  const sig = JSON.stringify({ ...d, serverTime: 0 });
  if (sig === v.sig) return;
  v.sig = sig;
  v.detail = d;
  renderDetail(v);
}

function renderDetail(v) {
  const d = v.detail;
  $("#d-ws").textContent = d.wsName || v.ws;
  $("#d-title").innerHTML = inline(d.title);
  $("#d-meta").innerHTML = `<span>${esc(d.meta.text)}${d.meta.code ? ` <span class="mono">${esc(d.meta.code)}</span>` : ""}</span><span class="mono">${esc(d.id)}</span>`;

  const box = $("#status");
  box.className = `status ${d.status.state}`;
  const next = esc(d.status.next).replace("{clock}", `<span class="run-clock" data-since="${Number(d.roundStartedAt) || 0}"></span>`);
  box.innerHTML = `<div class="what"><span>${ic(d.status.state)}</span>${esc(d.status.what)}</div><div class="next">${next}</div>`;

  $("#steps").innerHTML = d.steps.map(s => `<span class="s${s.tone ? ` ${esc(s.tone)}` : ""}"${s.jump ? ` data-jump="${esc(s.jump)}"` : ""}>${s.strong ? `<b>${esc(s.strong)}</b> ` : ""}${esc(s.text)}</span>`)
    .join(`<span class="arrow">→</span>`);
  $("#thread").innerHTML = threadHtml(d);
  $("#ledger").innerHTML = ledgerHtml(d);
  $("#issues-box").classList.toggle("on", d.ledger.length > 0);
  renderFacts(d);

  // A reload keeps what the reader opened
  renderActs(v);
  for (const round of v.past.keys()) renderPast(v, round);
  for (const round of v.prompts.keys()) renderPrompt(v, round);
  tickClocks();
  if (v.issue) {
    flashIssue(v.issue);
    v.issue = null;
  }
}

function flashIssue(n) {
  const el = document.querySelector(`#thread .finding[data-issue="${Number(n)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

async function showEarlier(v, feed, round) {
  // earlier lines go below the list, so the reader's place does not move
  feed.shown += PAGE;
  if (feed.order.length < feed.shown && feed.order.length < feed.total) {
    const first = feed.byKey.get(feed.order[0]);
    const page = await getJson(`/api/activity?${sessionQuery(v)}&round=${round}&before=${first.line}&limit=${feed.shown - feed.order.length}`);
    if (view !== v) return;
    if (page) applyPage(feed, page);
  }
  if (round === (v.feed && v.feed.round) && feed === v.feed) renderActs(v); else renderPast(v, round);
}

async function togglePast(v, round) {
  const p = v.past.get(round) || { open: false, feed: null };
  v.past.set(round, p);
  p.open = !p.open;
  if (p.open && !p.feed) {
    const page = await getJson(`/api/activity?${sessionQuery(v)}&round=${round}&limit=${PAGE}`);
    if (view !== v || !page) return;
    p.feed = newFeed(round);
    applyPage(p.feed, page);
  }
  renderPast(v, round);
}

async function togglePrompt(v, round) {
  const p = v.prompts.get(round) || { open: false, text: null };
  v.prompts.set(round, p);
  p.open = !p.open;
  if (p.open && p.text === null) {
    const res = await fetch(`/api/prompt?${sessionQuery(v)}&round=${round}`).catch(() => null);
    if (view !== v) return;
    p.text = res && res.ok ? await res.text() : "The prompt file is missing.";
  }
  renderPrompt(v, round);
}

function onDetailClick(e) {
  const v = view;
  if (!v) return;
  const t = e.target;
  const jump = t.closest("[data-jump]");
  if (jump) document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const issue = t.closest("[data-issue-go]");
  if (issue) {
    flashIssue(issue.dataset.issueGo);
    history.replaceState(null, "", `${sessionHref(v.ws, v.id)}/ISSUE-${Number(issue.dataset.issueGo)}`);
  }
  const act = t.closest("[data-act][data-raw]");
  if (act) {
    const key = act.dataset.act;
    if (v.opened.has(key)) v.opened.delete(key); else v.opened.add(key);
    act.classList.toggle("open", v.opened.has(key));
  }
  if (t.id === "earlier" && v.feed) showEarlier(v, v.feed, v.feed.round);
  const pastEarlier = t.closest("[data-past-earlier]");
  if (pastEarlier) {
    const round = Number(pastEarlier.dataset.pastEarlier);
    const p = v.past.get(round);
    if (p && p.feed) showEarlier(v, p.feed, round);
  }
  const past = t.closest("[data-past]");
  if (past) togglePast(v, Number(past.dataset.past));
  const prompt = t.closest("[data-prompt]");
  if (prompt) togglePrompt(v, Number(prompt.dataset.prompt));
  if (t.closest("#reveal")) {
    fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ws: v.ws, id: v.id }) }).catch(() => {});
  }
}

// ---------- Settings ----------

let settings = null; // /api/settings
let catalogInfo = { models: null, codexDefault: null }; // for model names on session pages
let avatars = { keys: [], parties: [] };
let avatarStamp = Date.now();
const sv = { scope: "global", ws: null, draft: {}, touched: new Set(), refreshed: false };
let pendingSave = null; // a POST /api/settings in flight: the page reloads settings after it
let settingsLoad = 0; // counts openSettings calls; only the latest one applies its answer

const ALL_PATHS = ["reviewer", "model", "effort", "open_dashboard", ...SKILLS.flatMap(s => [`skills.${s}.model`, `skills.${s}.effort`])];
const clone = x => JSON.parse(JSON.stringify(x || {}));
const modelName = (slug, models = settings ? settings.models : catalogInfo.models) => {
  const m = slug && models ? models.find(x => x.slug === slug) : null;
  return m ? m.name : slug;
};
const savedConfig = () => (sv.scope === "global" ? settings.global : settings.workspaces[sv.ws] || {});
const globalHere = () => (sv.scope === "global" ? sv.draft : settings.global);
const workspaceHere = () => (sv.scope === "workspace" ? sv.draft : null);

function ago(epoch) {
  const s = Math.max(0, Math.floor(nowS() - epoch));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function setPath(obj, p, value) {
  const keys = p.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {};
  if (value === undefined || value === "") delete o[keys[keys.length - 1]]; else o[keys[keys.length - 1]] = value;
}

const optionsHtml = opts => opts.map(o => `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`).join("");

async function openSettings(r) {
  const load = ++settingsLoad;
  if (pendingSave) await pendingSave.catch(() => null);
  const [s, a] = await Promise.all([getJson("/api/settings"), getJson("/api/avatars")]);
  // a newer Settings page was opened meanwhile, or the user left Settings
  if (load !== settingsLoad || parseRoute(location.hash)?.view !== "settings") return;
  if (!s) {
    $("#settings-error").textContent = "The settings could not be loaded.";
    return;
  }
  settings = s;
  catalogInfo = { models: s.models, codexDefault: s.codexDefault };
  if (a) avatars = a;
  const names = Object.keys(settings.workspaces);
  sv.scope = r.ws ? "workspace" : "global";
  sv.ws = r.ws && names.includes(r.ws) ? r.ws : (sv.ws && names.includes(sv.ws) ? sv.ws : names[0] || null);
  if (r.ws && !names.includes(r.ws)) {
    location.replace("#/settings");
    return;
  }
  resetDraft();
  renderSettings();
}

function resetDraft() {
  sv.draft = clone(savedConfig());
  sv.touched = new Set();
  $("#save-error").textContent = "";
}

/** The model a review would use here (for the effort levels and the help line). */
function effectiveModel() {
  return resolveHere({ global: globalHere(), workspace: workspaceHere(), skill: null, key: "model" }).value || settings.codexDefault;
}

function renderSettings() {
  if (!settings) return;
  const ws = sv.ws;
  const workspace = sv.scope === "workspace";
  const name = ws ? settings.names[ws] || ws : "";
  const d = sv.draft;
  document.querySelectorAll("#settings input[name=scope]").forEach(el => { el.checked = el.value === sv.scope; });
  $("#ws").innerHTML = Object.keys(settings.workspaces).map(w => `<option value="${esc(w)}"${w === ws ? " selected" : ""}>${esc(settings.names[w] || w)}</option>`).join("");
  $("#ws").disabled = !ws;
  $("#settings input[value=workspace]").disabled = !ws;
  $("#explain").innerHTML = workspace
    ? `<span class="path">${esc(settings.paths[ws])}</span><br>Used only in <b>${esc(name)}</b>. Fields left on Inherit take the global value. The file sits next to this workspace's sessions, so git ignores it.`
    : `<span class="path">${esc(settings.globalPath)}</span><br>Used by every workspace unless the workspace sets its own value. Anything you tell the agent in chat still comes first.`;
  $("#settings-error").textContent = (workspace ? settings.errors.workspaces[ws] : settings.errors.global) || "";

  // Defaults
  const reviewerOpts = workspace ? [{ value: "", label: "Inherit — Codex", selected: !d.reviewer }, { value: "codex", label: "Codex", selected: d.reviewer === "codex" }]
    : [{ value: "", label: "Codex", selected: true }];
  $("#f-reviewer-set").innerHTML = optionsHtml(reviewerOpts);
  const info = settings.reviewer;
  $("#reviewer-help").textContent = info && info.version ? `${info.version}, ${info.loggedIn ? "signed in" : "not signed in"}` : "The codex CLI was not found.";

  const codexDefault = settings.codexDefault ? `Codex default (${modelName(settings.codexDefault)})` : "Codex default";
  const inhModel = inheritedValue({ global: settings.global, workspace: workspaceHere(), skill: null, key: "model" });
  const modelInherit = workspace ? `Inherit — ${inhModel ? modelName(inhModel) : "Codex default"}` : codexDefault;
  $("#f-model-set").innerHTML = optionsHtml(modelOptions({ catalog: settings.models, saved: d.model, inherited: modelInherit, codexDefault: settings.codexDefault }));
  $("#f-model-set").dataset.path = "model";
  const other = $("#f-model-other");
  other.classList.toggle("on", $("#f-model-set").value === OTHER);
  const em = effectiveModel();
  const desc = settings.models && settings.models.find(m => m.slug === em);
  $("#model-help").textContent = settings.models
    ? `${desc ? `${desc.description} ` : ""}Listed by codex debug models, ${ago(settings.modelsFetchedAt)}.`
    : "The model list is unavailable (codex debug models failed). Pick Other… to type a model name.";
  $("#refresh").lastChild.textContent = sv.refreshed ? "refreshed just now" : "refresh list";

  const inhEffort = inheritedValue({ global: settings.global, workspace: workspaceHere(), skill: null, key: "effort" });
  $("#f-effort-set").innerHTML = optionsHtml(effortOptions({ catalog: settings.models, model: em, saved: d.effort, inherited: workspace ? `Inherit — ${inhEffort || "high"}` : "high (default)" }));
  $("#f-effort-set").dataset.path = "effort";

  const follow = d.open_dashboard;
  const globalFollow = settings.global.open_dashboard === true;
  $("#f-follow").innerHTML = optionsHtml([
    ...(workspace ? [{ value: "", label: `Inherit — ${globalFollow ? "on" : "off"}`, selected: follow === undefined }] : []),
    { value: "on", label: "On — open each new review", selected: follow === true },
    { value: "off", label: "Off", selected: follow === false || (!workspace && follow !== true) },
  ]);

  // Per skill
  $("#per-skill").innerHTML = SKILLS.map(s => {
    const o = (d.skills && d.skills[s]) || {};
    const model = resolveHere({ global: globalHere(), workspace: workspaceHere(), skill: s, key: "model" });
    const effort = resolveHere({ global: globalHere(), workspace: workspaceHere(), skill: s, key: "effort" });
    const im = inheritedValue({ global: workspace ? settings.global : sv.draft, workspace: workspaceHere(), skill: s, key: "model" });
    const ie = inheritedValue({ global: workspace ? settings.global : sv.draft, workspace: workspaceHere(), skill: s, key: "effort" });
    const mOpts = modelOptions({ catalog: settings.models, saved: o.model, inherited: `Inherit — ${im ? modelName(im) : "Codex default"}`, codexDefault: settings.codexDefault });
    const eOpts = effortOptions({ catalog: settings.models, model: model.value || settings.codexDefault, saved: o.effort, inherited: `Inherit — ${ie || "high"}` });
    const shown = model.value ? modelName(model.value) : settings.codexDefault ? modelName(settings.codexDefault) : "Codex default";
    return `<tr><td>${esc(s)}${o.model || o.effort ? `<span class="set">set here</span>` : ""}</td>
      <td><select data-path="skills.${s}.model" aria-label="${esc(s)} model">${optionsHtml(mOpts)}</select></td>
      <td><select data-path="skills.${s}.effort" aria-label="${esc(s)} effort">${optionsHtml(eOpts)}</select></td>
      <td class="soft">${esc(shown)} · ${esc(effort.value)}<div class="line2">${esc(model.source)}; ${esc(effort.source)}</div></td></tr>`;
  }).join("");

  $("#preview-title").textContent = workspace ? `Show ${name}/.cross-review/config.json` : `Show ${settings.globalPath}`;
  $("#preview").textContent = JSON.stringify(mergeForm(savedConfig(), sv.draft, sv.touched), null, 2);
  $("#avatars-block").classList.toggle("on", !workspace);
  renderAvatarTable();
  $("#clear-ws").classList.toggle("off", !workspace);
  $("#save").textContent = workspace ? `Save for ${name}` : "Save global";
}

// ----- avatars -----

const normalCaller = name => String(name || "").toLowerCase().replace(/[^a-z0-9._-]/g, "-");
const avatarSrc = (who, key) => (avatars.keys.includes(key) ? `avatars/${encodeURIComponent(key)}?v=${avatarStamp}` : AVATAR[who]);

function renderAvatarTable() {
  $("#avatars").innerHTML = avatars.parties.map(p => {
    const has = avatars.keys.includes(p.key);
    const letters = p.who === "us" ? "Y" : p.who === "rv" ? "CX" : p.name ? CALLER_LETTERS[p.name] || initial(p.label.split(" · ")[1]) : "AG";
    return `<tr><td><div class="mark ${p.who}"><img src="${avatarSrc(p.who, p.key)}" alt="${esc(letters)}"></div>${esc(p.label)}</td>
      <td class="soft">${esc(p.seenIn)}</td>
      <td class="right"><label><a>${has ? "Change" : "Upload image"}</a><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-av="${esc(p.key)}" hidden></label>${has ? ` · <a data-av-clear="${esc(p.key)}">remove</a>` : ""}</td></tr>`;
  }).join("");
}

async function reloadAvatars() {
  const a = await getJson("/api/avatars");
  if (a) avatars = a;
  avatarStamp = Date.now();
  renderAvatarTable();
  if (view && view.detail) {
    view.sig = null;
    renderDetail(view);
  }
}

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    alert("That image is over 1 MB. Pick a smaller one.");
    return;
  }
  const res = await fetch(`/api/avatars/${encodeURIComponent(input.dataset.av)}`, { method: "POST", body: file }).catch(() => null);
  if (!res || !res.ok) {
    const msg = res ? (await res.json().catch(() => ({}))).error : null;
    alert(msg || "The image could not be saved.");
    return;
  }
  reloadAvatars();
}

// ----- events -----

function onSettingsChange(e) {
  const t = e.target;
  if (t.name === "scope") {
    location.hash = t.value === "global" ? "#/settings" : `#/settings/${encodeURIComponent($("#ws").value)}`;
    return;
  }
  if (t.id === "ws") {
    location.hash = `#/settings/${encodeURIComponent(t.value)}`;
    return;
  }
  if (t.dataset.av !== undefined && t.type === "file") return uploadAvatar(t);
  if (t.id === "f-follow") {
    const v = t.value === "on" ? true : t.value === "off" ? (sv.scope === "workspace" ? false : undefined) : undefined;
    setPath(sv.draft, "open_dashboard", v);
    sv.touched.add("open_dashboard");
  } else if (t.id === "f-reviewer-set") {
    setPath(sv.draft, "reviewer", t.value || undefined);
    sv.touched.add("reviewer");
  } else if (t.dataset.path) {
    let value = t.value;
    if (value === OTHER) {
      if (t.dataset.path === "model") {
        $("#f-model-other").classList.add("on");
        $("#f-model-other").focus();
        return;
      }
      value = (prompt("Model name") || "").trim();
      if (!value) return renderSettings();
    }
    setPath(sv.draft, t.dataset.path, value || undefined);
    sv.touched.add(t.dataset.path);
  } else if (t.id === "f-model-other") {
    const value = t.value.trim();
    setPath(sv.draft, "model", value || undefined);
    sv.touched.add("model");
  } else {
    return;
  }
  renderSettings();
}

async function onSettingsClick(e) {
  const t = e.target;
  const clear = t.closest("[data-av-clear]");
  if (clear) {
    await fetch(`/api/avatars/${encodeURIComponent(clear.dataset.avClear)}`, { method: "DELETE" }).catch(() => null);
    return reloadAvatars();
  }
  if (t.closest("#refresh")) {
    const m = await getJson("/api/models?refresh=1");
    if (m && settings) {
      Object.assign(settings, { models: m.models, modelsFetchedAt: m.fetchedAt, codexDefault: m.codexDefault, reviewer: m.reviewer });
      catalogInfo = { models: m.models, codexDefault: m.codexDefault };
      sv.refreshed = true;
      renderSettings();
    }
    return;
  }
  if (t.id === "discard") {
    resetDraft();
    renderSettings();
  } else if (t.id === "clear-ws") {
    sv.draft = {};
    sv.touched = new Set(ALL_PATHS);
    renderSettings();
  } else if (t.id === "save") {
    // One save at a time: answers cannot arrive out of order
    if (pendingSave) return;
    // The reader may switch scope or keep editing while this saves: the answer updates the
    // level it was sent for, and resets the form only when it still shows exactly what was sent
    const scope = sv.scope;
    const ws = sv.ws;
    const draft = sv.draft;
    const sent = JSON.stringify(draft);
    const config = mergeForm(savedConfig(), draft, sv.touched);
    const body = scope === "global" ? { scope: "global", config } : { scope: "workspace", ws, config };
    $("#save").disabled = true;
    pendingSave = fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const res = await pendingSave.catch(() => null);
      const same = sv.scope === scope && sv.ws === ws && sv.draft === draft;
      if (!res || !res.ok) {
        const msg = res ? (await res.json().catch(() => ({}))).error : null;
        if (same) $("#save-error").textContent = msg || "The settings could not be saved.";
        return;
      }
      const saved = (await res.json()).config;
      if (scope === "global") settings.global = saved; else settings.workspaces[ws] = saved;
      if (same && JSON.stringify(sv.draft) === sent) resetDraft();
      renderSettings();
    } finally {
      pendingSave = null;
      $("#save").disabled = false;
    }
  }
}

// ---------- data ----------

function apply(payload) {
  data = payload;
  skew = (payload.serverTime || Date.now() / 1000) - Date.now() / 1000;
  renderWhere();
  renderSessions();
}

async function start() {
  document.querySelectorAll("[data-i]").forEach(el => el.insertAdjacentHTML("afterbegin", ic(el.dataset.i)));
  const refilter = () => {
    hist.offset = 0;
    hist.back = [];
    if (data) renderHistory();
  };
  for (const id of ["#f-ws", "#f-skill", "#f-result"]) $(id).addEventListener("change", refilter);
  $("#f-search").addEventListener("input", refilter);
  $("#h-pager").addEventListener("click", e => {
    const a = e.target.closest("a[data-hpage]");
    if (!a || !data) return;
    if (Number(a.dataset.hpage) > 0) {
      hist.back.push(hist.offset);
      hist.offset += hist.shown;
    } else {
      hist.offset = hist.back.length ? hist.back.pop() : 0;
    }
    renderHistory();
  });
  window.addEventListener("resize", () => data && $("#sessions").classList.contains("on") && renderHistory());
  document.addEventListener("click", e => {
    const row = e.target.closest("tr[data-go]");
    if (row && !e.target.closest("a")) location.hash = row.dataset.go;
    if (e.target.closest("#detail")) onDetailClick(e);
    if (e.target.closest("#settings")) onSettingsClick(e);
  });
  $("#settings").addEventListener("change", onSettingsChange);
  // An avatar that does not load shows its letters
  document.addEventListener("error", e => {
    const img = e.target;
    if (img.tagName === "IMG" && img.parentElement && img.parentElement.classList.contains("mark")) img.replaceWith(img.alt);
  }, true);
  window.addEventListener("hashchange", route);
  const [first, a] = await Promise.all([getJson("/api/sessions"), getJson("/api/avatars")]);
  if (first) apply(first);
  if (a) avatars = a;
  route();
  setInterval(tickClocks, 1000);
}

if (typeof document !== "undefined") start();
