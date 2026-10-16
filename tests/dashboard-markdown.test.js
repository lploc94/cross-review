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

test("renderField: one line stays inline; several lines (fenced code) render as blocks", async () => {
  const { renderField } = await import("../skill-packs/cross-review/scripts/lib/dashboard/ui/markdown.js");
  assert.equal(renderField("Uses `x` here"), "Uses <code>x</code> here");
  const html = renderField("The guard:\n```js\nif (ready) {\n  commit();\n}\n```");
  assert.match(html, /<pre><code>if \(ready\) \{\n  commit\(\);\n\}<\/code><\/pre>/);
  assert.ok(!html.includes("``"));
});

test("tables: header, divider, body; cells escaped and inline; ragged rows padded or cut", () => {
  const html = renderMarkdown("Before\n| Decision | Reason |\n|---|:--|\n| Dates in `UTC` | <script>x</script> |\n| only one |\n| a | b | extra |\nafter");
  assert.match(html, /<p>Before<\/p><table><thead><tr><th>Decision<\/th><th>Reason<\/th><\/tr><\/thead><tbody>/);
  assert.match(html, /<tr><td>Dates in <code>UTC<\/code><\/td><td>&lt;script&gt;x&lt;\/script&gt;<\/td><\/tr>/);
  assert.match(html, /<tr><td>only one<\/td><td><\/td><\/tr>/);
  assert.match(html, /<tr><td>a<\/td><td>b<\/td><\/tr><\/tbody><\/table><p>after<\/p>/);
  assert.doesNotMatch(html, /extra|<script/);
  // a pipe line without a divider is text; a pipe inside a code span does not split the cell
  assert.doesNotMatch(renderMarkdown("| not | a table |\nplain"), /<table/);
  assert.match(renderMarkdown("| A | B |\n|---|---|\n| `x|y` | z |"), /<td><code>x\|y<\/code><\/td><td>z<\/td>/);
});

test("tables: an escaped pipe stays in its cell and keeps the cells after it", () => {
  const html = renderMarkdown("| Choice | Meaning |\n|---|---|\n| left\\|right | keep both |\n| `a\\|b` | ends on \\| |");
  assert.match(html, /<tr><td>left\|right<\/td><td>keep both<\/td><\/tr>/);
  assert.match(html, /<tr><td><code>a\|b<\/code><\/td><td>ends on \|<\/td><\/tr>/);
});

test("task lists: - [ ] and - [x] become li.task with a box icon; other items stay plain", () => {
  const html = renderMarkdown("- [ ] AC-1.1: open `a<b>`\n- [x] AC-1.2: done\n- [X] AC-1.3: done too\n- plain");
  const items = html.match(/<li[^>]*>.*?<\/li>/g);
  assert.equal(items.length, 4);
  assert.match(items[0], /^<li class="task"><svg class="i "[^>]*>.*<\/svg><span>AC-1\.1: open <code>a&lt;b&gt;<\/code><\/span><\/li>$/);
  assert.doesNotMatch(items[0], /m9 12 2 2 4-4/);
  assert.match(items[1], /^<li class="task met"><svg[^>]*>.*m9 12 2 2 4-4.*<\/svg><span>AC-1\.2: done<\/span><\/li>$/);
  assert.match(items[2], /^<li class="task met">/);
  assert.equal(items[3], "<li>plain</li>");
});

test("a fence holding pipes and task boxes stays a fence", () => {
  const html = renderMarkdown("```\n| A | B |\n|---|---|\n- [x] AC-9.1\n```");
  assert.doesNotMatch(html, /<table|class="task"/);
  assert.match(html, /<pre><code>\| A \| B \|\n\|---\|---\|\n- \[x\] AC-9\.1<\/code><\/pre>/);
});

test("a fence closes only on a bare delimiter at least as long; a heading keeps a # in its text", () => {
  const html = renderMarkdown("````markdown\n```js\n## inside\n```\n````\nafter\n\n~~~\n~~~ not a close\n~~~  \n### Port to C# ##");
  assert.match(html, /^<pre><code>```js\n## inside\n```<\/code><\/pre><p>after<\/p><pre><code>~~~ not a close<\/code><\/pre><h3>Port to C#<\/h3>$/);
});
