// Markdown from session files (reviews, requests, replies) as HTML. Everything is escaped
// first; only the tags built here appear: headings, paragraphs, lists, code spans and
// fences, bold, italics, and links to http(s) addresses. No raw HTML passes through.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

/** One line of text: code spans, links, bold, italics. */
export function renderInline(text) {
  const out = [];
  // Code spans are cut out first so nothing inside them is formatted
  const parts = String(text ?? "").split(/(`[^`]+`)/);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(`<code>${esc(part.slice(1, -1))}</code>`);
      continue;
    }
    let html = esc(part);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      // href is already escaped; a quote in it is &quot; and cannot end the attribute
      if (!/^https?:\/\//i.test(href)) return m;
      return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`;
    });
    html = html.replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>");
    html = html.replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
    out.push(html);
  }
  return out.join("");
}

/** A block of markdown → HTML. */
export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map(x => `<li>${renderInline(x)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flushPara();
      flushList();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      html.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushPara();
      flushList();
      // inside a message, # and ## read as h3: the page already has h1/h2
      const n = Math.max(3, h[1].length);
      html.push(`<h${n}>${renderInline(h[2])}</h${n}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return html.join("");
}

/** A finding's field: inline when it is one line, blocks (code fences, lists) when it has several. */
export function renderField(text) {
  const s = String(text ?? "");
  return s.includes("\n") ? renderMarkdown(s) : renderInline(s);
}
