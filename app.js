/* r/Feed — subreddit RSS reader (no dependencies)
 * Feeds: Reddit Atom/RSS via here.now proxy routes (see .herenow/proxy.json)
 * State: localStorage — subs, sort, feed cache, read ids, theme
 * Config share: #rf=<base64url json> fragment copied across devices
 */
"use strict";

const DEFAULT_SUBS = ["programming", "AskReddit", "worldnews", "gaming"];
const LS_SUBS = "rf.subs.v1";
const LS_SORT = "rf.sort.v1";
const LS_CACHE = "rf.cache.v1";
const LS_READ = "rf.read.v1";
const LS_THEME = "rf.theme.v1";
const AUTO_REFRESH_MS = 10 * 60 * 1000; // 10 min
const CACHE_TTL_MS = 8 * 60 * 1000;      // 8 min per feed
const FETCH_TIMEOUT_MS = 15000;
const STAGGER_MS = 5000;                  // spread requests to avoid rate limit
const RETRY_BACKOFF_MS = 6000;
const PAGE_SIZE = 40;
const READ_CAP = 2000;
const FEED_LIMIT = 100;                   // Reddit RSS max

const SORTS = [
  ["hot", "Hot"],
  ["new", "New"],
  ["rising", "Rising"],
  ["top", "Top · day"],
  ["top-week", "Top · week"],
  ["top-month", "Top · month"],
  ["top-year", "Top · year"],
  ["controversial", "Controversial"],
];

const ICON_MOON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

const state = {
  subs: loadSubs(),
  sort: localStorage.getItem(LS_SORT) || "hot",
  tab: "all",
  query: "",
  feeds: new Map(), // sub -> { items: [], error: null, loading: false }
  limit: PAGE_SIZE,
  focus: -1,        // keyboard-nav focused card index
  readIds: loadReadIds(),
};
if (!SORTS.some(([k]) => k === state.sort)) state.sort = "hot";

const $tabs = document.getElementById("tabs");
const $feed = document.getElementById("feed");
const $refreshBtn = document.getElementById("refresh-btn");
const $refreshState = document.getElementById("refresh-state");
const $sort = document.getElementById("sort-select");
const $search = document.getElementById("search-input");
const $searchClear = document.getElementById("search-clear");
const $markRead = document.getElementById("mark-read");
const $themeBtn = document.getElementById("theme-btn");
const $metaTheme = document.getElementById("meta-theme-color");
$sort.value = state.sort;

/* ---------- storage ---------- */
function loadSubs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SUBS));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (e) {}
  return [...DEFAULT_SUBS];
}
function saveSubs() { try { localStorage.setItem(LS_SUBS, JSON.stringify(state.subs)); } catch (e) {} }

function loadReadIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_READ));
    if (Array.isArray(raw)) return new Set(raw.slice(-READ_CAP));
  } catch (e) {}
  return new Set();
}
function saveReadIds() {
  try { localStorage.setItem(LS_READ, JSON.stringify([...state.readIds].slice(-READ_CAP))); } catch (e) {}
}
function markRead(id) {
  if (!id || state.readIds.has(id)) return;
  state.readIds.add(id);
  if (state.readIds.size > READ_CAP) state.readIds = new Set([...state.readIds].slice(-READ_CAP));
  saveReadIds();
}

/* ---------- fetching ---------- */
function feedRoute(sub, sort, base) {
  const [k, t] = sort.split("-");
  return `${base}/${encodeURIComponent(sub)}/${k}/.rss?limit=${FEED_LIMIT}${t ? "&t=" + t : ""}`;
}
function cacheRoute(sub, sort) {
  // rss-cacher feed names: {sub lowercased}-{sort}
  return `/cache/rss/${sub.toLowerCase()}-${sort}`;
}

async function fetchFeed(sub) {
  const cacheKey = `${sub}::${state.sort}`;
  const cache = loadCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS && entry.items && entry.items.length) {
    return entry.items.map((it) => ({ ...it, date: new Date(it.date) }));
  }

  // Cache-first: home-hosted rss-cacher (residential IP, no Reddit burst
  // limits), then the direct Reddit proxy routes as fallback.
  const routes = [
    cacheRoute(sub, state.sort),
    feedRoute(sub, state.sort, "/rss"),
    feedRoute(sub, state.sort, "/old-rss"),
  ];

  const tryFetch = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (r.status === 429) throw new Error("rate limited");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (!text || text.length < 120) throw new Error("empty");
      const items = parseRss(text);
      if (!items.length) throw new Error("no items parsed");
      return items;
    } finally { clearTimeout(t); }
  };

  // Two passes over the routes: primary pass, then one full retry pass
  // after a backoff. Spreads load and survives transient 429 bursts.
  let items = null;
  let lastErr = null;
  for (let pass = 0; pass < 2 && !items; pass++) {
    if (pass > 0) await sleep(RETRY_BACKOFF_MS);
    for (const route of routes) {
      try { items = await tryFetch(route); break; }
      catch (e) { lastErr = e; }
    }
  }
  if (items) { saveCacheEntry(cacheKey, items); return items; }

  if (entry && entry.items && entry.items.length) {
    return entry.items.map((it) => ({ ...it, date: new Date(it.date) }));
  }
  throw new Error(lastErr ? String(lastErr.message || lastErr) : "feed unavailable (rate limited)");
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE)) || {}; } catch (_) { return {}; }
}
function saveCacheEntry(key, items) {
  const cache = loadCache();
  cache[key] = { t: Date.now(), items: items.map((it) => ({ ...it, date: it.date.toISOString() })) };
  try { localStorage.setItem(LS_CACHE, JSON.stringify(cache)); } catch (_) {}
}

/* ---------- RSS/Atom parsing ---------- */
function parseRss(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  const items = [];
  // Atom (Reddit's default)
  doc.querySelectorAll("entry").forEach((it) => {
    const title = txt(it, "title");
    const link = entryLink(it);
    const date = txt(it, "updated") || txt(it, "published");
    const content = txt(it, "content") || txt(it, "summary");
    if (title && link) items.push({
      id: txt(it, "id"),
      sub: catTerm(it),
      author: authorName(it),
      title: decodeEntities(title).trim(),
      link,
      date: date ? new Date(date) : new Date(0),
      preview: previewText(content),
    });
  });
  if (items.length) return items;
  // RSS 2.0 fallback
  doc.querySelectorAll("item").forEach((it) => {
    const title = txt(it, "title");
    const link = txt(it, "link");
    const date = txt(it, "pubDate");
    const desc = txt(it, "description") || txt(it, "encoded");
    if (title && link) items.push({
      id: txt(it, "guid") || "",
      sub: txt(it, "category") || "",
      author: "",
      title: decodeEntities(title).trim(),
      link,
      date: date ? new Date(date) : new Date(0),
      preview: previewText(desc),
    });
  });
  return items;
}
function txt(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent : "";
}
function entryLink(it) {
  const links = it.getElementsByTagName("link");
  for (const l of links) {
    const rel = l.getAttribute("rel") || "alternate";
    if (rel === "alternate") return l.getAttribute("href") || "";
  }
  return links.length ? links[0].getAttribute("href") || "" : "";
}
function catTerm(it) {
  const c = it.getElementsByTagName("category")[0];
  return c ? (c.getAttribute("term") || c.getAttribute("label") || "").replace(/^r\//, "") : "";
}
function authorName(it) {
  const a = it.getElementsByTagName("author")[0];
  const n = a ? a.getElementsByTagName("name")[0] : null;
  return n ? (n.textContent || "").replace(/^\/?u\//, "") : "";
}
function decodeEntities(s) {
  const d = document.createElement("div");
  d.innerHTML = s;
  return d.textContent || "";
}
function previewText(html) {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  let text = (d.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Reddit feed boilerplate: "submitted by /u/x [link] [comments]" — appears
  // whole for link/media posts, and as a trailing suffix on truncated bodies.
  text = text
    .replace(/\s*submitted by \/u\/[\w-]+(\s*\[link\]\s*(\[comments\])?)?\s*$/i, "")
    .replace(/^submitted by \/u\/[\w-]+\s*/i, "")
    .replace(/^\s*\[link\]\s*(\[comments\])?\s*$/i, "")
    .trim();
  if (!text || /^https?:\/\/\S+$/.test(text)) return "";
  return text.length > 220 ? text.slice(0, 220).trimEnd() + "…" : text;
}

/* ---------- refresh logic ---------- */
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  state.limit = PAGE_SIZE;
  $refreshBtn.classList.add("spinning");
  for (const sub of state.subs) state.feeds.set(sub, { items: [], error: null, loading: true });
  render();
  for (let i = 0; i < state.subs.length; i++) {
    const sub = state.subs[i];
    try {
      const items = await fetchFeed(sub);
      state.feeds.set(sub, { items, error: null, loading: false });
    } catch (e) {
      state.feeds.set(sub, { items: [], error: String(e.message || e), loading: false });
    }
    render();
    if (i < state.subs.length - 1) await sleep(STAGGER_MS);
  }
  refreshing = false;
  $refreshBtn.classList.remove("spinning");
  render();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- items & rendering ---------- */
function currentItems() {
  const q = state.query.trim().toLowerCase();
  let items;
  if (state.tab === "all") {
    items = [];
    for (const sub of state.subs) {
      const f = state.feeds.get(sub);
      if (f && f.items) for (const it of f.items) items.push({ ...it, sub });
    }
    items.sort((a, b) => b.date - a.date);
    const seen = new Set();
    items = items.filter((it) => {
      if (it.id && seen.has(it.id)) return false;
      if (it.id) seen.add(it.id);
      return true;
    });
  } else {
    const f = state.feeds.get(state.tab);
    items = f && f.items ? f.items.map((it) => ({ ...it, sub: state.tab })) : [];
  }
  if (q) items = items.filter((it) => it.title.toLowerCase().includes(q));
  return items;
}

function render() {
  renderTabs();
  renderFeed();
  renderState();
  updateFocusHighlight();
}

function unreadCount(items) {
  return (items || []).filter((it) => it.id && !state.readIds.has(it.id)).length;
}

function renderTabs() {
  const tabs = [{ key: "all", label: "All" }, ...state.subs.map((s) => ({ key: s, label: s }))];
  $tabs.innerHTML = "";
  let totalUnread = 0;
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (state.tab === t.key ? " active" : "");
    if (state.tab === t.key) b.setAttribute("aria-current", "page");
    const f = state.feeds.get(t.key);
    if (t.key !== "all" && f && f.loading) b.classList.add("loading");
    b.innerHTML = `<span>${esc(t.key === "all" ? "All" : "r/" + t.label)}</span>`;
    if (t.key !== "all" && f && !f.loading && f.items) {
      const unread = unreadCount(f.items);
      totalUnread += unread;
      b.innerHTML += unread
        ? `<span class="count unread" title="${unread} unread of ${f.items.length}">${unread}</span>`
        : `<span class="count" title="${f.items.length} total">${f.items.length}</span>`;
    }
    b.onclick = () => { state.tab = t.key; state.limit = PAGE_SIZE; state.focus = -1; render(); };
    $tabs.appendChild(b);
  }
  if (totalUnread) {
    $tabs.firstChild.innerHTML = `<span>All</span><span class="count unread" title="${totalUnread} unread">${totalUnread}</span>`;
  }
  const add = document.createElement("button");
  add.className = "tab add-tab" + (state.tab === "manage" ? " active" : "");
  add.textContent = "+ manage";
  add.setAttribute("aria-label", "Manage subreddits");
  add.onclick = () => { state.tab = state.tab === "manage" ? "all" : "manage"; state.focus = -1; render(); };
  $tabs.appendChild(add);
}

function renderFeed() {
  $feed.innerHTML = "";
  if (state.tab === "manage") { renderManage(); return; }

  const anyLoading = state.subs.some((s) => state.feeds.get(s)?.loading);
  const items = currentItems();

  if (items.length === 0 && !anyLoading) {
    const errs = state.subs.filter((s) => {
      const f = state.feeds.get(s);
      return f && !f.loading && f.error && (state.tab === "all" || state.tab === s);
    });
    if (errs.length) {
      for (const s of errs) {
        const f = state.feeds.get(s);
        const el = document.createElement("div");
        el.className = "card err-card";
        el.innerHTML = `<a class="title">Couldn't load r/${esc(s)}</a><div class="card-meta"><span>${esc(f.error)}</span><span>Tap the refresh button ↑ to retry.</span></div>`;
        $feed.appendChild(el);
      }
      return;
    }
    $feed.innerHTML = `<div class="state"><div class="big">🍜</div>${state.query ? "No matches for “" + esc(state.query) + "”." : "No posts here — try refreshing or adding a subreddit in + manage."}</div>`;
    return;
  }
  if (!items.length) {
    for (let i = 0; i < 6; i++) $feed.appendChild(skel());
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, state.limit)) frag.appendChild(card(it, state.tab === "all"));
  $feed.appendChild(frag);
  if (items.length > state.limit) {
    const more = document.createElement("button");
    more.className = "show-more";
    more.textContent = `Show more (${items.length - state.limit} more)`;
    more.addEventListener("click", () => { state.limit += PAGE_SIZE; render(); });
    $feed.appendChild(more);
  }
  const errs = state.subs.filter((s) => {
    const f = state.feeds.get(s);
    return f && !f.loading && f.error && (state.tab === "all" || state.tab === s);
  });
  if (errs.length && state.tab === "all" && !state.query.trim()) {
    const el = document.createElement("div");
    el.className = "card err-card";
    el.innerHTML = `<a class="title">Failed to load: ${errs.map((s) => "r/" + esc(s)).join(", ")}</a><div class="card-meta"><span>Tap the refresh button to retry.</span></div>`;
    $feed.appendChild(el);
  }
}

function card(it, showBadge) {
  const el = document.createElement("article");
  el.className = "card";
  if (it.id && state.readIds.has(it.id)) el.classList.add("read");
  const a = document.createElement("a");
  a.className = "title";
  a.href = it.link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = it.title;
  a.addEventListener("click", () => {
    markRead(it.id);
    el.classList.add("read");
    renderTabs();
    renderState();
  });
  el.appendChild(a);
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const parts = [];
  if (showBadge) parts.push(`<span class="badge">r/${esc(it.sub)}</span>`);
  if (it.author) parts.push(`<span class="author">u/${esc(it.author)}</span>`);
  parts.push(`<span class="time" data-ts="${+it.date}">${relTime(it.date)}</span>`);
  meta.innerHTML = parts.join("");
  el.appendChild(meta);
  if (it.preview) {
    const p = document.createElement("div");
    p.className = "card-preview";
    p.textContent = it.preview;
    el.appendChild(p);
  }
  return el;
}

function skel() { const d = document.createElement("div"); d.className = "skel"; return d; }

function renderManage() {
  const wrap = document.createElement("div");
  wrap.className = "panel";
  wrap.innerHTML = `<h3>Your subreddits</h3>`;
  const list = document.createElement("div");
  list.className = "sub-list";
  for (const sub of state.subs) {
    const chip = document.createElement("span");
    chip.className = "sub-chip";
    chip.textContent = "r/" + sub;
    const x = document.createElement("button");
    x.textContent = "×";
    x.setAttribute("aria-label", "Remove r/" + sub);
    x.onclick = () => {
      state.subs = state.subs.filter((s) => s !== sub);
      if (state.tab === sub) state.tab = "all";
      saveSubs();
      render();
      refreshAll();
    };
    chip.appendChild(x);
    list.appendChild(chip);
  }
  wrap.appendChild(list);

  const row = document.createElement("div");
  row.className = "add-row";
  const input = document.createElement("input");
  input.placeholder = "subreddit name (no r/)";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Add subreddit");
  const btn = document.createElement("button");
  btn.textContent = "Add";
  const doAdd = () => {
    const name = input.value.trim().replace(/^\/?(r\/|u\/|u:)/i, "");
    if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) { input.focus(); return; }
    if (state.subs.some((s) => s.toLowerCase() === name.toLowerCase())) { input.value = ""; return; }
    state.subs.push(name);
    input.value = "";
    saveSubs();
    render();
    refreshAll();
  };
  btn.onclick = doAdd;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  row.append(input, btn);
  wrap.appendChild(row);

  const shareRow = document.createElement("div");
  shareRow.className = "share-row";
  const shareBtn = document.createElement("button");
  shareBtn.className = "share-btn";
  shareBtn.textContent = "Copy share link";
  shareBtn.addEventListener("click", async () => {
    const payload = { v: 1, subs: state.subs, sort: state.sort };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = location.origin + location.pathname + "#rf=" + b64;
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) {}
      ta.remove();
    }
    shareBtn.textContent = "Copied ✓";
    setTimeout(() => (shareBtn.textContent = "Copy share link"), 2000);
  });
  shareRow.appendChild(shareBtn);
  wrap.appendChild(shareRow);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Subs and sort are saved on this device. Share the link to copy this setup to another device.";
  wrap.appendChild(hint);
  $feed.appendChild(wrap);
}

function renderState() {
  let done = 0, errs = 0;
  for (const s of state.subs) {
    const f = state.feeds.get(s);
    if (f && !f.loading) { done++; if (f.error) errs++; }
  }
  const anyLoading = state.subs.some((s) => state.feeds.get(s)?.loading);
  let txt;
  if (anyLoading) txt = "refreshing…";
  else if (done !== state.subs.length) txt = "loading…";
  else {
    const q = state.query.trim();
    const n = q ? currentItems().length : 0;
    let unread = 0;
    for (const s of state.subs) unread += unreadCount(state.feeds.get(s)?.items);
    txt = `${errs ? errs + " feed error · " : ""}${q ? n + " matches · " : ""}${unread} unread · updated ${relTime(new Date()).replace(" ago", "")}`;
  }
  $refreshState.textContent = txt;
  $refreshState.title = txt;
}

/* ---------- keyboard nav ---------- */
function feedCards() { return [...document.querySelectorAll("#feed .card:not(.err-card)")]; }
function updateFocusHighlight() {
  const cards = feedCards();
  if (state.focus > cards.length - 1) state.focus = cards.length - 1;
  cards.forEach((c, i) => c.classList.toggle("kbfocus", i === state.focus));
  if (state.focus >= 0 && cards[state.focus]) cards[state.focus].scrollIntoView({ block: "center" });
}
function moveFocus(delta) {
  const cards = feedCards();
  if (!cards.length) { state.focus = -1; return; }
  if (state.focus < 0) state.focus = delta > 0 ? 0 : cards.length - 1;
  else state.focus = Math.min(cards.length - 1, Math.max(0, state.focus + delta));
  updateFocusHighlight();
}
function openFocused() {
  const cards = feedCards();
  if (state.focus < 0 || !cards[state.focus]) return;
  const a = cards[state.focus].querySelector("a.title");
  if (a) a.click();
}
function clearFocus() {
  state.focus = -1;
  feedCards().forEach((c) => c.classList.remove("kbfocus"));
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function relTime(d) {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* ---------- theme ---------- */
function setTheme(t, persist) {
  document.documentElement.setAttribute("data-theme", t);
  const isDark = t === "dark";
  $themeBtn.innerHTML = isDark ? ICON_MOON : ICON_SUN;
  $themeBtn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  $themeBtn.title = $themeBtn.getAttribute("aria-label");
  if ($metaTheme) $metaTheme.setAttribute("content", getComputedStyle(document.body).backgroundColor);
  if (persist) { try { localStorage.setItem(LS_THEME, t); } catch (e) {} }
}

/* ---------- config share via #rf=<base64url> ---------- */
function importFromHash() {
  const m = location.hash.match(/^#rf=(.+)$/);
  if (!m) return false;
  let changed = false;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
    const data = JSON.parse(json);
    if (data && data.v === 1 && Array.isArray(data.subs)) {
      const valid = data.subs.map((s) => String(s).trim()).filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s));
      if (valid.length) {
        state.subs = [...new Set(valid)];
        saveSubs();
        changed = true;
      }
      if (SORTS.some(([k]) => k === data.sort)) {
        state.sort = data.sort;
        localStorage.setItem(LS_SORT, state.sort);
        $sort.value = state.sort;
        changed = true;
      }
    }
  } catch (e) {}
  history.replaceState(null, "", location.pathname + location.search);
  return changed;
}

/* ---------- events ---------- */
$refreshBtn.onclick = refreshAll;
$sort.onchange = () => {
  state.sort = $sort.value;
  localStorage.setItem(LS_SORT, state.sort);
  state.limit = PAGE_SIZE;
  refreshAll();
};

let searchTimer = null;
$search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = $search.value.trim();
    $searchClear.classList.toggle("show", !!$search.value);
    render();
  }, 120);
});
$searchClear.addEventListener("click", () => {
  $search.value = "";
  state.query = "";
  $searchClear.classList.remove("show");
  render();
  $search.focus();
});

$markRead.addEventListener("click", () => {
  for (const s of state.subs) {
    for (const it of state.feeds.get(s)?.items || []) {
      if (it.id) state.readIds.add(it.id);
    }
  }
  saveReadIds();
  render();
});

$themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  setTheme(cur === "dark" ? "light" : "dark", true);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  if (typing) {
    if (e.key === "Escape") { t.blur(); clearFocus(); }
    return;
  }
  switch (e.key) {
    case "/": e.preventDefault(); $search.focus(); $search.select(); break;
    case "r": case "R": refreshAll(); break;
    case "j": case "ArrowDown": e.preventDefault(); moveFocus(1); break;
    case "k": case "ArrowUp": e.preventDefault(); moveFocus(-1); break;
    case "Enter": openFocused(); break;
    case "Escape": clearFocus(); break;
  }
});

/* ---------- timers ---------- */
setInterval(() => {
  document.querySelectorAll(".time").forEach((el) => {
    el.textContent = relTime(new Date(+el.dataset.ts));
  });
  renderState();
}, 60000);

setInterval(() => { if (document.visibilityState === "visible") refreshAll(); }, AUTO_REFRESH_MS);

/* ---------- boot ---------- */
setTheme(document.documentElement.getAttribute("data-theme") || "dark", false);
importFromHash();
window.addEventListener("hashchange", () => {
  if (importFromHash()) {
    state.limit = PAGE_SIZE;
    state.focus = -1;
    render();
    refreshAll();
  }
});
refreshAll();
