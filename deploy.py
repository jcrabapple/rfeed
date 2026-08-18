#!/usr/bin/env python3
"""Deploy r/Feed to here.now.

Usage:
  python3 deploy.py                    # update your prod slug (from .deploy.local.json)
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
FILES = ["index.html", "style.css", "app.js", ".herenow/proxy.json"]
# Publish a local proxy override if present (gitignored) instead of the
# template in the repo: keeps personal upstream hosts out of version control.
PROXY_SRC = (
    ".herenow/proxy.local.json"
    if os.path.exists(".herenow/proxy.local.json")
    else ".herenow/proxy.json"
)
# Prod slug lives in a gitignored `.deploy.local.json` file:
#   {"slug": "your-site-slug"}
# (created by `python3 deploy.py --create` / here.now). Without it, pass
# --slug explicitly on every update.
LOCAL_CFG = ".deploy.local.json"


def prod_slug():
    if os.path.exists(LOCAL_CFG):
        try:
            with open(LOCAL_CFG) as f:
                slug = json.load(f).get("slug")
                if slug:
                    return slug
        except Exception:
            pass
    return None
CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    ".herenow/proxy.json": "application/json; charset=utf-8",
}


def api_key():
    try:
        return open(os.path.expanduser("~/.herenow/credentials")).read().strip()
    except FileNotFoundError:
        print("Error: ~/.herenow/credentials not found. Get an API key from "
              "https://here.now and save it there (chmod 600).")
        sys.exit(1)


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
        path = entry.get("path")
        # Never trust a server-returned path for local file access.
        if path not in FILES:
            print(f"Error: unexpected upload path '{path}' from API, aborting.")
            sys.exit(1)
        with open(path, "rb") as f:
            data = f.read()
        req = urllib.request.Request(entry["url"], method="PUT", data=data)
        for k, v in entry.get("headers", {}).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=300) as r:
            r.read()


def validate_proxy_manifest(src):
    """The local override must contain all three routes the app relies on."""
    try:
        with open(src) as f:
            proxies = json.load(f).get("proxies", {})
    except Exception as e:
        print(f"Error: {src} is not valid JSON: {e}")
        sys.exit(1)
    required = ["/rss/*", "/old-rss/*", "/cache/*"]
    missing = [k for k in required if k not in proxies]
    if missing:
        print(f"Error: {src} is missing proxy routes: {', '.join(missing)}. "
              "All three are required (the app falls back across them).")
        sys.exit(1)


def main():
    args = sys.argv[1:]
    slug = None
    if "--slug" in args:
        i = args.index("--slug")
        if i + 1 >= len(args):
            print("Error: --slug requires a value.")
            sys.exit(1)
        slug = args[i + 1]

    if "--delete" in args:
        if not slug:
            print("Error: --delete requires an explicit --slug <s>. "
                  "Refusing to guess the target.")
            sys.exit(1)
        res = api("DELETE", f"/publish/{slug}")
        print("deleted:", res)
        return

    validate_proxy_manifest(PROXY_SRC)

    files = []
    for p in FILES:
        src = PROXY_SRC if p == ".herenow/proxy.json" else p
        with open(src, "rb") as f:
            data = f.read()
        files.append({
            "path": p,
            "size": len(data),
            "contentType": CONTENT_TYPES[p],
            "hash": hashlib.sha256(data).hexdigest(),
        })

    if "--create" in args:
        res = api("POST", "/publish", {"files": files})
        new_slug = res.get("slug")
        # Persist the new slug so a bare `python3 deploy.py` targets it.
        if new_slug and not os.path.exists(LOCAL_CFG):
            try:
                with open(LOCAL_CFG, "w") as f:
                    json.dump({"slug": new_slug}, f, indent=2)
                os.chmod(LOCAL_CFG, 0o600)
                print(f"wrote {LOCAL_CFG} with slug {new_slug}")
            except Exception as e:
                print(f"note: could not write {LOCAL_CFG}: {e}")
    else:
        target = slug or prod_slug()
        if not target:
            print("Error: no target slug. Create .deploy.local.json with "
                  '{"slug": "your-site-slug"} or pass --slug <s>.')
            sys.exit(1)
        res = api("PUT", f"/publish/{target}", {"files": files})

    up = res.get("upload", {})
    upload_all(up)
    finalize_url = up.get("finalizeUrl") or f"/publish/{res['slug']}/finalize"
    fin = api("POST", finalize_url, {"versionId": up.get("versionId")})
    print("siteUrl:", fin.get("siteUrl"))
    print("uploads:", [e["path"] for e in up.get("uploads", [])])
    print("skipped:", up.get("skipped", []))


if __name__ == "__main__":
    main()
