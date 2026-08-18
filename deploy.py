#!/usr/bin/env python3
"""Deploy r/Feed to here.now.

Usage:
  python3 deploy.py                    # update prod slug (jovial-cosmos-amj3)
  python3 deploy.py --create           # publish to a NEW scratch slug (testing)
  python3 deploy.py --slug <s> --delete  # hard-delete a scratch slug

Auth: Bearer key from ~/.herenow/credentials.
Publishes index.html, style.css, app.js, .herenow/proxy.json (proxy manifest
is required — without it the /rss/* and /old-rss/* routes disappear).
"""
import hashlib
import json
import os
import sys
import urllib.request

API = "https://here.now/api/v1"
PROD_SLUG = "jovial-cosmos-amj3"
FILES = ["index.html", "style.css", "app.js", ".herenow/proxy.json"]
CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    ".herenow/proxy.json": "application/json; charset=utf-8",
}


def api_key():
    return open(os.path.expanduser("~/.herenow/credentials")).read().strip()


def api(method, url, body=None):
    """url may be full (https://...) or API-relative (/publish/...)."""
    if not url.startswith("http"):
        url = API + url
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", "Bearer " + api_key())
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=60) as r:
        return json.loads(r.read())


def upload_all(upload):
    for entry in upload.get("uploads", []):
        with open(entry["path"], "rb") as f:
            data = f.read()
        req = urllib.request.Request(entry["url"], method="PUT", data=data)
        for k, v in entry.get("headers", {}).items():
            req.add_header(k, v)
        urllib.request.urlopen(req, timeout=300)


def main():
    args = sys.argv[1:]
    slug = None
    if "--slug" in args:
        slug = args[args.index("--slug") + 1]

    if "--delete" in args:
        res = api("DELETE", f"/publish/{slug}")
        print("deleted:", res)
        return

    files = []
    for p in FILES:
        with open(p, "rb") as f:
            data = f.read()
        files.append({
            "path": p,
            "size": len(data),
            "contentType": CONTENT_TYPES[p],
            "hash": hashlib.sha256(data).hexdigest(),
        })

    if "--create" in args:
        res = api("POST", "/publish", {"files": files})
    else:
        res = api("PUT", f"/publish/{slug or PROD_SLUG}", {"files": files})

    up = res.get("upload", {})
    upload_all(up)
    finalize_url = up.get("finalizeUrl") or f"/publish/{res['slug']}/finalize"
    fin = api("POST", finalize_url, {"versionId": up.get("versionId")})
    print("siteUrl:", fin.get("siteUrl"))
    print("uploads:", [e["path"] for e in up.get("uploads", [])])
    print("skipped:", up.get("skipped", []))


if __name__ == "__main__":
    main()
