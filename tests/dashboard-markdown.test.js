// ui/markdown.js: session text (reviews, requests, replies) as safe HTML.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown, renderInline } from "../skill-packs/cross-review/scripts/lib/dashboard/ui/markdown.js";

test("raw HTML is text, never markup", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)> and <script>alert(2)</script>");
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;/);
});

test("links: only http(s) become anchors, with rel; javascript: and quotes stay text", () => {
  assert.doesNotMatch(renderMarkdown("[a](javascript:alert(1))"), /<a /);
  assert.doesNotMatch(renderMarkdown("[a](data:text/html,x)"), /<a /);
  const ok = renderMarkdown("see [the docs](https://example.com/a?b=1&c=2)");
  assert.match(ok, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">the docs<\/a>/);
  assert.doesNotMatch(renderMarkdown('[x](https://e.com/" onmouseover="alert(1))'), /" onmouseover="/);
});

test("fences keep their content verbatim and escaped; no formatting inside", () => {
  const html = renderMarkdown("before\n```js\nconst a = `x` * 2; // **not bold** <b>\n\n  indented\n```\nafter");
  assert.match(html, /<pre><code>const a = `x` \* 2; \/\/ \*\*not bold\*\* &lt;b&gt;\n\n  indented<\/code><\/pre>/);
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<p>after<\/p>/);
});

test("headings, lists, paragraphs, code spans, bold and italics get their tags", () => {
  const html = renderMarkdown("### Position\nStart with a **fixed** set of *tags*.\nSecond line.\n\n- one `a<b>`\n- two\n\n1. first\n2. second");
  assert.match(html, /<h3>Position<\/h3>/);
  assert.match(html, /<p>Start with a <strong>fixed<\/strong> set of <em>tags<\/em>\.<br>Second line\.<\/p>/);
  assert.match(html, /<ul><li>one <code>a&lt;b&gt;<\/code><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.equal(renderInline("snake_case_name stays"), "snake_case_name stays");
  assert.equal(renderInline("`**x**`"), "<code>**x**</code>");
});
