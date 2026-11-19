"""Door Kick Watch - a community map of door-kicking "challenge" incidents.

Residents report where and when an incident happened. The public map shows
reports at block level (never the exact address); moderators and police get
the full details through the token-protected /admin page and CSV export.

Run locally:   .venv\\Scripts\\python.exe app.py   (development server)
Production:    python serve.py                      (Waitress, see README.md)
Configuration: environment variables, see README.md.
"""

import csv
import hashlib
import io
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, g, jsonify, request, send_from_directory

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "reports.db")

SITE_NAME = os.environ.get("SITE_NAME", "Door Kick Watch")
# Shown on the privacy page so people can ask for a report to be corrected or removed.
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "").strip()
# Where the map opens before any reports exist: "lat,lng,zoom".
DEFAULT_VIEW = os.environ.get("DEFAULT_VIEW", "39.8,-98.6,4")
# Restrict address search to these countries, e.g. "us" or "us,ca". Empty = worldwide.
COUNTRY_CODES = os.environ.get("COUNTRY_CODES", "").strip()

GEOCODER_BASE = os.environ.get("GEOCODER_BASE", "https://nominatim.openstreetmap.org").rstrip("/")
# Nominatim's usage policy asks for a User-Agent that identifies your site and a
# way to contact you. Set this before you put the site online.
GEOCODER_USER_AGENT = os.environ.get(
    "GEOCODER_USER_AGENT", "DoorKickWatch/1.0 (community incident map)"
)

# Public map points are snapped to a grid of this size so a single house can't be identified.
PUBLIC_GRID_METERS = int(os.environ.get("PUBLIC_GRID_METERS", "150"))
MAX_REPORTS_PER_HOUR = int(os.environ.get("MAX_REPORTS_PER_HOUR", "5"))
MAX_GEOCODES_PER_MINUTE = int(os.environ.get("MAX_GEOCODES_PER_MINUTE", "20"))
# Reverse-proxy handling (TRUST_PROXY / PROXY_COUNT) lives in serve.py, because Waitress
# strips X-Forwarded-* headers before the app sees them unless it is told to trust them.
# Hosts that run the app on their own server (PythonAnywhere) instead pass the visitor's IP in a
# header: set CLIENT_IP_HEADER=X-Real-IP there. Only set it when the host's proxy always
# overwrites that header; otherwise visitors could fake it to dodge rate limits.
CLIENT_IP_HEADER = os.environ.get("CLIENT_IP_HEADER", "").strip()

STATUSES = ("new", "verified", "forwarded", "rejected")
PEOPLE_CHOICES = ("", "1", "2-3", "4+")
RANGE_DAYS = (1, 7, 30, 90, 365)

os.makedirs(DATA_DIR, exist_ok=True)


def _load_admin_token():
    token = os.environ.get("ADMIN_TOKEN", "").strip()
    if token:
        return token
    path = os.path.join(DATA_DIR, "admin_token.txt")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            token = fh.read().strip()
    if not token:
        token = secrets.token_urlsafe(24)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(token)
    return token


ADMIN_TOKEN = _load_admin_token()
IP_SALT = secrets.token_bytes(16)  # per-process; only used to rate-limit, never stored raw

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024  # reports are tiny; reject anything large
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 300  # cache static files briefly so updates show up fast

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT NOT NULL,              -- UTC, when the report was submitted
    occurred_at      TEXT NOT NULL,              -- UTC, when the incident happened
    address          TEXT NOT NULL,              -- as typed by the reporter (private)
    house_number     TEXT,
    road             TEXT,
    locality         TEXT,
    postcode         TEXT,
    lat              REAL NOT NULL,              -- exact pin (private)
    lng              REAL NOT NULL,
    pub_lat          REAL NOT NULL,              -- snapped to grid (public)
    pub_lng          REAL NOT NULL,
    public_label     TEXT NOT NULL,              -- e.g. "1200 block of Main St, Springfield"
    people           TEXT NOT NULL DEFAULT '',
    damage           INTEGER NOT NULL DEFAULT 0,
    footage          INTEGER NOT NULL DEFAULT 0,
    police_report_no TEXT NOT NULL DEFAULT '',   -- private
    details          TEXT NOT NULL DEFAULT '',   -- private
    contact          TEXT NOT NULL DEFAULT '',   -- private
    status           TEXT NOT NULL DEFAULT 'new',
    ip_hash          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reports_occurred ON reports (occurred_at);
CREATE INDEX IF NOT EXISTS idx_reports_ip_created ON reports (ip_hash, created_at);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)


init_db()

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def client_ip():
    if CLIENT_IP_HEADER:
        # Take the last entry: it's the one added by the host's own proxy.
        value = request.headers.get(CLIENT_IP_HEADER, "").rsplit(",", 1)[-1].strip()
        if value:
            return value[:64]
    return request.remote_addr or "unknown"


def client_ip_hash():
    return hashlib.sha256(IP_SALT + client_ip().encode()).hexdigest()[:32]


def clean_text(value, max_len):
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value).strip()
    return value[:max_len]


def snap_to_grid(lat, lng, meters=PUBLIC_GRID_METERS):
    """Move a point to the centre of a ~`meters` grid cell."""
    dlat = meters / 111_320.0
    lat_s = (math.floor(lat / dlat) + 0.5) * dlat
    dlng = meters / (111_320.0 * max(math.cos(math.radians(lat_s)), 0.01))
    lng_s = (math.floor(lng / dlng) + 0.5) * dlng
    return round(lat_s, 5), round(lng_s, 5)


def block_label(house_number, road, locality):
    """'1234 Main St' -> '1200 block of Main St'. Never exposes the house number."""
    parts = []
    if road:
        digits = re.match(r"\d+", house_number or "")
        if digits:
            block = int(digits.group()) // 100 * 100
            parts.append(f"{block if block else '1–99'} block of {road}")
        else:
            parts.append(road)
    if locality:
        parts.append(locality)
    if not parts:
        return "Reported location"
    if not road:
        return f"Near {locality}"
    return ", ".join(parts)


def json_error(message, status=400):
    return jsonify({"error": message}), status


# --------------------------------------------------------------------------
# Geocoding (OpenStreetMap Nominatim, proxied so we can cache + throttle)
# --------------------------------------------------------------------------

_geo_lock = threading.Lock()
_geo_last_call = [0.0]
_geo_cache = {}
_geo_cache_order = deque()
_geo_ip_hits = defaultdict(deque)
GEO_CACHE_MAX = 1000


def _nominatim(path, params):
    key = (path, tuple(sorted(params.items())))
    if key in _geo_cache:
        return _geo_cache[key]
    url = f"{GEOCODER_BASE}/{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": GEOCODER_USER_AGENT, "Accept-Language": "en"},
    )
    with _geo_lock:  # Nominatim policy: at most 1 request per second
        wait = 1.05 - (time.monotonic() - _geo_last_call[0])
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        finally:
            _geo_last_call[0] = time.monotonic()
    _geo_cache[key] = data
    _geo_cache_order.append(key)
    while len(_geo_cache_order) > GEO_CACHE_MAX:
        _geo_cache.pop(_geo_cache_order.popleft(), None)
    return data


def _address_parts(addr):
    addr = addr or {}
    locality = ""
    for k in ("city", "town", "village", "hamlet", "suburb", "municipality", "county"):
        if addr.get(k):
            locality = addr[k]
            break
    return {
        "house_number": addr.get("house_number", ""),
        "road": addr.get("road") or addr.get("pedestrian") or addr.get("street") or "",
        "locality": locality,
        "postcode": addr.get("postcode", ""),
    }


def geocode_search(query):
    params = {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 5}
    if COUNTRY_CODES:
        params["countrycodes"] = COUNTRY_CODES
    results = []
    for item in _nominatim("search", params):
        parts = _address_parts(item.get("address"))
        results.append(
            {
                "label": item.get("display_name", ""),
                "lat": float(item["lat"]),
                "lng": float(item["lon"]),
                **parts,
            }
        )
    return results


def reverse_geocode(lat, lng):
    data = _nominatim(
        "reverse",
        {"lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "format": "jsonv2", "addressdetails": 1, "zoom": 18},
    )
    return _address_parts(data.get("address") if isinstance(data, dict) else None)


def geocode_rate_ok():
    now = time.monotonic()
    hits = _geo_ip_hits[client_ip_hash()]
    while hits and now - hits[0] > 60:
        hits.popleft()
    if len(hits) >= MAX_GEOCODES_PER_MINUTE:
        return False
    hits.append(now)
    return True


# --------------------------------------------------------------------------
# Pages + security headers
# --------------------------------------------------------------------------


@app.after_request
def security_headers(resp):
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com; "
        "img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(self), camera=(), microphone=()"
    if request.is_secure:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.path.startswith("/api/admin"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/admin")
def admin_page():
    return send_from_directory(STATIC_DIR, "admin.html")


@app.get("/privacy")
def privacy_page():
    return send_from_directory(STATIC_DIR, "privacy.html")


@app.get("/healthz")
def healthz():
    """Used by the hosting platform to check the app and its database are up."""
    try:
        get_db().execute("SELECT 1").fetchone()
    except sqlite3.Error:
        return jsonify({"ok": False}), 503
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


@app.get("/api/config")
def api_config():
    try:
        lat, lng, zoom = (float(x) for x in DEFAULT_VIEW.split(","))
    except ValueError:
        lat, lng, zoom = 39.8, -98.6, 4
    return jsonify(
        {"site_name": SITE_NAME, "center": [lat, lng], "zoom": int(zoom), "contact_email": CONTACT_EMAIL}
    )


@app.get("/api/geocode")
def api_geocode():
    q = clean_text(request.args.get("q"), 200)
    if len(q) < 4:
        return json_error("Type a fuller address.")
    if not geocode_rate_ok():
        return json_error("Too many searches. Please wait a minute and try again.", 429)
    try:
        return jsonify({"results": geocode_search(q)})
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
        app.logger.warning("geocode failed: %s", exc)
        return json_error(
            "Address search is unavailable right now. You can click the map to place the pin.", 502
        )


@app.get("/api/reports")
def api_reports():
    try:
        days = int(request.args.get("days", 30))
    except ValueError:
        days = 30
    if days not in RANGE_DAYS:
        days = 30
    cutoff = iso(utcnow() - timedelta(days=days))
    rows = get_db().execute(
        """SELECT id, occurred_at, public_label, pub_lat, pub_lng, people, damage, footage, status
           FROM reports
           WHERE status != 'rejected' AND occurred_at >= ?
           ORDER BY occurred_at DESC
           LIMIT 5000""",
        (cutoff,),
    ).fetchall()
    return jsonify(
        {
            "days": days,
            "reports": [
                {
                    "id": r["id"],
                    "occurred_at": r["occurred_at"],
                    "label": r["public_label"],
                    "lat": r["pub_lat"],
                    "lng": r["pub_lng"],
                    "people": r["people"],
                    "damage": bool(r["damage"]),
                    "footage": bool(r["footage"]),
                    "verified": r["status"] in ("verified", "forwarded"),
                }
                for r in rows
            ],
        }
    )


@app.post("/api/reports")
def api_create_report():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("Invalid request.")

    # Honeypot: real people never see or fill the "website" field.
    if clean_text(data.get("website"), 200):
        return jsonify({"ok": True, "id": None}), 201

    address = clean_text(data.get("address"), 200)
    if len(address) < 4:
        return json_error("Please enter the address where it happened.")

    occurred = parse_iso(data.get("occurred_at"))
    now = utcnow()
    if occurred is None:
        return json_error("Please enter when it happened.")
    if occurred > now + timedelta(minutes=10):
        return json_error("The date and time can't be in the future.")
    if occurred < now - timedelta(days=365):
        return json_error("Reports must be for incidents within the last year.")

    try:
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
    except (TypeError, ValueError):
        return json_error("Please find the address or place the pin on the map.")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        return json_error("Please find the address or place the pin on the map.")

    if data.get("confirm") is not True:
        return json_error("Please confirm the report is accurate.")

    people = clean_text(data.get("people"), 5)
    if people not in PEOPLE_CHOICES:
        people = ""

    db = get_db()
    ip_hash = client_ip_hash()
    recent = db.execute(
        "SELECT COUNT(*) FROM reports WHERE ip_hash = ? AND created_at >= ?",
        (ip_hash, iso(now - timedelta(hours=1))),
    ).fetchone()[0]
    if recent >= MAX_REPORTS_PER_HOUR:
        return json_error("You've sent several reports recently. Please try again later.", 429)

    parts = {k: clean_text(data.get(k), 100) for k in ("house_number", "road", "locality", "postcode")}
    if not parts["road"]:
        # Pin was placed by hand: look up the street name for the public label (best effort).
        try:
            parts = reverse_geocode(lat, lng)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as exc:
            app.logger.warning("reverse geocode failed: %s", exc)

    pub_lat, pub_lng = snap_to_grid(lat, lng)
    label = block_label(parts["house_number"], parts["road"], parts["locality"])

    cur = db.execute(
        """INSERT INTO reports (created_at, occurred_at, address, house_number, road, locality,
               postcode, lat, lng, pub_lat, pub_lng, public_label, people, damage, footage,
               police_report_no, details, contact, status, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)""",
        (
            iso(now),
            iso(occurred),
            address,
            parts["house_number"],
            parts["road"],
            parts["locality"],
            parts["postcode"],
            round(lat, 6),
            round(lng, 6),
            pub_lat,
            pub_lng,
            label,
            people,
            1 if data.get("damage") is True else 0,
            1 if data.get("footage") is True else 0,
            clean_text(data.get("police_report_no"), 60),
            clean_text(data.get("details"), 1000),
            clean_text(data.get("contact"), 120),
            ip_hash,
        ),
    )
    db.commit()
    return jsonify({"ok": True, "id": cur.lastrowid, "label": label, "lat": pub_lat, "lng": pub_lng}), 201


# --------------------------------------------------------------------------
# Moderator / police API (Authorization: Bearer <ADMIN_TOKEN>)
# --------------------------------------------------------------------------


def require_admin():
    header = request.headers.get("Authorization", "")
    token = header[7:] if header.startswith("Bearer ") else ""
    return bool(token) and secrets.compare_digest(token.encode(), ADMIN_TOKEN.encode())


ADMIN_FIELDS = (
    "id", "created_at", "occurred_at", "status", "address", "public_label", "lat", "lng",
    "people", "damage", "footage", "police_report_no", "details", "contact",
)


@app.get("/api/admin/reports")
def api_admin_reports():
    if not require_admin():
        return json_error("Not authorised.", 401)
    rows = get_db().execute(
        f"SELECT {', '.join(ADMIN_FIELDS)} FROM reports ORDER BY occurred_at DESC LIMIT 10000"
    ).fetchall()
    return jsonify({"reports": [dict(r) for r in rows]})


@app.patch("/api/admin/reports/<int:report_id>")
def api_admin_update(report_id):
    if not require_admin():
        return json_error("Not authorised.", 401)
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if status not in STATUSES:
        return json_error("Unknown status.")
    db = get_db()
    cur = db.execute("UPDATE reports SET status = ? WHERE id = ?", (status, report_id))
    db.commit()
    if cur.rowcount == 0:
        return json_error("Report not found.", 404)
    return jsonify({"ok": True})


@app.delete("/api/admin/reports/<int:report_id>")
def api_admin_delete(report_id):
    """Permanently remove a report, e.g. when the reporter asks for it to be deleted."""
    if not require_admin():
        return json_error("Not authorised.", 401)
    db = get_db()
    cur = db.execute("DELETE FROM reports WHERE id = ?", (report_id,))
    db.commit()
    if cur.rowcount == 0:
        return json_error("Report not found.", 404)
    app.logger.info("report %s deleted by moderator", report_id)
    return jsonify({"ok": True})


def _csv_safe(value):
    """Stop spreadsheet apps from treating user text as a formula."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


@app.get("/api/admin/export.csv")
def api_admin_export():
    if not require_admin():
        return json_error("Not authorised.", 401)
    include_rejected = request.args.get("include_rejected") == "1"
    sql = f"SELECT {', '.join(ADMIN_FIELDS)} FROM reports"
    if not include_rejected:
        sql += " WHERE status != 'rejected'"
    rows = get_db().execute(sql + " ORDER BY occurred_at").fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["report_id", "submitted_utc", "occurred_utc", "status", "address", "public_label",
         "latitude", "longitude", "people", "damage", "has_footage", "police_report_no",
         "details", "reporter_contact"]
    )
    for r in rows:
        writer.writerow(
            [_csv_safe(r[f]) if f not in ("damage", "footage") else ("yes" if r[f] else "no")
             for f in ADMIN_FIELDS]
        )
    filename = f"door-kick-reports-{utcnow().strftime('%Y%m%d')}.csv"
    return Response(
        "﻿" + buf.getvalue(),  # BOM so Excel opens UTF-8 correctly
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )


# --------------------------------------------------------------------------

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    print(f"\n  {SITE_NAME} running at http://{host}:{port}")
    print(f"  Admin page: http://{host}:{port}/admin")
    print(f"  Admin token is in {os.path.join(DATA_DIR, 'admin_token.txt')} (or set ADMIN_TOKEN)")
    print("  This is the development server. Use `python serve.py` when hosting the site.\n")
    app.run(host=host, port=port, debug=False, threaded=True)
