from http.server import BaseHTTPRequestHandler
import datetime
import json
import os
import urllib.parse
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def _serial(obj):
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} not serializable")


def ok(handler, data):
    body = json.dumps(data, default=_serial).encode()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def err(handler, message, status=500):
    body = json.dumps({"error": message}).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


# ── action handlers ────────────────────────────────────────────────────────────

def ensure_user(cur, body):
    """Create user row if not exists, return user id and created flag."""
    session_id = body.get("session_id", "")
    if not session_id:
        return {"error": "session_id required"}, 400
    cur.execute(
        """
        INSERT INTO users (session_id)
        VALUES (%s)
        ON CONFLICT (session_id) DO UPDATE SET last_active = NOW()
        RETURNING id, session_id, created_at, last_active
        """,
        (session_id,)
    )
    row = cur.fetchone()
    return {"user": dict(row)}, 200


def add_favorite(cur, body):
    user_id     = body.get("user_id")
    movie_id    = body.get("movie_id")
    movie_title = body.get("movie_title", "")
    poster_path = body.get("poster_path")
    vote_avg    = body.get("vote_average")
    if not user_id or not movie_id:
        return {"error": "user_id and movie_id required"}, 400
    cur.execute(
        """
        INSERT INTO favorites (user_id, movie_id, movie_title, poster_path, vote_average)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (user_id, movie_id) DO NOTHING
        RETURNING id
        """,
        (user_id, movie_id, movie_title, poster_path, vote_avg)
    )
    row = cur.fetchone()
    return {"added": row is not None}, 200


def remove_favorite(cur, body):
    user_id  = body.get("user_id")
    movie_id = body.get("movie_id")
    if not user_id or not movie_id:
        return {"error": "user_id and movie_id required"}, 400
    cur.execute(
        "DELETE FROM favorites WHERE user_id = %s AND movie_id = %s",
        (user_id, movie_id)
    )
    return {"removed": cur.rowcount > 0}, 200


def get_favorites(cur, body):
    user_id = body.get("user_id")
    if not user_id:
        return {"error": "user_id required"}, 400
    cur.execute(
        """
        SELECT movie_id, movie_title, poster_path, vote_average, added_at
        FROM favorites
        WHERE user_id = %s
        ORDER BY added_at DESC
        """,
        (user_id,)
    )
    rows = [dict(r) for r in cur.fetchall()]
    return {"favorites": rows}, 200


def log_mood(cur, body):
    user_id    = body.get("user_id")
    mood       = body.get("mood", "")
    input_text = body.get("input_text")
    confidence = body.get("confidence")
    if not user_id or not mood:
        return {"error": "user_id and mood required"}, 400
    cur.execute(
        """
        INSERT INTO mood_history (user_id, mood, input_text, confidence)
        VALUES (%s, %s, %s, %s)
        RETURNING id, logged_at
        """,
        (user_id, mood, input_text, confidence)
    )
    row = cur.fetchone()
    return {"logged": dict(row)}, 200


def get_mood_history(cur, body):
    user_id = body.get("user_id")
    limit   = min(int(body.get("limit", 20)), 100)
    if not user_id:
        return {"error": "user_id required"}, 400
    cur.execute(
        """
        SELECT mood, input_text, confidence, logged_at
        FROM mood_history
        WHERE user_id = %s
        ORDER BY logged_at DESC
        LIMIT %s
        """,
        (user_id, limit)
    )
    rows = [dict(r) for r in cur.fetchall()]
    return {"history": rows}, 200


def log_search(cur, body):
    user_id      = body.get("user_id")
    query        = body.get("query", "")
    result_count = body.get("result_count", 0)
    if not query:
        return {"error": "query required"}, 400
    cur.execute(
        """
        INSERT INTO search_logs (user_id, query, result_count)
        VALUES (%s, %s, %s)
        """,
        (user_id, query, result_count)
    )
    return {"logged": True}, 200


def mood_trends(cur, _body):
    cur.execute("SELECT mood, total_count, avg_confidence, last_7_days, last_30_days FROM mood_trends")
    rows = [dict(r) for r in cur.fetchall()]
    return {"trends": rows}, 200


def get_stats(cur, _body):
    cur.execute("SELECT COUNT(*) AS total FROM users")
    total_users = cur.fetchone()["total"]

    cur.execute("SELECT COUNT(*) AS total FROM favorites")
    total_favorites = cur.fetchone()["total"]

    cur.execute("SELECT COUNT(*) AS total FROM mood_history")
    total_moods = cur.fetchone()["total"]

    cur.execute("SELECT COUNT(*) AS total FROM search_logs")
    total_searches = cur.fetchone()["total"]

    cur.execute(
        """
        SELECT mood, COUNT(*) AS cnt
        FROM mood_history
        GROUP BY mood ORDER BY cnt DESC LIMIT 1
        """
    )
    top_row = cur.fetchone()
    top_mood = dict(top_row) if top_row else {}

    cur.execute(
        """
        SELECT query, COUNT(*) AS cnt
        FROM search_logs
        GROUP BY query ORDER BY cnt DESC LIMIT 5
        """
    )
    top_searches = [dict(r) for r in cur.fetchall()]

    return {
        "stats": {
            "total_users":    total_users,
            "total_favorites": total_favorites,
            "total_moods":    total_moods,
            "total_searches": total_searches,
            "top_mood":       top_mood,
            "top_searches":   top_searches,
        }
    }, 200


# ── action router ──────────────────────────────────────────────────────────────

ACTIONS = {
    "ensure_user":      ensure_user,
    "add_favorite":     add_favorite,
    "remove_favorite":  remove_favorite,
    "get_favorites":    get_favorites,
    "log_mood":         log_mood,
    "get_mood_history": get_mood_history,
    "log_search":       log_search,
    "mood_trends":      mood_trends,
    "get_stats":        get_stats,
}


class handler(BaseHTTPRequestHandler):
    def _handle(self, body_bytes=b""):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            action = params.get("action", [""])[0]

            if action not in ACTIONS:
                return err(self, f"Unknown action: '{action}'", 400)

            body = {}
            if body_bytes:
                try:
                    body = json.loads(body_bytes.decode())
                except Exception:
                    return err(self, "Invalid JSON body", 400)

            with get_conn() as conn:
                with conn.cursor() as cur:
                    data, status = ACTIONS[action](cur, body)
                    conn.commit()

            if status != 200:
                return err(self, data.get("error", "Error"), status)
            ok(self, data)

        except Exception as e:
            err(self, str(e))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length) if length else b""
        self._handle(body)

    def do_GET(self):
        self._handle()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
