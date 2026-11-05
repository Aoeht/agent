#!/usr/bin/env python3
"""Read-only snapshot hub: serve the collector's sqlite as bili-snapshot/v1.

The identification side only knows two endpoints, so collector tables can change
without touching it:
    GET /health
    GET /api/snapshots?since=&limit=&cursor=
    GET /api/snapshots/{bvid}

Environment:
    BILI_HUB_DB           sqlite path (default /opt/bilibili-collector/collected/observations.sqlite3)
    BILI_HUB_HOST         bind address (default 127.0.0.1; keep it loopback and use an SSH tunnel)
    BILI_HUB_PORT         bind port (default 8765)
    BILI_HUB_TOKEN        bearer token; required unless BILI_HUB_ALLOW_ANON=1
    BILI_HUB_ALLOW_ANON   "1" allows unauthenticated access when no token is set (debug only)

The process never writes to the database: connections use mode=ro and query_only.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

LOG = logging.getLogger("bili-hub")

BV_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
MAX_TOP_COMMENTS = 500
MAX_REPLIES = 50
MAX_TEXT = 8000
MAX_DANMAKU = 20000
MAX_LIST_LIMIT = 100

DB_PATH = os.environ.get("BILI_HUB_DB") or "/opt/bilibili-collector/collected/observations.sqlite3"
HOST = os.environ.get("BILI_HUB_HOST") or "127.0.0.1"
PORT = int(os.environ.get("BILI_HUB_PORT") or "8765")
TOKEN = os.environ.get("BILI_HUB_TOKEN") or ""
ALLOW_ANON = os.environ.get("BILI_HUB_ALLOW_ANON") == "1"


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect("file:%s?mode=ro" % DB_PATH, uri=True, timeout=5)
    conn.execute("PRAGMA query_only=1")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def clean(values: dict) -> dict:
    """Drop None because the zod contract uses optional, not nullable."""
    return {key: value for key, value in values.items() if value is not None}


def parse_page(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def epoch_seconds(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value).timestamp())
    except (TypeError, ValueError):
        return None


def latest_snapshot(conn, bvid):
    return conn.execute(
        """
        SELECT s.snapshot_id, s.collected_at
        FROM snapshots s
        WHERE s.bvid = ? AND s.status = 'success'
          AND EXISTS (SELECT 1 FROM snapshot_pages p
                      WHERE p.snapshot_id = s.snapshot_id AND p.source = 'video')
        ORDER BY s.collected_at DESC
        LIMIT 1
        """,
        (bvid,),
    ).fetchone()


def load_pages(conn, snapshot_id):
    pages = {}
    for source, data in conn.execute(
        "SELECT source, data FROM snapshot_pages WHERE snapshot_id=? AND source NOT LIKE 'replies:%'",
        (snapshot_id,),
    ):
        pages[source] = parse_page(data)
    return pages


def build_video(view: dict) -> dict:
    owner = view.get("owner") or {}
    return clean(
        {
            "title": view.get("title") or "",
            "desc": view.get("desc") or "",
            "duration_s": view.get("duration"),
            "pubdate": view.get("pubdate"),
            "owner_name": owner.get("name"),
            "owner_mid": owner.get("mid"),
        }
    )


def build_author(profile, card, statistics=None) -> dict:
    profile = profile or {}
    card = card or {}
    statistics = statistics or {}
    inner = card.get("card") or {}
    official = profile.get("official") or inner.get("official_verify") or {}
    raw_official_type = official.get("type")
    # 站方原始 -1/0/1（无/个人/机构）→ 项目契约 0/1/2
    if not isinstance(raw_official_type, int) or raw_official_type < -1:
        raw_official_type = -1
    official_type = raw_official_type + 1
    fans = card.get("follower")
    if fans is None:
        fans = inner.get("fans")
    attention = inner.get("attention")
    if attention is None:
        attention = card.get("following")
    archive = statistics.get("archive") or {}
    video_count = card.get("archive_count")
    if not isinstance(video_count, int):
        video_count = inner.get("archive_count")
    total_views = archive.get("view")
    return clean(
        {
            "mid": profile.get("mid") or inner.get("mid"),
            "name": profile.get("name") or inner.get("name") or "",
            "fans": fans,
            "attention": attention,
            "official_type": official_type,
            "official_desc": official.get("desc") or "",
            "sign": profile.get("sign") or inner.get("sign") or "",
            "video_count": video_count,
            "total_views": total_views,
        }
    )


def build_tags(page) -> list:
    if not isinstance(page, list):
        return []
    return [tag["tag_name"] for tag in page if isinstance(tag, dict) and tag.get("tag_name")][:50]


def build_danmaku(conn, cid) -> list:
    if cid is None:
        return []
    rows = conn.execute(
        """
        SELECT offset_ms, text FROM danmaku
        WHERE cid = ? AND offset_ms IS NOT NULL AND text IS NOT NULL AND text <> ''
        ORDER BY offset_ms
        LIMIT ?
        """,
        (str(cid), MAX_DANMAKU),
    )
    return [{"t": round(offset_ms / 1000, 3), "text": text[:MAX_TEXT]} for offset_ms, text in rows]


def build_comments(conn, snapshot_id, bvid) -> list:
    rows = conn.execute(
        """
        SELECT o.rpid, o.root, o.seq, o.likes, o.username, o.published_at, v.content
        FROM comment_observations o
        LEFT JOIN comment_versions v
          ON v.bvid = ? AND v.rpid = o.rpid AND v.content_hash = o.content_hash
        WHERE o.snapshot_id = ?
        ORDER BY o.seq, o.rpid
        """,
        (bvid, snapshot_id),
    )
    tops = {}
    replies = {}
    for rpid, root, seq, likes, username, published_at, content in rows:
        item = clean(
            {
                "uname": username,
                "like": likes,
                "t": epoch_seconds(published_at),
                "message": (content or "")[:MAX_TEXT],
            }
        )
        if str(root or "0") == "0":
            tops[rpid] = item
        else:
            replies.setdefault(str(root), []).append(item)
    ordered = sorted(tops.items(), key=lambda pair: pair[1].get("like") or 0, reverse=True)
    result = []
    for rpid, item in ordered[:MAX_TOP_COMMENTS]:
        thread = replies.get(rpid)
        if thread:
            item["replies"] = thread[:MAX_REPLIES]
        result.append(item)
    return result


def assemble(conn, bvid) -> dict | None:
    row = latest_snapshot(conn, bvid)
    if not row:
        return None
    snapshot_id, collected_at = row
    pages = load_pages(conn, snapshot_id)
    view = pages.get("video") or {}
    if "bvid" not in view and isinstance(view.get("data"), dict):
        view = view["data"]
    cid = view.get("cid")
    if cid is None:
        page_list = view.get("pages") or []
        if page_list and isinstance(page_list[0], dict):
            cid = page_list[0].get("cid")
    video = build_video(view)
    tags = build_tags(pages.get("tags"))
    if tags:
        video["tags"] = tags
    return {
        "schema": "bili-snapshot/v1",
        "bvid": bvid,
        "fetched_at": collected_at,
        "video": video,
        "author": build_author(
            pages.get("uploader_profile"),
            pages.get("uploader_card"),
            pages.get("uploader_statistics"),
        ),
        "danmaku": build_danmaku(conn, cid),
        "comments": build_comments(conn, snapshot_id, bvid),
        "transcript": {"source": "none"},
    }


def list_snapshots(conn, since, limit, offset) -> dict:
    sql = [
        "SELECT s.bvid, MAX(s.collected_at) AS collected_at FROM snapshots s",
        "JOIN snapshot_pages p ON p.snapshot_id = s.snapshot_id AND p.source = 'video'",
        "WHERE s.status = 'success'",
    ]
    params = []
    if since:
        sql.append("AND s.collected_at > ?")
        params.append(since)
    sql.append("GROUP BY s.bvid ORDER BY collected_at DESC LIMIT ? OFFSET ?")
    params.extend([limit + 1, offset])
    rows = conn.execute(" ".join(sql), params).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [{"bvid": bvid, "fetched_at": collected_at} for bvid, collected_at in rows]
    page = {"items": items}
    if has_more:
        page["next_cursor"] = str(offset + len(items))
    return page


class Handler(BaseHTTPRequestHandler):
    server_version = "bili-hub/1"

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.address_string(), fmt % args)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        if not TOKEN:
            return ALLOW_ANON
        header = self.headers.get("Authorization") or ""
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix):].strip(), TOKEN)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            self.send_json(200, {"ok": True, "schema": "bili-snapshot/v1"})
            return
        if not url.path.startswith("/api/"):
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            conn = connect()
            try:
                if url.path == "/api/snapshots":
                    query = parse_qs(url.query)
                    since = (query.get("since") or [""])[0].strip() or None
                    try:
                        limit = min(max(int((query.get("limit") or ["50"])[0]), 1), MAX_LIST_LIMIT)
                        offset = max(int((query.get("cursor") or ["0"])[0]), 0)
                    except ValueError:
                        self.send_json(400, {"error": "limit/cursor must be integers"})
                        return
                    self.send_json(200, list_snapshots(conn, since, limit, offset))
                    return
                if url.path.startswith("/api/snapshots/"):
                    bvid = unquote(url.path[len("/api/snapshots/"):]).strip("/")
                    if not BV_RE.match(bvid):
                        self.send_json(400, {"error": "invalid bvid"})
                        return
                    snapshot = assemble(conn, bvid)
                    if snapshot is None:
                        self.send_json(404, {"error": "snapshot not found"})
                        return
                    self.send_json(200, snapshot)
                    return
                self.send_json(404, {"error": "not found"})
            finally:
                conn.close()
        except sqlite3.Error as exc:
            LOG.exception("database error")
            self.send_json(500, {"error": "database error: %s" % exc})
        except Exception:
            LOG.exception("unhandled error")
            self.send_json(500, {"error": "internal error"})


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not os.path.exists(DB_PATH):
        sys.exit("BILI_HUB_DB does not exist: %s" % DB_PATH)
    if not TOKEN and not ALLOW_ANON:
        sys.exit("BILI_HUB_TOKEN is required (or set BILI_HUB_ALLOW_ANON=1 for local debugging)")
    with connect() as conn:
        conn.execute("SELECT 1 FROM snapshots LIMIT 1")
    LOG.info("serving %s on http://%s:%s", DB_PATH, HOST, PORT)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
