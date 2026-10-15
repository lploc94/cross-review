// The activity feed of one round, as the page holds it: items by key in log order, the
// distinct-item total, and how many of the latest are shown. Pure functions shared by the
// page and node tests (no DOM).
//
// Live events and page loads may overlap after a (re)connect; merging by key makes either
// order give the same feed, and the copy with the later lastLine wins.

export const PAGE = 20;

export function newFeed(round) {
  return { round, byKey: new Map(), order: [], total: 0, shown: PAGE };
}

function resetTo(feed, round) {
  feed.round = round;
  feed.byKey = new Map();
  feed.order = [];
  feed.total = 0;
  feed.shown = PAGE;
}

/** Insert or replace one item; returns "add", "update" or null (an older copy). */
function put(feed, item) {
  const old = feed.byKey.get(item.key);
  if (old) {
    if ((item.lastLine ?? item.line) < (old.lastLine ?? old.line)) return null;
    feed.byKey.set(item.key, item);
    return "update";
  }
  feed.byKey.set(item.key, item);
  // keep log order; new items almost always go last
  let i = feed.order.length;
  while (i > 0 && feed.byKey.get(feed.order[i - 1]).line > item.line) i--;
  feed.order.splice(i, 0, item.key);
  return "add";
}

/** Apply one live `activity` event. An item of a later round starts that round's feed. */
export function mergeActivity(feed, event) {
  const item = event && event.item;
  if (!item || !item.key) return null;
  const round = item.round ?? Number(String(item.key).split(":")[0]);
  if (round < feed.round) return null;
  if (round > feed.round) resetTo(feed, round);
  const did = put(feed, item);
  feed.total = Math.max(feed.total, event.total || 0, feed.order.length);
  return did;
}

/**
 * Apply a page from /api/activity. A page of another round replaces the feed. A `latest`
 * page (the newest items, loaded after a (re)connect) that starts after every cached item
 * leaves a gap between them: it replaces the cached items, so "show earlier" continues
 * from its first item. The reader's window (`shown`) stays.
 */
export function applyPage(feed, page, { latest = false } = {}) {
  if (page.round !== feed.round) resetTo(feed, page.round);
  const newest = feed.order.length ? feed.byKey.get(feed.order[feed.order.length - 1]) : null;
  if (latest && newest && page.items.length && page.items[0].line > newest.line && !feed.byKey.has(page.items[0].key)) {
    feed.byKey = new Map();
    feed.order = [];
  }
  for (const item of page.items) put(feed, item);
  feed.total = Math.max(feed.total, page.total || 0, feed.order.length);
  feed.hasEarlier = Boolean(page.hasEarlier) || feed.order.length < feed.total;
}

/** The items on screen: the latest `shown`, oldest first. */
export function visible(feed) {
  return feed.order.slice(-feed.shown).map(k => feed.byKey.get(k));
}

/**
 * What the page does on a stream `snapshot` (sent on every connect). Events sent while it
 * was away are lost, so it always reloads the detail and the activity page; a new round
 * also starts a new feed.
 */
export function onSnapshot(view, snapshot) {
  const actions = [];
  if (!view.feed || view.feed.round !== snapshot.round) actions.push("resetFeed");
  actions.push("reloadDetail", "fetchActivity");
  return actions;
}

/** Fold consecutive reads into one line: [{kind, items}]. */
export function groupReads(list) {
  const out = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (a.kind === "read" && last && last.kind === "read") last.items.push(a);
    else out.push({ kind: a.kind, items: [a] });
  }
  return out;
}
