/* r/Feed — minimal subreddit RSS reader (no dependencies) */
"use strict";

const DEFAULT_SUBS = ["programming", "AskReddit", "worldnews", "gaming"];
const LS_SUBS = "rf.subs.v1";
const LS_SORT = "rf.sort.v1";
const LS_CACHE = "rf.cache.v1";
const AUTO_REFRESH_MS = 10 * 60 * 1000;  // 10 min
const CACHE_TTL_MS = 8 * 60 * 1000;       // 8 min per feed
const FETCH_TIMEOUT_MS = 15000;
const STAGGER_MS = 3500;                   // spread requests to avoid rate limit
const RETRY_BACKOFF_MS = 6000;

const state = {
  subs: loadSubs(),
  sort: localStorage.getItem(LS_SORT) || "hot",
  tab: "all",
  query: "",
  feeds: new Map(), // sub -> { items: [], error: null, loading: false }
};

const $tabs = document.getElementById("tabs");
const $feed = document.getElementById("feed");
const $refreshBtn = document.getElementById("refresh-btn");
const $refreshState = document.getElementById("refresh-state");
const $sort = document.getElementById("sort-select");
$sort.value = state.sort;

/* ---------- storage ---------- */
function loadSubs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SUBS));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (e) {}
  return [...DEFAULT_SUBS];
}
function saveSubs() { localStorage.setItem(LS_SUBS, JSON.stringify(state.subs)); }

/* ---------- (fallback proxies inlined in fetchFeed) ---------- */

async function fetchFeed(sub) {
  // Cache check first
  const cacheKey = `${sub}::${state.sort}`;
  const cache = loadCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS && entry.items && entry.items.length) {
    return entry.items.map((it) => ({ ...it, date: new Date(it.date) }));
  }

  // Primary: here.now proxy route (server-side, no CORS issues)
  // Secondary: old.reddit.com via here.now (different rate limit pool)
  const routes = [
    `/rss/${encodeURIComponent(sub)}/${state.sort}/.rss?limit=25`,
    `/old-rss/${encodeURIComponent(sub)}/${state.sort}/.rss?limit=25`,
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

  // Try each route with backoff on 429
  let items = null;
  let lastErr = null;
  for (const route of routes) {
    try { items = await tryFetch(route); break; }
    catch (e) {
      lastErr = e;
      if (String(e).includes("rate limited")) {
        await sleep(RETRY_BACKOFF_MS);
        try { items = await tryFetch(route); break; } catch (e2) { lastErr = e2; }
      }
    }
  }
  if (items) { saveCacheEntry(cacheKey, items); return items; }

  // Fallback: stale cache if we have it (better than nothing)
  if (entry && entry.items && entry.items.length) {
    return entry.items.map((it) => ({ ...it, date: new Date(it.date) }));
  }
  throw new Error("feed unavailable (rate limited)");
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
  // RSS 2.0: <item>
  doc.querySelectorAll("item").forEach((it) => {
    const title = txt(it, "title");
    const link = txt(it, "link");
    const date = txt(it, "pubDate");
    const cat = txt(it, "category");
    const desc = txt(it, "description") || txt(it, "encoded");
    if (title && link) items.push({
      sub: cat || "", title: decodeEntities(title).trim(), link,
      date: date ? new Date(date) : new Date(0), preview: previewText(desc),
    });
  });
  // Atom: <entry> (Reddit's default)
  doc.querySelectorAll("entry").forEach((it) => {
    const title = txt(it, "title");
    const linkEl = it.getElementsByTagName("link")[0];
    const link = linkEl ? linkEl.getAttribute("href") : "";
    const date = txt(it, "updated") || txt(it, "published");
    const catEl = it.getElementsByTagName("category")[0];
    const cat = catEl ? (catEl.getAttribute("term") || catEl.getAttribute("label") || "") : "";
    const content = txt(it, "content") || txt(it, "summary");
    if (title && link) items.push({
      sub: cat.replace(/^r\//, ""), title: decodeEntities(title).trim(), link,
      date: date ? new Date(date) : new Date(0), preview: previewText(content),
    });
  });
  return items;
}
function txt(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? el.textContent : "";
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
  const text = (d.textContent || "").replace(/\s+/g, " ").trim();
  return text.length > 220 ? text.slice(0, 220).trimEnd() + "…" : text;
}

/* ---------- refresh logic ---------- */
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
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

/* ---------- rendering ---------- */
function currentItems() {
  const q = state.query.trim().toLowerCase();
  if (state.tab === "all") {
    const all = [];
    for (const sub of state.subs) {
      const f = state.feeds.get(sub);
      if (f && f.items) for (const it of f.items) all.push({ ...it, sub: sub });
    }
    all.sort((a, b) => b.date - a.date);
    return q ? all.filter((it) => it.title.toLowerCase().includes(q)) : all;
  }
  const f = state.feeds.get(state.tab);
  const items = f && f.items ? f.items.map((it) => ({ ...it, sub: state.tab })) : [];
  return q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
}

function render() {
  renderTabs();
  renderFeed();
  renderState();
}

function renderTabs() {
  const tabs = [{ key: "all", label: "All" }, ...state.subs.map((s) => ({ key: s, label: s }))];
  $tabs.innerHTML = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (state.tab === t.key ? " active" : "");
    const f = state.feeds.get(t.key);
    if (t.key !== "all" && f && f.loading) b.classList.add("loading");
    b.innerHTML = `<span>${esc(t.key === "all" ? "All" : "r/" + t.label)}</span>`;
    if (t.key !== "all" && f && !f.loading && f.items) {
      b.innerHTML += `<span class="count">${f.items.length}</span>`;
    }
    b.onclick = () => { state.tab = t.key; render(); };
    $tabs.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "tab add-tab" + (state.tab === "manage" ? " active" : "");
  add.textContent = "+ manage";
  add.onclick = () => { state.tab = state.tab === "manage" ? "all" : "manage"; render(); };
  $tabs.appendChild(add);
}

function renderFeed() {
  $feed.innerHTML = "";
  if (state.tab === "manage") { renderManage(); return; }

  const anyLoading = state.subs.some((s) => state.feeds.get(s)?.loading);
  const items = currentItems();

  if (items.length === 0 && !anyLoading) {
    $feed.innerHTML = `<div class="state"><div class="big">🍜</div>No posts here — try refreshing or adding a subreddit.</div>`;
    return;
  }
  const errs = state.subs.filter((s) => {
    const f = state.feeds.get(s);
    return f && !f.loading && f.error && (state.tab === "all" || state.tab === s);
  });
  if (items.length === 0 && !anyLoading && errs.length) {
    for (const s of errs) {
      const f = state.feeds.get(s);
      const el = document.createElement("div");
      el.className = "card err-card";
      el.innerHTML = `<a class="title">Couldn't load r/${esc(s)}</a><div class="card-meta"><span>${esc(f.error)}</span><span>Tap the refresh button ↑ to retry.</span></div>`;
      $feed.appendChild(el);
    }
    return;
  }
  if (!items.length) {
    for (let i = 0; i < 6; i++) $feed.appendChild(skel());
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(card(it, state.tab === "all"));
  $feed.appendChild(frag);
  if (errs.length && state.tab === "all") {
    const el = document.createElement("div");
    el.className = "card err-card";
    el.innerHTML = `<a class="title">Failed to load: ${errs.map((s) => "r/" + esc(s)).join(", ")}</a><div class="card-meta"><span>Tap the refresh button to retry.</span></div>`;
    $feed.appendChild(el);
  }
}

function card(it, showBadge) {
  const el = document.createElement("article");
  el.className = "card";
  const a = document.createElement("a");
  a.className = "title";
  a.href = it.link;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = it.title;
  el.appendChild(a);
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML =
    (showBadge ? `<span class="badge">r/${esc(it.sub)}</span>` : "") +
    `<span title="${it.date.toISOString()}">${relTime(it.date)}</span>`;
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
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Changes are saved on this device only.";
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
  $refreshState.textContent = anyLoading
    ? "refreshing…"
    : done === state.subs.length
      ? `${errs ? errs + " feed error · " : ""}updated ${relTime(new Date())}`.replace(" ago", "")
      : "loading…";
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

/* ---------- events ---------- */
$refreshBtn.onclick = refreshAll;
$sort.onchange = () => {
  state.sort = $sort.value;
  localStorage.setItem(LS_SORT, state.sort);
  refreshAll();
};
setInterval(() => { if (document.visibilityState === "visible") refreshAll(); }, AUTO_REFRESH_MS);

refreshAll();
