// Reviewer activity in words: one short sentence per item (a file read, a search, a test
// run), consecutive reads folded into one line, and the wall-clock time of each item.
// Pure: no I/O. Items come from the reviewer adapter's activityItems().

const TEXT_MAX = 200;

/** Split a shell command into words, honouring single and double quotes and backslashes. */
export function shellWords(s) {
  const words = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (cur || has) words.push(cur);
  return words;
}

/** `/bin/zsh -lc '…'` or `bash -lc "…"` → the inner command; anything else unchanged. */
export function unwrapShell(command) {
  const m = String(command || "").trim().match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!m) return String(command || "").trim();
  const words = shellWords(m[1]);
  return words.length === 1 ? words[0] : m[1];
}

/** Split on &&, ||, ;, | outside quotes. Returns [{text, op}] where op is the separator after it. */
function segments(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') { cur += c + (cmd[++i] ?? ""); continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ text: cur.trim(), op: two }); cur = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "\n") { out.push({ text: cur.trim(), op: c }); cur = ""; continue; }
    cur += c;
  }
  out.push({ text: cur.trim(), op: null });
  return out.filter(s => s.text);
}

const TEST_RE = /^(?:npm\s+(?:run\s+)?test|node\s+--test|pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|npx\s+(?:vitest|jest)|yarn\s+test|pnpm\s+(?:run\s+)?test)\b/;

function sedRange(words) {
  // sed -n '41,80p' FILE  |  sed -n 41,80p
  const i = words.indexOf("-n");
  const spec = i >= 0 ? words[i + 1] : null;
  const m = spec && spec.match(/^(\d+)(?:,(\d+))?p$/);
  return m ? { from: m[1], to: m[2] || m[1], file: words[i + 2] || null } : null;
}

function readTarget(seg, next) {
  const w = shellWords(seg);
  const cmd = w[0];
  const files = w.slice(1).filter(x => !x.startsWith("-") && !/^\d+$/.test(x));
  if (cmd === "sed") {
    const r = sedRange(w);
    if (r && r.file) return `${r.file}:${r.from}-${r.to}`;
    return null;
  }
  if (cmd === "cat" || cmd === "nl" || cmd === "head" || cmd === "tail") {
    const file = files[0];
    if (!file) return null;
    const r = next ? sedRange(shellWords(next)) : null;
    if (r && !r.file) return `${file}:${r.from}-${r.to}`;
    return file;
  }
  return null;
}

function searchTarget(seg) {
  const w = shellWords(seg);
  const args = w[0] === "git" ? w.slice(2) : w.slice(1);
  const valueFlags = new Set(["-g", "--glob", "-t", "--type", "-e", "-A", "-B", "-C", "-m", "--max-count"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e") return args[i + 1] || "";
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "";
}

const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
const clip = (s, n = TEXT_MAX) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * One item → { kind, what, text, raw, failed? }.
 * kind: read | search | test | diff | think | scratch | run | tool | change.
 * `text` is the whole sentence (used for "Now"); `what` its variable part; `raw` the command.
 */
export function humanize(item) {
  if (item.kind === "message" || item.kind === "reasoning") {
    const what = clip(oneLine(item.text));
    return { kind: "think", what, text: `Thinking: ${what}`, raw: null };
  }
  if (item.kind === "tool") {
    const what = item.text ? `${item.tool} ${clip(oneLine(item.text), 120)}` : item.tool;
    return { kind: "tool", what, text: `Used ${what}`, raw: null };
  }
  if (item.kind === "file_change") {
    return { kind: "change", what: item.path || "files", text: `Changed ${item.path || "files"}`, raw: null };
  }
  const raw = String(item.command || "");
  const inner = unwrapShell(raw);
  const segs = segments(inner);
  // `cd dir && …` is about the command after it
  let i = 0;
  while (i < segs.length - 1 && /^cd(\s|$)/.test(segs[i].text) && segs[i].op === "&&") i++;
  const seg = segs[i] ? segs[i].text : inner;
  const next = segs[i] && segs[i].op === "|" && segs[i + 1] ? segs[i + 1].text : null;
  const first = shellWords(seg)[0] || "";

  if (/\bmktemp\b/.test(inner)) {
    const what = clip(oneLine(inner), 120);
    return { kind: "scratch", what, text: `Worked in a scratch dir: ${what}`, raw };
  }
  if (TEST_RE.test(seg)) {
    const what = clip(oneLine(seg), 120);
    let result;
    if (item.status === "in_progress" || item.exitCode === null || item.exitCode === undefined) result = "running";
    else if (item.exitCode === 0) result = "passed";
    else result = `failed (exit ${item.exitCode})`;
    return { kind: "test", what, result, text: `Ran tests: ${what} — ${result}`, raw, failed: result.startsWith("failed") };
  }
  const read = readTarget(seg, next);
  if (read) return { kind: "read", what: read, text: `Read ${read}`, raw };
  if (first === "rg" || first === "grep" || (first === "git" && shellWords(seg)[1] === "grep")) {
    const what = clip(searchTarget(seg), 120);
    return { kind: "search", what, text: `Searched for ${what}`, raw };
  }
  if (first === "git" && /^(diff|show|log)$/.test(shellWords(seg)[1] || "")) {
    const what = clip(oneLine(shellWords(seg).slice(2).join(" ")) || shellWords(seg)[1], 120);
    return { kind: "diff", what, text: `Looked at the change in ${what}`, raw };
  }
  const what = clip(oneLine(inner), 120);
  return { kind: "run", what, text: `Ran ${what}`, raw };
}

/** Fold consecutive reads into one group: [{kind, items}]. */
export function groupReads(list) {
  const out = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (a.kind === "read" && last && last.kind === "read") last.items.push(a);
    else out.push({ kind: a.kind, items: [a] });
  }
  return out;
}

/**
 * Seconds since the round started for each item: the time of the first times row whose
 * line count exceeds the item's first line. null without a row (sessions before line times).
 */
export function attachTimes(items, timesRows, roundStartedAt) {
  return items.map(item => {
    const row = timesRows.find(r => r[0] > item.line);
    const t = row && roundStartedAt ? Math.max(0, row[1] - roundStartedAt) : null;
    return { ...item, t };
  });
}
