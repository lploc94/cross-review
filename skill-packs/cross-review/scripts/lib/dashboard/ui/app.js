// The dashboard page: hash routes, the Sessions view (live "In progress" and filtered
// History), the session page (status, steps, conversation, issues, live activity), the Plans
// view and a plan's page (progress and the plan itself), Settings and the header. Each view has
// at most one stream open; clocks tick here, against the server's clock.

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
let pv = null; // the open plan page
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
  if (parts[0] === "plans" && parts.length === 1) return { view: "plans" };
  if (parts[0] === "p") {
    // a plan: #/p/<ws>/<file>, or its Plan tab with /plan; anything else under p goes to the list
    if ((parts.length === 3 || (parts.length === 4 && parts[3] === "plan")) && parts[1] && parts[2]) {
      try {
        return { view: "plan", ws: decodeURIComponent(parts[1]), file: decodeURIComponent(parts[2]), tab: parts[3] === "plan" ? "doc" : "progress" };
      } catch {}
    }
    return { view: "plans", redirect: true };
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
export const planHref = (ws, file, tab = "progress") => `#/p/${encodeURIComponent(ws)}/${encodeURIComponent(file)}${tab === "doc" ? "/plan" : ""}`;

function route() {
  const r = parseRoute(location.hash);
  if (!r) {
    location.replace("#/");
    return;
  }
  if (r.redirect) {
    location.replace("#/plans");
    return;
  }
  const same = r.view === "detail" && view && view.ws === r.ws && view.id === r.id;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === r.view));
  // a session's page lights the Sessions tab; a plan's page the Plans tab
  const tab = r.view === "settings" ? "settings" : r.view === "plans" || r.view === "plan" ? "plans" : "sessions";
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
  // the list stream feeds Sessions, Plans and a plan's page
  const list = () => connect("/api/stream?view=list", { sessions: e => apply(JSON.parse(e.data)) });
  if (r.view === "plan") {
    list();
    return openPlan(r);
  }
  pv = null;
  window.scrollTo(0, 0);
  if (r.view === "sessions") {
    // the page size depends on the visible layout
    if (data) renderHistory();
    list();
  } else if (r.view === "plans") {
    if (data) renderPlans();
    list();
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

const modelOf = s => s.model || `${own(REVIEWERS, s.reviewer) || s.reviewer} default`;

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

function renderFilters(id = "#f-ws") {
  const sel = $(id);
  const keep = sel.value;
  sel.innerHTML = `<option value="">All workspaces</option>` +
    data.workspaces.map(w => `<option value="${esc(w.ws)}" title="${esc(w.path)}">${esc(w.name)}</option>`).join("");
  sel.value = data.workspaces.some(w => w.ws === keep) ? keep : "";
}

// Pages that fit the window (user decisions 2026-10-15 for History, 2026-10-16 for Plans): from
// `offset`, as many rows as fit with the pager under them, so the page does not scroll; at least
// PAGE_MIN_ROWS. Rows wrap differently, so a page is measured on the rows it shows. The forward
// link moves the offset past the rows shown; the back link goes back to the offset before.
const PAGE_MIN_ROWS = 3;
const PAGE_MAX_ROWS = 100; // more rows than any window holds; bounds the rows laid out to measure

function paintPage(pg, rows, count, pager) {
  const shown = rows.slice(pg.offset, pg.offset + count);
  $(pg.body).innerHTML = shown.length ? shown.map(pg.row).join("") : pg.empty();
  $(pg.pager).innerHTML = pager
    ? `<a data-${pg.attr}="-1"${pg.offset === 0 ? ' class="off"' : ""}>‹ ${pg.back}</a><span>${pg.offset + 1}–${pg.offset + shown.length} of ${rows.length}</span><a data-${pg.attr}="1"${pg.offset + shown.length >= rows.length ? ' class="off"' : ""}>${pg.forward} ›</a>`
    : "";
  pg.shown = shown.length;
  if (pg.painted) pg.painted();
}

function fitPage(pg, rows) {
  pg.offset = Math.max(0, Math.min(pg.offset, rows.length - 1));
  const left = rows.length - pg.offset;
  if (!$(pg.section).classList.contains("on")) {
    // hidden: nothing to measure; the route renders again when it shows
    paintPage(pg, rows, Math.min(left, 10), rows.length > 10);
    return;
  }
  // Lay out the candidates with the pager, then keep the rows that end above the pager's place
  paintPage(pg, rows, Math.min(left, PAGE_MAX_ROWS), true);
  const pager = $(pg.pager);
  const main = pager.closest("main");
  const budget = window.innerHeight - (parseFloat(getComputedStyle(main).paddingBottom) || 0)
    - pager.getBoundingClientRect().height - (parseFloat(getComputedStyle(pager).marginTop) || 0);
  let fit = 0;
  for (const row of $(pg.body).querySelectorAll("tr[data-go]")) {
    if (row.getBoundingClientRect().bottom + window.scrollY > budget) break;
    fit++;
  }
  fit = Math.max(Math.min(PAGE_MIN_ROWS, left), fit);
  // everything from the first row fits: no pager
  paintPage(pg, rows, fit, !(pg.offset === 0 && fit >= left));
}

function turnPage(pg, dir) {
  if (dir > 0) {
    pg.back_.push(pg.offset);
    pg.offset += pg.shown;
  } else {
    pg.offset = pg.back_.length ? pg.back_.pop() : 0;
  }
}

const hist = {
  offset: 0, back_: [], section: "#sessions", body: "#history", pager: "#h-pager", attr: "hpage", back: "Newer", forward: "Older",
  row: historyRow,
  empty: () => `<tr class="empty"><td colspan="7" class="soft">${data.history.length ? "No session matches." : "No finished sessions yet."}</td></tr>`,
};

function filteredHistory() {
  const ws = $("#f-ws").value;
  const skill = $("#f-skill").value;
  const result = $("#f-result").value;
  const q = $("#f-search").value.trim().toLowerCase();
  return data.history.filter(s => (!ws || s.ws === ws) && (!skill || s.skill === skill) && (!result || s.label === result)
    && (!q || s.searchText.includes(q) || s.wsName.toLowerCase().includes(q) || s.id.includes(q)));
}

const renderHistory = () => fitPage(hist, filteredHistory());

function renderSessions() {
  $("#active").innerHTML = data.active.length ? data.active.map(activeRow).join("") : EMPTY_ACTIVE;
  renderFilters();
  renderHistory();
}

function tickClocks() {
  const t = nowS();
  document.querySelectorAll("[data-since]").forEach(el => { el.textContent = clock(t - Number(el.dataset.since)); });
}

// ---------- Plans ----------

const PLAN_KIND = { progress: "progress", review: "running", ready: "ready", draft: "draft", done: "done", doc: "doc" };
const SESSION_LABEL = { approve: "approved", consensus: "consensus", stalemate: "stalemate", running: "reviewer working", waiting: "agent's turn", stopped: "stopped" };
const VERDICT_LABEL = { APPROVE: ["approve", "approved"], REVISE: ["revise", "changes asked"], STALEMATE: ["stalemate", "stalemate"], CONSENSUS: ["consensus", "consensus"] };
const gitShort = tracked => (tracked === true ? "in git" : tracked === false ? "local only" : "no git");
const gitLong = tracked => (tracked === true ? "in git" : tracked === false ? "local only — git ignores it" : "not in a git repository");
/** 2026-10-14 → 14 Oct (with the year when it is not this one). */
function isoDay(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || "");
  const year = new Date(nowS() * 1000).getFullYear();
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${Number(m[1]) === year ? "" : ` ${m[1]}`}`;
}
function changed(epoch) {
  const s = nowS() - epoch;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return when(epoch);
}

function planLabel(p) {
  if (p.state === "progress") return `phase ${p.progress.current} of ${p.progress.phasesTotal}`;
  return { review: "in review", ready: "ready to start", draft: "draft", done: "done", doc: "document" }[p.state] || p.state;
}

function progressText(p) {
  const pr = p.progress;
  if (!pr) return "not a loop-plan file";
  if (!pr.acsMet && !pr.phasesDone) return `${pr.phasesTotal} ${pr.phasesTotal === 1 ? "phase" : "phases"} · not started`;
  return `${pr.phasesDone} of ${pr.phasesTotal} phases · ${pr.acsMet} of ${pr.acsTotal} criteria`;
}

// a phase's share is set as --p through the CSSOM after painting: the CSP blocks style attributes
const pbar = bar => `<div class="pbar">${(bar || []).map(f => (f >= 1 ? `<i class="done"></i>` : f > 0 ? `<i class="part" data-p="${Math.round(f * 100)}"></i>` : "<i></i>")).join("")}</div>`;
const setShares = root => root.querySelectorAll("i[data-p]").forEach(i => i.style.setProperty("--p", `${Number(i.dataset.p)}%`));

function reviewCell(p) {
  if (p.format !== "loop-plan") return `<span class="soft">—</span>`;
  if (p.reviewSession) return `${st("running", `round ${p.reviewSession.round}`)}<div class="line2 mono">${esc(p.reviewSession.id)}</div>`;
  const r = p.planReview || {};
  if (r.verdict === "APPROVE" && r.session) return `${st("approve", "approved")}<div class="line2 mono">${esc(r.session)}</div>`;
  if (r.verdict === "APPROVE" && r.user) return `${st("approve", "approved by you")}<div class="line2">${esc(isoDay(r.user))}</div>`;
  if (r.verdict === "REVISE") return st("revise", "changes asked");
  return `<span class="st draft">${ic("draft")}${r.verdict === "APPROVE" ? "approval without a source" : "not reviewed"}</span>`;
}

function planRow(p) {
  const sub = `${p.wsName} · ${p.file} · ${gitShort(p.tracked)}`;
  return `<tr data-go="${esc(planHref(p.ws, p.file))}"><td>${st(own(PLAN_KIND, p.state) || "draft", planLabel(p))}</td>
    <td>${inline(p.title)}<div class="line2">${esc(sub)}</div></td>
    <td>${p.format === "loop-plan" ? pbar(p.bar) : `<span class="soft">—</span>`}<div class="line2">${esc(progressText(p))}</div></td>
    <td>${reviewCell(p)}</td><td class="num line2 nw">${esc(changed(p.changedAt))}</td></tr>`;
}

const plansPage = {
  offset: 0, back_: [], section: "#plans", body: "#plan-list", pager: "#p-pager", attr: "ppage", back: "Previous", forward: "Next",
  row: planRow,
  empty: () => `<tr class="empty"><td colspan="5" class="soft">${data.plans.length ? "No plan matches." : "No plans yet. loop-plan writes them to .cross-review/plans/."}</td></tr>`,
  painted: () => setShares($("#plan-list")),
};

function filteredPlans() {
  const ws = $("#pf-ws").value;
  const state = $("#pf-state").value;
  const q = $("#pf-search").value.trim().toLowerCase();
  return (data.plans || []).filter(p => (!ws || p.ws === ws) && (!state || p.state === state)
    && (!q || p.searchText.includes(q) || p.wsName.toLowerCase().includes(q) || p.file.toLowerCase().includes(q)));
}

function renderPlans() {
  renderFilters("#pf-ws");
  fitPage(plansPage, filteredPlans());
}

// ----- one plan -----

const phaseMet = p => p.acs.filter(a => a.met).length;
const phaseDone = p => p.acs.length > 0 && p.acs.every(a => a.met);
const words = list => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
const SESSION_ID = /\b[a-z]+(?:-[a-z]+)*-\d{8}-\d{3}\b/g;

/** A session id as a link when the plan's workspace has that session, else as text. */
function sessionRef(d, id) {
  return d.sessions && d.sessions.some(x => x.id === id)
    ? `<a class="mono" href="${esc(sessionHref(d.ws, id))}">${esc(id)}</a>` : `<span class="mono">${esc(id)}</span>`;
}

/** Inline markdown with session ids linked (outside tags only). */
const withSessions = (d, text) => renderInline(text).split(/(<[^>]+>)/)
  .map(part => (part.startsWith("<") ? part : part.replace(SESSION_ID, id => sessionRef(d, id)))).join("");

function planStatus(d) {
  const ph = d.phases;
  const pr = d.progress;
  if (d.state === "progress") {
    const p = ph.find(x => x.n === pr.current) || ph[0];
    const done = ph.filter(phaseDone).map(x => x.n);
    const before = !done.length ? "No phase is done yet." : done.length === 1 ? `Phase ${done[0]} is done.` : `Phases ${words(done)} are done.`;
    return { kind: "progress", what: esc(`Phase ${p.n} of ${ph.length} — ${p.name}: ${phaseMet(p)} of ${p.acs.length} criteria met.`),
      next: esc(before + (p.checkpoint ? " A review-impl checkpoint follows this phase." : "")) };
  }
  if (d.state === "done") return { kind: "done", what: esc(`Done: all ${ph.length} phases and ${pr.acsTotal} criteria met.`), next: "loop-implement finished every phase." };
  if (d.state === "review") {
    const rs = d.reviewSession;
    return { kind: "running", what: "In review: the plan is not approved yet.",
      next: `review-plan is in round ${Number(rs.round)}; ${sessionRef(d, rs.id)}. loop-implement starts once the plan is approved.` };
  }
  if (d.state === "ready") return { kind: "ready", what: "Ready to start: the plan is approved.", next: "loop-implement starts at the first phase." };
  return { kind: "draft", what: "Draft: the plan is not approved yet.",
    next: d.planReview && d.planReview.verdict === "REVISE"
      ? "The last plan review asked for changes. Run review-plan again, or approve the plan yourself."
      : "Run review-plan, or approve the plan yourself. loop-implement starts once the plan is approved." };
}

function checkpointText(d, p) {
  if (!p.checkpoint) return "No checkpoint: covered by the next one";
  if (!phaseDone(p)) return "Checkpoint: review-impl after this phase";
  const ids = d.log.filter(e => e.phase === p.n).flatMap(e => e.sessions).filter(id => id.startsWith("review-impl-"));
  const id = ids[ids.length - 1];
  const s = id && d.sessions.find(x => x.id === id);
  if (!s) return id ? `Checkpoint: review-impl · ${sessionRef(d, id)}` : "Checkpoint: review-impl";
  const label = own(SESSION_LABEL, s.state) || s.state;
  // the last verdict, unless the state says it already or a new round is under way
  const verdict = s.state !== "running" && own(VERDICT_LABEL, s.verdict);
  const result = verdict && verdict[1] !== label ? ` · ${st(verdict[0], verdict[1])}` : "";
  return `Checkpoint: review-impl · ${st(s.state, label)}${result} · ${sessionRef(d, id)}`;
}

function depsText(p) {
  const dep = String(p.dependencies || "").trim().replace(/\.$/, "");
  if (!dep || /^none$/i.test(dep)) return "No dependencies";
  return `Depends on ${renderInline(dep.replace(/^./, c => c.toLowerCase()))}`;
}

function planReviewFact(d) {
  if (d.state === "review" && d.reviewSession) return `${st("running", `round ${Number(d.reviewSession.round)}`)} · ${sessionRef(d, d.reviewSession.id)}`;
  const r = d.planReview || {};
  if (r.verdict === "APPROVE" && r.session) return `<span title="${esc(r.session)}">${st("approve", "approved")}</span>`;
  if (r.verdict === "APPROVE" && r.user) return st("approve", `approved by you, ${isoDay(r.user)}`);
  if (r.verdict === "REVISE") return st("revise", "changes asked");
  return `<span class="st draft">${ic("draft")}not reviewed</span>`;
}

function logHtml(d) {
  // newest first: by date, then later lines first; lines without a date last
  const entries = d.log.map((e, i) => ({ e, i }))
    .sort((a, b) => Number(Boolean(b.e.date)) - Number(Boolean(a.e.date)) || (b.e.date || "").localeCompare(a.e.date || "") || b.i - a.i);
  if (!entries.length) return `<div class="sub">Nothing yet: loop-implement writes a line per finished phase.</div>`;
  return entries.map(({ e }) => {
    const label = e.kind === "decision" ? "Decision" : e.kind === "discovery" ? "Discovery" : e.kind === "phase" ? `Phase ${e.phase}` : "";
    let text = e.text.replace(/^\d{4}-\d{2}-\d{2}\s*/, "");
    if (e.kind === "decision") text = text.replace(/^Decision:\s*/, "");
    if (e.kind === "discovery") text = text.replace(/^Discovery:\s*/, "");
    if (e.kind === "phase") text = text.replace(/^Phase \d+\s*:?\s*/, "").replace(/^./, c => c.toUpperCase());
    return `<div>${e.date ? `<span class="d">${esc(isoDay(e.date))}</span>` : ""}${label ? `<span class="k ${esc(e.kind)}">${esc(label)}</span>` : ""}${text.split("\n").map(line => withSessions(d, line)).join("<br>")}</div>`;
  }).join("");
}

function renderPlanProgress(v) {
  const d = v.d;
  const pr = d.progress;
  const s = planStatus(d);
  const box = $("#p-status");
  box.className = `status ${s.kind}`;
  box.innerHTML = `<div class="what"><span>${ic(s.kind)}</span>${s.what}</div><div class="next">${s.next}</div>`;
  $("#p-steps").innerHTML = d.phases.map(p => {
    const m = phaseMet(p);
    const all = phaseDone(p);
    return `<span class="s ${all ? "done" : m ? "progress" : "todo"}" data-jump="ph${Number(p.n)}">${all ? ic("done") : ""}<b>${Number(p.n)}</b> ${renderInline(p.name)}${m && !all ? ` ${m}/${p.acs.length}` : ""}</span>`;
  }).join(`<span class="arrow">→</span>`);
  // the current phase opens when it becomes current; nothing closes on its own, and a phase the reader closed stays closed
  if (pr.current && pr.current !== v.current) {
    v.current = pr.current;
    if (!v.closed.has(pr.current)) v.opened.add(pr.current);
  }
  $("#phases").innerHTML = d.phases.map(p => {
    const m = phaseMet(p);
    const all = phaseDone(p);
    const cls = all ? "done" : m ? "progress" : "todo";
    const open = v.opened.has(p.n);
    const icon = all ? `<span class="st done">${ic("done")}</span>` : m ? `<span class="st progress">${ic("progress")}</span>` : `<span class="st draft">${ic("box")}</span>`;
    return `<div class="phase ${cls}${open ? " open" : ""}" id="ph${Number(p.n)}" data-phase="${Number(p.n)}">
      <div class="ph-head">${icon}<span class="n">Phase ${Number(p.n)}</span><span>${renderInline(p.name)}</span><span class="cnt">${m} / ${p.acs.length} criteria</span></div>
      ${p.goal ? `<div class="ph-goal">${renderInline(p.goal)}</div>` : ""}
      <ul class="acs">${p.acs.map(a => `<li${a.met ? ' class="met"' : ""}>${ic(a.met ? "boxed" : "box")}<span class="id">${esc(a.id || "")}</span><span>${renderInline(a.text)}</span></li>`).join("")}</ul>
      <div class="ph-foot">${checkpointText(d, p)}${all && p.commit.sha ? ` · commit <span class="mono">${esc(p.commit.sha)}</span>` : ""}<br>${depsText(p)} · <a data-read="d-phase-${Number(p.n)}">read phase ${Number(p.n)} in the plan</a></div></div>`;
  }).join("");
  $("#p-done").innerHTML = d.completion ? renderMarkdown(d.completion) : `<p class="sub">None listed.</p>`;
  $("#p-wsname").textContent = d.wsName;
  $("#p-review").innerHTML = planReviewFact(d);
  $("#p-phases").textContent = `${pr.phasesDone} of ${pr.phasesTotal} done`;
  $("#p-acs").textContent = `${pr.acsMet} of ${pr.acsTotal} met`;
  const cps = d.phases.filter(p => p.checkpoint).map(p => p.n);
  $("#p-cps").textContent = cps.length ? `after ${words(cps)}` : "none named";
  $("#p-git2").textContent = gitShort(d.tracked);
  $("#p-changed").textContent = changed(d.changedAt);
  $("#plog").innerHTML = logHtml(d);
}

function renderPlanDoc(d) {
  // what comes before the first H2 renders first, without an entry in the contents
  $("#doc").innerHTML = d.sections.map(sec => (sec.title == null ? renderMarkdown(sec.md)
    : `<h2 id="d-${esc(sec.id)}">${renderInline(sec.title)}</h2>${renderMarkdown(sec.md)}`)).join("");
  $("#toc").innerHTML = d.sections.filter(sec => sec.title != null)
    .map(sec => `<a${sec.phase != null ? ' class="sub"' : ""} data-toc="d-${esc(sec.id)}">${renderInline(sec.title)}</a>`).join("");
}

function setPlanTab(v, tab) {
  v.tab = tab;
  const shown = v.d && v.d.format !== "loop-plan" ? "doc" : tab;
  document.querySelectorAll("#plan .ptabs a").forEach(a => a.classList.toggle("on", a.dataset.ptab === shown));
  $("#pane-progress").classList.toggle("on", shown === "progress");
  $("#pane-doc").classList.toggle("on", shown === "doc");
}

function renderPlan(v) {
  const d = v.d;
  const isPlan = d.format === "loop-plan";
  $("#p-body").hidden = false;
  $("#p-gone").hidden = true;
  $("#plan").classList.toggle("fallback", !isPlan);
  $("#p-ws").textContent = d.wsName;
  $("#p-title").innerHTML = inline(d.title);
  $("#p-path").textContent = `.cross-review/plans/${d.file}`;
  $("#p-git").textContent = gitLong(d.tracked);
  $("#p-kind").textContent = isPlan ? `${d.progress.phasesTotal} phases · ${d.progress.acsTotal} acceptance criteria` : "markdown";
  $("#p-note").hidden = isPlan;
  $("#p-target").innerHTML = isPlan && d.target ? `Target: ${renderInline(d.target)}` : "";
  renderPlanDoc(d);
  if (isPlan) renderPlanProgress(v);
  setPlanTab(v, v.tab);
}

function openPlan(r) {
  if (pv && pv.ws === r.ws && pv.file === r.file) {
    setPlanTab(pv, r.tab);
    return;
  }
  const v = { ws: r.ws, file: r.file, tab: r.tab, d: null, sig: null, gone: false, seq: 0, opened: new Set(), closed: new Set(), current: null };
  pv = v;
  window.scrollTo(0, 0);
  $("#p-ws").textContent = r.ws;
  $("#p-title").textContent = r.file;
  for (const id of ["#p-path", "#p-git", "#p-kind", "#p-target", "#p-steps", "#phases", "#doc", "#toc", "#plog", "#p-done"]) $(id).innerHTML = "";
  $("#p-status").className = "status";
  $("#p-status").innerHTML = "";
  setPlanTab(v, r.tab);
  reloadPlan(v);
}

/** Load the plan again; the reader's tab, open phases and scroll stay. */
async function reloadPlan(v) {
  const seq = ++v.seq;
  const res = await fetch(`/api/plan?ws=${encodeURIComponent(v.ws)}&file=${encodeURIComponent(v.file)}`).catch(() => null);
  if (pv !== v || seq !== v.seq || !res) return;
  if (!res.ok) {
    if (res.status !== 404) return;
    // a plan that was never there goes back to the list; one that disappeared says so
    if (!v.d) {
      location.replace("#/plans");
      return;
    }
    v.gone = true;
    v.sig = null;
    $("#p-body").hidden = true;
    $("#p-gone").hidden = false;
    return;
  }
  const d = await res.json();
  if (pv !== v || seq !== v.seq) return;
  v.gone = false;
  if (d.sig === v.sig) return;
  const first = !v.d;
  const y = window.scrollY;
  v.sig = d.sig;
  v.d = d;
  renderPlan(v);
  if (!first) window.scrollTo(0, y);
}

/** A list payload arrived: reload the open plan when what its page shows changed. */
function followPlan() {
  if (!pv || !data) return;
  const it = (data.plans || []).find(p => p.ws === pv.ws && p.file === pv.file);
  if (it ? it.sig !== pv.sig : pv.d && !pv.gone) reloadPlan(pv);
}

const scrollToId = id => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

function onPlanClick(e) {
  const v = pv;
  if (!v) return;
  const t = e.target;
  const tab = t.closest("[data-ptab]");
  if (tab) {
    setPlanTab(v, tab.dataset.ptab);
    history.replaceState(null, "", planHref(v.ws, v.file, tab.dataset.ptab));
  }
  const head = t.closest(".ph-head");
  if (head) {
    const n = Number(head.parentElement.dataset.phase);
    const open = !head.parentElement.classList.contains("open");
    if (open) {
      v.opened.add(n);
      v.closed.delete(n);
    } else {
      v.closed.add(n);
      v.opened.delete(n);
    }
    head.parentElement.classList.toggle("open", open);
  }
  const jump = t.closest("[data-jump]");
  if (jump) scrollToId(jump.dataset.jump);
  const read = t.closest("[data-read]");
  if (read) {
    setPlanTab(v, "doc");
    history.replaceState(null, "", planHref(v.ws, v.file, "doc"));
    scrollToId(read.dataset.read);
  }
  const toc = t.closest("[data-toc]");
  if (toc) scrollToId(toc.dataset.toc);
}

// ---------- session page ----------

const AVATAR = { rv: "avatars/reviewer.png", ag: "avatars/agent.png", us: "avatars/you.png" };
const NAME = { rv: "Reviewer", ag: "Agent", us: "You" };
const REVIEWER_LETTERS = { codex: "CX" };
const CALLER_LETTERS = { "claude-code": "CC", "codex-mcp-client": "CX" };
/** table[key] for the table's own keys only: names from session data can be "constructor" or "__proto__". */
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Letters (the image's alt and fallback) and tooltip of each side. */
function party(who, d) {
  if (who === "us") return { letters: "Y", tip: "You" };
  if (who === "rv") {
    const r = d.facts.reviewer;
    return { letters: own(REVIEWER_LETTERS, r) || r.slice(0, 2).toUpperCase(), tip: own(REVIEWERS, r) || r };
  }
  const c = d.facts.caller || {};
  return { letters: own(CALLER_LETTERS, c.name) || initial(c.title), tip: (c.title || "").trim() || "Agent" };
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
    const prev = groups[groups.length - 1];
    // a round opens with the ask or the agent's reply; without them (a session that kept no
    // inputs) the reviewer's next round opens it
    const nextRound = prev && prev.round != null && x.who === "rv" && x.round != null && x.round !== prev.round;
    if (x.kind === "ask" || x.kind === "reply" || !prev || nextRound) groups.push({ round: null, items: [] });
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
  const reviewer = own(REVIEWERS, f.reviewer) || f.reviewer;
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
let savesStarted = 0; // counts saves sent; a settings load that saw one start meanwhile is asked again

const ALL_PATHS = ["reviewer", "model", "effort", "open_dashboard", "open_plans", "track_plans", ...SKILLS.flatMap(s => [`skills.${s}.model`, `skills.${s}.effort`])];
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

const onSettings = () => parseRoute(location.hash)?.view === "settings";

/** Point the form at the route's level; false when the route names a workspace the page does not know. */
function pickScope(r) {
  const names = Object.keys(settings.workspaces);
  if (r.ws && !names.includes(r.ws)) return false;
  sv.scope = r.ws ? "workspace" : "global";
  sv.ws = r.ws || (sv.ws && names.includes(sv.ws) ? sv.ws : names[0] || null);
  return true;
}

/** Take a model list from /api/models or /api/settings. */
function applyCatalog(m) {
  Object.assign(settings, { models: m.models, modelsFetchedAt: m.fetchedAt, codexDefault: m.codexDefault, reviewer: m.reviewer });
  catalogInfo = { models: m.models, codexDefault: m.codexDefault };
}

async function openSettings(r) {
  const load = ++settingsLoad;
  // Settings loaded before show at once; the answer below then replaces what nobody touched
  const early = Boolean(settings && !pendingSave && pickScope(r));
  if (early) {
    resetDraft();
    renderSettings();
  }
  let s, a;
  for (;;) {
    if (pendingSave) await pendingSave.catch(() => null);
    const saves = savesStarted;
    [s, a] = await Promise.all([getJson("/api/settings"), getJson("/api/avatars")]);
    // a newer Settings page was opened meanwhile, or the user left Settings
    if (load !== settingsLoad || !onSettings()) return;
    // an answer that may predate a save made meanwhile is asked again
    if (saves === savesStarted) break;
  }
  if (!s) {
    $("#settings-error").textContent = "The settings could not be loaded.";
    return;
  }
  settings = s;
  catalogInfo = { models: s.models, codexDefault: s.codexDefault };
  if (a) avatars = a;
  if (!pickScope(r)) {
    location.replace("#/settings");
    return;
  }
  // the fields the user changed while this loaded stay as they are
  if (early && sv.touched.size) sv.draft = mergeForm(savedConfig(), sv.draft, sv.touched);
  else resetDraft();
  renderSettings();
  followCatalog(s);
}

/** The list in `s` is the one the server saved last time and it is asking the reviewer again: take the new one when it comes. */
async function followCatalog(s) {
  if (!s.modelsRefreshing) return;
  const m = await getJson("/api/models");
  if (!m || settings !== s) return;
  applyCatalog(m);
  if (onSettings()) renderSettings();
  redrawFacts();
}

/** A session page names its model from the catalog: draw it again when the catalog changes. */
function redrawFacts() {
  if (view && view.detail) {
    view.sig = null;
    renderDetail(view);
  }
}

function resetDraft() {
  sv.draft = clone(savedConfig());
  sv.touched = new Set();
  $("#save-error").textContent = "";
  $("#plans-warn").textContent = "";
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
  $("#settings-error").textContent = (workspace ? own(settings.errors.workspaces, ws) : settings.errors.global) || "";

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
  const showPlans = d.open_plans;
  $("#f-showplans").innerHTML = optionsHtml([
    ...(workspace ? [{ value: "", label: `Inherit — ${settings.global.open_plans === true ? "on" : "off"}`, selected: showPlans === undefined }] : []),
    { value: "on", label: "On — open each finished plan", selected: showPlans === true },
    { value: "off", label: "Off", selected: showPlans === false || (!workspace && showPlans !== true) },
  ]);
  const track = d.track_plans;
  $("#f-plans").innerHTML = optionsHtml([
    ...(workspace ? [{ value: "", label: `Inherit — ${settings.global.track_plans === true ? "on" : "off"}`, selected: track === undefined }] : []),
    { value: "off", label: "Off — git ignores plans (default)", selected: track === false || (!workspace && track !== true) },
    { value: "on", label: "On — commit plans with the code", selected: track === true },
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
    const letters = p.who === "us" ? "Y" : p.who === "rv" ? "CX" : p.name ? own(CALLER_LETTERS, p.name) || initial(p.label.split(" · ")[1]) : "AG";
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
  const onOff = { "f-follow": "open_dashboard", "f-showplans": "open_plans", "f-plans": "track_plans" };
  if (Object.hasOwn(onOff, t.id)) {
    // Off at the global level is the default: the key is dropped
    const v = t.value === "on" ? true : t.value === "off" ? (sv.scope === "workspace" ? false : undefined) : undefined;
    setPath(sv.draft, onOff[t.id], v);
    sv.touched.add(onOff[t.id]);
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
      applyCatalog(m);
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
    savesStarted++;
    pendingSave = fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const res = await pendingSave.catch(() => null);
      const same = sv.scope === scope && sv.ws === ws && sv.draft === draft;
      if (!res || !res.ok) {
        const msg = res ? (await res.json().catch(() => ({}))).error : null;
        if (same) $("#save-error").textContent = msg || "The settings could not be saved.";
        return;
      }
      const answer = await res.json();
      const saved = answer.config;
      // the saved file replaced the one that failed to load
      if (scope === "global") {
        settings.global = saved;
        settings.errors.global = undefined;
      } else {
        settings.workspaces[ws] = saved;
        delete settings.errors.workspaces[ws];
      }
      const trackTouched = sv.touched.has("track_plans");
      if (same && JSON.stringify(sv.draft) === sent) resetDraft();
      if (same) $("#plans-warn").textContent = gitignoreNotes(answer.gitignore, trackTouched);
      renderSettings();
    } finally {
      pendingSave = null;
      $("#save").disabled = false;
    }
  }
}

/** What a save did to each workspace's .gitignore that the user should know. */
function gitignoreNotes(gitignore, trackTouched) {
  const lines = [];
  for (const [ws, g] of Object.entries(gitignore || {})) {
    const name = (settings.names && own(settings.names, ws)) || ws;
    if (g.warning) lines.push(`${name}: ${g.warning}`);
    else if (g.result === "custom" && trackTouched) lines.push(`.cross-review/.gitignore of ${name} was edited by hand; it was not changed.`);
    else if (g.result === "error") lines.push(`.cross-review/.gitignore of ${name} could not be written.`);
  }
  return lines.join("\n");
}

// ---------- data ----------

function apply(payload) {
  data = payload;
  skew = (payload.serverTime || Date.now() / 1000) - Date.now() / 1000;
  renderWhere();
  renderSessions();
  renderPlans();
  followPlan();
}

async function start() {
  document.querySelectorAll("[data-i]").forEach(el => el.insertAdjacentHTML("afterbegin", ic(el.dataset.i)));
  // filtering goes back to the first page
  for (const [pg, render, ids, search] of [[hist, () => renderHistory(), ["#f-ws", "#f-skill", "#f-result"], "#f-search"], [plansPage, () => renderPlans(), ["#pf-ws", "#pf-state"], "#pf-search"]]) {
    const refilter = () => {
      pg.offset = 0;
      pg.back_ = [];
      if (data) render();
    };
    for (const id of ids) $(id).addEventListener("change", refilter);
    $(search).addEventListener("input", refilter);
    $(pg.pager).addEventListener("click", e => {
      const a = e.target.closest(`a[data-${pg.attr}]`);
      if (!a || !data) return;
      turnPage(pg, Number(a.getAttribute(`data-${pg.attr}`)));
      render();
    });
  }
  window.addEventListener("resize", () => {
    if (data && $("#sessions").classList.contains("on")) renderHistory();
    if (data && $("#plans").classList.contains("on")) renderPlans();
  });
  document.addEventListener("click", e => {
    const row = e.target.closest("tr[data-go]");
    if (row && !e.target.closest("a")) location.hash = row.dataset.go;
    if (e.target.closest("#detail")) onDetailClick(e);
    if (e.target.closest("#plan")) onPlanClick(e);
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
  // loaded in the background, so Settings opens filled in and session pages name their models
  if (!onSettings()) {
    getJson("/api/settings").then(s => {
      if (!s || settings) return;
      settings = s;
      catalogInfo = { models: s.models, codexDefault: s.codexDefault };
      redrawFacts();
      followCatalog(s);
    });
  }
  setInterval(tickClocks, 1000);
}

if (typeof document !== "undefined") start();
