// The dashboard page: hash routes, the Sessions view (live "In progress" and filtered
// History) and the header. Data comes from /api/sessions and the list stream; the "For"
// clocks tick here, against the server's clock.

import { ic } from "./icons.js";

const $ = sel => document.querySelector(sel);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);
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
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === r.view));
  // a session's page lights the Sessions tab
  const tab = r.view === "settings" ? "settings" : "sessions";
  document.querySelectorAll(".top nav a").forEach(a => a.classList.toggle("on", a.dataset.nav === tab));
  if (r.view === "detail") renderDetail(r);
  window.scrollTo(0, 0);
}

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

// ---------- session page (filled in by the detail view) ----------

async function renderDetail(r) {
  const s = data && [...data.active, ...data.history].find(x => x.ws === r.ws && x.id === r.id);
  $("#d-ws").textContent = s ? s.wsName : r.ws;
  $("#d-title").innerHTML = s ? inline(s.title) : esc(r.id);
  $("#d-meta").innerHTML = `<span>${esc(s ? s.skill : "")}</span><span class="mono">${esc(r.id)}</span>`;
}

// ---------- data ----------

function apply(payload) {
  data = payload;
  skew = (payload.serverTime || Date.now() / 1000) - Date.now() / 1000;
  renderWhere();
  renderSessions();
  const r = parseRoute(location.hash);
  if (r && r.view === "detail") renderDetail(r);
}

async function start() {
  document.querySelectorAll("[data-i]").forEach(el => el.insertAdjacentHTML("afterbegin", ic(el.dataset.i)));
  for (const id of ["#f-ws", "#f-skill", "#f-result"]) $(id).addEventListener("change", () => data && renderHistory());
  $("#f-search").addEventListener("input", () => data && renderHistory());
  document.addEventListener("click", e => {
    const row = e.target.closest("tr[data-go]");
    if (row && !e.target.closest("a")) location.hash = row.dataset.go;
  });
  window.addEventListener("hashchange", route);
  route();
  try {
    const res = await fetch("/api/sessions");
    if (res.ok) apply(await res.json());
  } catch {}
  const stream = new EventSource("/api/stream?view=list");
  stream.addEventListener("sessions", e => apply(JSON.parse(e.data)));
  setInterval(tickClocks, 1000);
}

if (typeof document !== "undefined") start();
