// The dashboard page: hash routes, the Sessions view (live "In progress" and filtered
// History), the session page (status, steps, conversation, issues, live activity) and the
// header. Each view has at most one stream open; clocks tick here, against the server's clock.

import { ic } from "./icons.js";
import { esc, renderInline, renderMarkdown } from "./markdown.js";
import { PAGE, applyPage, groupReads, mergeActivity, newFeed, onSnapshot, visible } from "./feed.js";

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
  if (r.view === "sessions") connect("/api/stream?view=list", { sessions: e => apply(JSON.parse(e.data)) });
  else connect(null);
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
    <td>${skillIc(s.skill)}${inline(s.title)}<div class="line2">${esc(where)}</div></td>
    <td class="soft">${esc(s.now)}${s.warn ? `<div class="warn with-i">${ic("warn")}${esc(s.warn)}</div>` : ""}</td>
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

function renderHistory() {
  const ws = $("#f-ws").value;
  const skill = $("#f-skill").value;
  const result = $("#f-result").value;
  const q = $("#f-search").value.trim().toLowerCase();
  const rows = data.history.filter(s => (!ws || s.ws === ws) && (!skill || s.skill === skill) && (!result || s.label === result)
    && (!q || s.searchText.includes(q) || s.wsName.toLowerCase().includes(q) || s.id.includes(q)));
  $("#history").innerHTML = rows.length ? rows.map(historyRow).join("")
    : `<tr class="empty"><td colspan="7" class="soft">${data.history.length ? "No session matches." : "No finished sessions yet."}</td></tr>`;
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
  const letters = CALLER_LETTERS[c.name] || (c.title ? c.title.trim()[0].toUpperCase() : "AG");
  return { letters, tip: c.title || "Agent" };
}

const mark = (who, d) => {
  const p = party(who, d);
  return `<div class="mark ${who}" title="${esc(p.tip)}"><img src="${AVATAR[who]}" alt="${esc(p.letters)}"></div>`;
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
    + i.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${renderInline(v)}</dd>`).join("");
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

function threadHtml(d) {
  return d.thread.map(x => {
    if (x.kind === "ask") return msg(d, "us", "<span>asked the agent</span>", renderMarkdown(x.md));
    if (x.kind === "analysis") return msg(d, "ag", "<span>independent analysis</span>", renderMarkdown(x.md));
    if (x.kind === "reply") return msg(d, "ag", "<span>reply</span>", replyBody(x.reply), x.anchor);
    if (x.kind === "review") {
      const body = (x.reasonMd ? renderMarkdown(x.reasonMd) : "") + x.issues.map(finding).join("") + (x.rawMd ? renderMarkdown(x.rawMd) : "");
      return roundLabel(x.round) + msg(d, "rv", `${st(x.verdict.kind, x.verdict.label)}<span>${x.secs != null ? clock(x.secs) : ""}</span>`, body + foot(x), x.anchor);
    }
    if (x.kind === "stopped") {
      const why = x.failed ? `The turn failed: <span class="mono">${esc(x.error)}.</span>` : `Stopped: ${esc(x.error)}.`;
      return roundLabel(x.round) + msg(d, "rv", `${st("stopped", "stopped")}<span>${x.secs != null ? clock(x.secs) : ""}</span>`, `<p>${why}</p>${foot(x)}`, x.anchor);
    }
    if (x.kind === "running") {
      return roundLabel(x.round) + msg(d, "rv", `${st("running", "working")}<span class="run-clock" data-since="${Number(x.startedAt) || 0}"></span>`,
        `${esc(runningLine(d))}<div class="acts" id="acts"></div><div class="actbar"><a id="earlier"></a><span id="act-count"></span></div>`, "s-live");
    }
    return "";
  }).join("");
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
  $("#f-model").textContent = f.model || `${reviewer} default`;
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

function actsHtml(items, opened, fresh) {
  return groupReads(items).map(g => {
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
  if (page && v.feed === feed) applyPage(feed, page);
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
  const y = window.scrollY;
  const h = document.body.scrollHeight;
  feed.shown += PAGE;
  if (feed.order.length < feed.shown && feed.order.length < feed.total) {
    const first = feed.byKey.get(feed.order[0]);
    const page = await getJson(`/api/activity?${sessionQuery(v)}&round=${round}&before=${first.line}&limit=${feed.shown - feed.order.length}`);
    if (view !== v) return;
    if (page) applyPage(feed, page);
  }
  if (round === (v.feed && v.feed.round) && feed === v.feed) renderActs(v); else renderPast(v, round);
  window.scrollTo(0, y + document.body.scrollHeight - h); // keep the reader's place
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

// ---------- data ----------

function apply(payload) {
  data = payload;
  skew = (payload.serverTime || Date.now() / 1000) - Date.now() / 1000;
  renderWhere();
  renderSessions();
}

async function start() {
  document.querySelectorAll("[data-i]").forEach(el => el.insertAdjacentHTML("afterbegin", ic(el.dataset.i)));
  for (const id of ["#f-ws", "#f-skill", "#f-result"]) $(id).addEventListener("change", () => data && renderHistory());
  $("#f-search").addEventListener("input", () => data && renderHistory());
  document.addEventListener("click", e => {
    const row = e.target.closest("tr[data-go]");
    if (row && !e.target.closest("a")) location.hash = row.dataset.go;
    if (e.target.closest("#detail")) onDetailClick(e);
  });
  // An avatar that does not load shows its letters
  document.addEventListener("error", e => {
    const img = e.target;
    if (img.tagName === "IMG" && img.parentElement && img.parentElement.classList.contains("mark")) img.replaceWith(img.alt);
  }, true);
  window.addEventListener("hashchange", route);
  const first = await getJson("/api/sessions");
  if (first) apply(first);
  route();
  setInterval(tickClocks, 1000);
}

if (typeof document !== "undefined") start();
