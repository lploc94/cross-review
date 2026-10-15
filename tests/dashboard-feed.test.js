// ui/feed.js: the live activity feed merged by key, page loads after (re)connects, and what
// a snapshot asks the page to do.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newFeed, mergeActivity, applyPage, visible, onSnapshot } from "../skill-packs/cross-review/scripts/lib/dashboard/ui/feed.js";

const item = (n, extra = {}) => ({ key: `3:item_${n}`, line: n * 2, lastLine: n * 2, text: `Read f${n}`, kind: "read", ...extra });
const add = (it, total) => ({ op: "add", key: it.key, item: it, total });
const update = (it, total) => ({ op: "update", key: it.key, item: it, total });
const keys = feed => visible(feed).map(x => x.key);

test("add twice with the same key keeps one line", () => {
  const f = newFeed(3);
  mergeActivity(f, add(item(1), 1));
  mergeActivity(f, add(item(1), 1));
  assert.deepEqual(keys(f), ["3:item_1"]);
  assert.equal(f.total, 1);
});

test("update replaces the line in place; order does not change", () => {
  const f = newFeed(3);
  for (const n of [1, 2, 3]) mergeActivity(f, add(item(n), n));
  mergeActivity(f, update(item(2, { lastLine: 9, exitCode: 1, text: "Ran tests — failed (exit 1)" }), 3));
  assert.deepEqual(keys(f), ["3:item_1", "3:item_2", "3:item_3"]);
  assert.equal(visible(f)[1].exitCode, 1);
  // an older copy never wins over a newer one
  mergeActivity(f, update(item(2), 3));
  assert.equal(visible(f)[1].exitCode, 1);
});

test("a page that arrives after buffered events with the same keys: no duplicates, the later lastLine wins", () => {
  const f = newFeed(3);
  const buffered = [add(item(5), 5), update(item(4, { lastLine: 20, exitCode: 0 }), 5)];
  applyPage(f, { round: 3, items: [1, 2, 3, 4].map(n => item(n)), total: 4, hasEarlier: false });
  for (const ev of buffered) mergeActivity(f, ev);
  assert.deepEqual(keys(f), [1, 2, 3, 4, 5].map(n => `3:item_${n}`));
  assert.equal(visible(f)[3].exitCode, 0);
  // and the other way round: events first, then the page with the older copy of item 4
  const g = newFeed(3);
  for (const ev of buffered) mergeActivity(g, ev);
  applyPage(g, { round: 3, items: [1, 2, 3, 4].map(n => item(n)), total: 4, hasEarlier: false });
  assert.deepEqual(keys(g), [1, 2, 3, 4, 5].map(n => `3:item_${n}`));
  assert.equal(visible(g)[3].exitCode, 0);
  assert.equal(g.total, 5);
});

test("a gap while disconnected: the new page fills it; 22 distinct items, the window shows the latest 20", () => {
  const f = newFeed(3);
  applyPage(f, { round: 3, items: Array.from({ length: 20 }, (_, i) => item(i + 1)), total: 20, hasEarlier: false });
  // while away: items 21 and 22 appeared, item 20 completed
  const page = [...Array.from({ length: 17 }, (_, i) => item(i + 6)).filter(x => x.key !== "3:item_20"), item(20, { lastLine: 50, exitCode: 0 })]
    .sort((a, b) => a.line - b.line);
  applyPage(f, { round: 3, items: page, total: 22, hasEarlier: true });
  assert.equal(f.total, 22);
  assert.equal(f.order.length, 22);
  assert.deepEqual(keys(f), Array.from({ length: 20 }, (_, i) => `3:item_${i + 3}`));
  assert.equal(new Set(keys(f)).size, 20);
  assert.equal(visible(f).find(x => x.key === "3:item_20").exitCode, 0);
  f.shown = 40;
  assert.equal(visible(f).length, 22);
});

test("a page or snapshot for another round resets the feed", () => {
  const f = newFeed(3);
  mergeActivity(f, add(item(1), 1));
  f.shown = 40;
  applyPage(f, { round: 4, items: [{ ...item(1), key: "4:item_1" }], total: 1, hasEarlier: false });
  assert.equal(f.round, 4);
  assert.deepEqual(keys(f), ["4:item_1"]);
  assert.equal(f.shown, 20);
});

test("onSnapshot: every snapshot reloads the detail and the activity page; a new round also resets the feed", () => {
  const view = { feed: newFeed(3) };
  assert.deepEqual(onSnapshot(view, { round: 3, total: 12 }), ["reloadDetail", "fetchActivity"]);
  assert.deepEqual(onSnapshot(view, { round: 4, total: 0 }), ["resetFeed", "reloadDetail", "fetchActivity"]);
  assert.deepEqual(onSnapshot({ feed: null }, { round: 1, total: 0 }), ["resetFeed", "reloadDetail", "fetchActivity"]);
});

test("reconnect after a long gap: a latest page that does not reach the cached items replaces them, so show earlier pages from the right place", () => {
  const f = newFeed(3);
  applyPage(f, { round: 3, items: [1, 2, 3].map(n => item(n)), total: 3, hasEarlier: false });
  f.shown = 40;
  // while away, items 4..80 were written; the latest page holds 61..80
  applyPage(f, { round: 3, items: Array.from({ length: 20 }, (_, i) => item(61 + i)), total: 80, hasEarlier: true }, { latest: true });
  assert.deepEqual(keys(f), Array.from({ length: 20 }, (_, i) => `3:item_${61 + i}`));
  assert.equal(f.order[0], "3:item_61", "the next `before` is item 61, not item 1");
  assert.equal(f.total, 80);
  assert.equal(f.hasEarlier, true);
  assert.equal(f.shown, 40, "the reader's window is kept");
  // an overlapping latest page merges as before
  applyPage(f, { round: 3, items: Array.from({ length: 20 }, (_, i) => item(62 + i)), total: 81, hasEarlier: true }, { latest: true });
  assert.equal(f.order.length, 21);
  assert.equal(f.order[0], "3:item_61");
});
