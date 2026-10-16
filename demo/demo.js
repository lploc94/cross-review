// The dashboard demo's data layer, loaded before app.js (build.mjs adds it to index.html).
// It answers the UI's requests (fetch and EventSource to /api/...) from data.json, which
// build.mjs recorded from the real dashboard server, and plays the recorded steps: each step
// changes some answers, and the open streams get the events the server would have sent.
// Framed by another page, it does not scroll.
// The page that embeds the demo controls it with postMessage: {demo: "play" | "pause" |
// "replay" | "view", view}; the demo reports {demo: "ready" | "view" | "manual" | "end"}. A page
// whose script ran after the demo said "ready" sends "hello", and the demo says "ready" again.
// Opened on its own it plays at once (with ?paused, it waits for "play").
(() => {
  "use strict";
  const realFetch = window.fetch.bind(window);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const parent = window.parent !== window ? window.parent : null;
  const tell = msg => parent && parent.postMessage({ demo: msg.type, ...msg }, location.origin);
  // Framed, the page never scrolls: the embedding page gives the frame the height the Sessions list
  // needs and scales it to the window, and a wheel over the demo scrolls the page around it.
  if (parent) {
    const style = document.createElement("style");
    style.textContent = "html, body { overflow: hidden !important; }";
    document.documentElement.append(style);
  }

  let data = null;
  let step = 0;
  let stepAt = Date.now();
  let timer = 0;
  let playing = false;
  // the demo opens each step's view until the reader clicks, types or picks a view
  let guided = true;
  const streams = new Set();
  const loaded = realFetch(new URL("data.json", location.href)).then(r => r.json()).then(d => {
    data = d;
    if (reduced) step = d.steps.length - 1;
  });

  // ---------- answers ----------

  /** The recorded answer for `key` at step `at` (the last one recorded at or before it). */
  const answer = (key, at = step) => {
    const list = data.res[key];
    if (!list) return undefined;
    let hit;
    for (const [i, body] of list) if (i <= at) hit = body;
    return hit;
  };
  const clockNow = () => data.steps[step].now + (Date.now() - stepAt) / 1000;
  const withTime = body => (body && typeof body === "object" && !Array.isArray(body) ? { ...body, serverTime: clockNow() } : body);
  const sessionKey = p => `ws=${encodeURIComponent(p.get("ws") || "")}&id=${encodeURIComponent(p.get("id") || "")}`;
  const keyOf = (route, p) => {
    const q = new URLSearchParams();
    for (const name of ["ws", "id", "file", "round", "reviewer"]) if (p.has(name)) q.set(name, p.get(name));
    const s = q.toString();
    return s ? `${route}?${s}` : route;
  };
  const latestRound = (key, at = step) => {
    const d = answer(`/api/session?${key}`, at);
    return d ? d.currentRound : 0;
  };
  /** /api/activity: the recorded items of the round, paged as the server pages them. */
  function activity(p) {
    const key = new URLSearchParams({ ws: p.get("ws") || "", id: p.get("id") || "" }).toString();
    const round = p.has("round") ? Number(p.get("round")) : latestRound(key);
    const items = answer(`/api/activity?${key}&round=${round}`);
    if (!items) return [404, { error: "no such round" }];
    const before = p.has("before") ? Number(p.get("before")) : null;
    const limit = p.has("limit") ? Number(p.get("limit")) : 200;
    const older = before === null ? items : items.filter(it => it.line < before);
    const page = older.slice(-limit);
    return [200, { round, items: page, total: items.length, hasEarlier: older.length > page.length }];
  }
  function respond(url, method) {
    const route = url.pathname;
    const p = url.searchParams;
    if (method !== "GET") {
      if (route === "/api/settings") return [400, { error: "This is a demo: settings are not saved." }];
      return [200, { ok: true }];
    }
    if (route === "/api/activity") return activity(p);
    if (route === "/api/prompt") {
      const text = answer(keyOf(route, p));
      return text ? [200, text, "text/plain"] : [404, { error: "no such prompt" }];
    }
    if (route === "/api/health") return [200, { ok: true }];
    const body = answer(keyOf(route, p));
    return body === undefined ? [404, { error: "not found" }] : [200, withTime(body)];
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    await loaded;
    const [status, body, type] = respond(url, (init.method || "GET").toUpperCase());
    const text = type === "text/plain" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": type === "text/plain" ? "text/plain; charset=utf-8" : "application/json" } });
  };

  // ---------- streams ----------

  /** The server's /api/stream, replayed: list → `sessions`; session → `snapshot`, `session`, `activity`. */
  class DemoStream {
    constructor(url) {
      this.url = new URL(url, location.href);
      this.listeners = new Map();
      this.readyState = 0;
      streams.add(this);
      loaded.then(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.open();
      });
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) {
      if (this.listeners.has(name)) this.listeners.get(name).delete(fn);
    }
    close() {
      this.readyState = 2;
      streams.delete(this);
    }
    emit(name, value) {
      const ev = new MessageEvent(name, { data: JSON.stringify(value) });
      setTimeout(() => {
        if (this.readyState !== 1) return;
        for (const fn of this.listeners.get(name) || []) fn(ev);
      }, 0);
    }
    get view() {
      return this.url.searchParams.get("view");
    }
    get key() {
      return sessionKey(this.url.searchParams);
    }
    open() {
      if (this.view === "list") this.emit("sessions", withTime(answer("/api/sessions")));
      else {
        const round = latestRound(this.key);
        const items = answer(`/api/activity?${this.key}&round=${round}`) || [];
        this.emit("snapshot", { round, total: items.length });
      }
    }
    /** What changed from step `from` to the current one. */
    advance(from) {
      if (this.readyState !== 1) return;
      if (this.view === "list") {
        this.emit("sessions", withTime(answer("/api/sessions")));
        return;
      }
      const round = latestRound(this.key);
      // every step, so the page also takes the step's clock (the demo's clock jumps while a test runs)
      this.emit("session", { round });
      // a new round starts a new list, as on the server
      const before = latestRound(this.key, from) === round ? answer(`/api/activity?${this.key}&round=${round}`, from) || [] : [];
      const was = new Map(before.map(it => [it.key, `${it.lastLine}:${it.t}`]));
      const items = answer(`/api/activity?${this.key}&round=${round}`) || [];
      for (const it of items) {
        const v = `${it.lastLine}:${it.t}`;
        if (!was.has(it.key)) this.emit("activity", { op: "add", key: it.key, item: it, total: items.length });
        else if (was.get(it.key) !== v) this.emit("activity", { op: "update", key: it.key, item: it, total: items.length });
      }
    }
  }
  window.EventSource = DemoStream;

  // ---------- playing ----------

  const openView = name => {
    const hash = data.views[name];
    if (hash && location.hash !== hash) location.hash = hash;
  };
  function go(n) {
    const from = step;
    step = n;
    stepAt = Date.now();
    for (const s of streams) s.advance(from);
    if (guided && data.steps[n].view !== data.steps[from].view) openView(data.steps[n].view);
    if (n === data.steps.length - 1) tell({ type: "end" });
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing || step >= data.steps.length - 1) return;
    timer = setTimeout(() => {
      go(step + 1);
      schedule();
    }, Math.max(0, data.steps[step].ms - (Date.now() - stepAt)));
  }
  const viewOf = hash => {
    if (/^#\/s\//.test(hash)) return "session";
    if (/^#\/p\//.test(hash)) return "plan";
    if (/^#\/plans/.test(hash)) return "plans";
    if (/^#\/settings/.test(hash)) return "settings";
    return "sessions";
  };

  const sayReady = () => tell({ type: "ready", view: viewOf(location.hash), steps: data.steps.length, reduced });
  window.addEventListener("message", e => {
    if (e.origin !== location.origin || !e.data || typeof e.data.demo !== "string") return;
    loaded.then(() => {
      const cmd = e.data.demo;
      if (cmd === "hello") sayReady();
      else if (cmd === "play" && !reduced) {
        if (!playing) stepAt = Date.now();
        playing = true;
        schedule();
      } else if (cmd === "pause") {
        playing = false;
        clearTimeout(timer);
      } else if (cmd === "replay") {
        location.hash = data.views.sessions;
        location.reload();
      } else if (cmd === "view" && data.views[e.data.view]) {
        guided = false;
        openView(e.data.view);
      }
    });
  });
  // a reader who clicks or types inside the demo takes over the view
  const takeOver = () => {
    if (!guided) return;
    guided = false;
    tell({ type: "manual" });
  };
  for (const name of ["pointerdown", "keydown"]) window.addEventListener(name, takeOver, { passive: true, capture: true });
  window.addEventListener("hashchange", () => tell({ type: "view", view: viewOf(location.hash) }));
  loaded.then(() => {
    if (guided && !reduced && location.hash !== data.views[data.steps[0].view]) openView(data.steps[0].view);
    sayReady();
    // opened on its own (not embedded): play at once, unless ?paused (the promo video starts it)
    if (!parent && !new URLSearchParams(location.search).has("paused")) window.postMessage({ demo: "play" }, location.origin);
  });
})();
