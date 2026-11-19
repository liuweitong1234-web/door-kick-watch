"""Production entry point: serves Door Kick Watch with Waitress.

    python serve.py

Uses the same environment variables as app.py (see README.md), plus:

    HOST          interface to listen on            (default 0.0.0.0)
    PORT          port to listen on                 (default 8080; most hosts set this for you)
    THREADS       worker threads                    (default 8)
    TRUST_PROXY   1 when your host puts a proxy or load balancer in front of the app
                  (Render, Railway, Fly.io, nginx...). Needed so rate limits see each
                  visitor's real IP address instead of the proxy's.
    PROXY_COUNT   how many proxies are in front of the app (default 1)
"""

import logging
import os
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def fail(message):
    print(f"\n  ERROR: {message}\n", file=sys.stderr)
    sys.exit(1)


def check_config():
    """Stop on settings that would make the live site unsafe; warn about the rest."""
    token = os.environ.get("ADMIN_TOKEN", "").strip()
    if len(token) < 20:
        fail(
            "Set ADMIN_TOKEN to a long random value (20+ characters) before hosting the site.\n"
            '  Make one with:  python -c "import secrets; print(secrets.token_urlsafe(32))"'
        )

    data_dir = os.environ.get("DATA_DIR") or os.path.join(BASE_DIR, "data")
    try:
        os.makedirs(data_dir, exist_ok=True)
        with tempfile.TemporaryFile(dir=data_dir):
            pass
    except OSError as exc:
        fail(
            f"Can't write to DATA_DIR ({data_dir}): {exc}\n"
            "  Point DATA_DIR at a persistent disk the app is allowed to write to."
        )

    warnings = []
    agent = os.environ.get("GEOCODER_USER_AGENT", "")
    if "@" not in agent and "http" not in agent:
        warnings.append(
            "GEOCODER_USER_AGENT has no contact details, so OpenStreetMap may block address search.\n"
            "    Example: DoorKickWatch/1.0 (https://yoursite.org; you@yoursite.org)"
        )
    if not os.environ.get("CONTACT_EMAIL", "").strip():
        warnings.append("CONTACT_EMAIL is not set, so the privacy page has no way for people to reach you.")
    if not os.environ.get("DEFAULT_VIEW", "").strip():
        warnings.append("DEFAULT_VIEW is not set, so the map opens on the whole USA until reports come in.")
    if os.environ.get("TRUST_PROXY") != "1":
        warnings.append(
            "TRUST_PROXY is not 1. If your host puts a proxy in front of the app, all visitors\n"
            "    will share one rate limit (5 reports an hour for everyone)."
        )
    return data_dir, warnings


def main():
    data_dir, warnings = check_config()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from waitress import serve

    import app as site

    options = {
        "host": os.environ.get("HOST", "0.0.0.0"),
        "port": int(os.environ.get("PORT", "8080")),
        "threads": int(os.environ.get("THREADS", "8")),
    }
    if os.environ.get("TRUST_PROXY") == "1":
        # Waitress drops X-Forwarded-* headers unless told to trust them. With these settings it
        # puts the visitor's IP in REMOTE_ADDR and marks HTTPS requests as secure.
        options.update(
            trusted_proxy="*",
            trusted_proxy_count=int(os.environ.get("PROXY_COUNT", "1")),
            trusted_proxy_headers={"x-forwarded-for", "x-forwarded-proto"},
        )

    # flush=True: hosts capture stdout through a pipe, where Python would otherwise hold these back.
    print(f"\n  {site.SITE_NAME} (production) - data in {data_dir}", flush=True)
    for warning in warnings:
        print(f"  WARNING: {warning}", flush=True)
    print(flush=True)
    serve(site.app, **options)


if __name__ == "__main__":
    main()
