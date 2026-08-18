#!/usr/bin/env python3
"""Register feeds with the local rss-cacher.

Creates the admin account (once) and registers all sort variants for each
subreddit in SUBS. Idempotent: re-running only adds missing feeds.
Feed naming convention: {sub}-{sort} (matches what r/Feed's app.js requests
from the /cache/* here.now proxy route).
"""
import json
import os
import secrets
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8082"
ENV_FILE = os.path.expanduser("~/projects/rfeed/cacher.env")

SUBS = ["programming", "AskReddit", "worldnews", "gaming"]

SORTS = {
    "hot": "/hot/.rss?limit=100",
    "new": "/new/.rss?limit=100",
    "rising": "/rising/.rss?limit=100",
    "top": "/top/.rss?t=day&limit=100",
    "top-week": "/top/.rss?t=week&limit=100",
    "top-month": "/top/.rss?t=month&limit=100",
    "top-year": "/top/.rss?t=year&limit=100",
    "controversial": "/controversial/.rss?limit=100",
}


def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=60) as r:
        return json.loads(r.read())


def main():
    # Load or create credentials
    creds = {}
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                creds[k] = v

    if not creds.get("USERNAME"):
        creds["NAME"] = "rfeed-admin"
        creds["USERNAME"] = "rfeed@localhost"
        creds["PASSWORD"] = secrets.token_urlsafe(24)
        os.makedirs(os.path.dirname(ENV_FILE), exist_ok=True)
        with open(ENV_FILE, "w") as f:
            f.write(f"NAME={creds['NAME']}\nUSERNAME={creds['USERNAME']}\nPASSWORD={creds['PASSWORD']}\n")
        os.chmod(ENV_FILE, 0o600)

    # Login (register only on auth failure, not on transient server errors)
    token = None
    try:
        res = call("POST", "/login", {"username": creds["USERNAME"], "password": creds["PASSWORD"]})
        token = res.get("token")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            try:
                res = call("POST", "/register", {
                    "name": creds["NAME"], "username": creds["USERNAME"], "password": creds["PASSWORD"],
                })
                token = res.get("token")
            except urllib.error.HTTPError as e2:
                if e2.code == 409:
                    print(f"Error: a cacher account already exists for {creds['USERNAME']} "
                          f"but the stored password in {ENV_FILE} is wrong. "
                          "Delete that file and re-run to reset local credentials.")
                    raise SystemExit(1)
                raise
        else:
            raise
    if not token:
        print("no token in response:", res)
        raise SystemExit(1)

    feeds_resp = call("GET", "/feeds", token=token)
    existing = {f.get("name") for f in feeds_resp.get("feeds", [])}

    added = 0
    for sub in SUBS:
        for sort, tail in SORTS.items():
            # feed names must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ (lowercase)
            name = f"{sub.lower()}-{sort}"
            if name in existing:
                continue
            url = f"https://www.reddit.com/r/{sub}{tail}"
            # validate:false — Reddit 429s burst requests; the scheduler
            # validates + backfills on its own cycle instead.
            try:
                call("POST", "/feeds", {"name": name, "feed_url": url, "validate": False}, token=token)
            except urllib.error.HTTPError as e:
                if e.code == 409:
                    continue  # already registered by an earlier partial run
                raise
            added += 1
            print("+", name)

    feeds = call("GET", "/feeds", token=token)
    print(f"total feeds: {len(feeds.get('feeds', []))} (added {added})")
    return token


if __name__ == "__main__":
    token = main()
    # Smoke test one feed
    import urllib.request as u
    try:
        with u.urlopen(f"{BASE}/rss/programming-hot", timeout=30) as r:
            body = r.read(500)
            print("smoke test programming-hot:", r.status, r.headers.get("Content-Type"), f"{len(body)}B")
    except Exception as e:
        print("smoke test failed:", e)
