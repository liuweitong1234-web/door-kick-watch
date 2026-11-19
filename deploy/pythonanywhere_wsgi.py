# PythonAnywhere setup file for Door Kick Watch.
#
# How to use it (full steps are in README.md, "Free hosting on PythonAnywhere"):
#   Web tab -> click the "WSGI configuration file" link -> delete everything in that file,
#   paste this file in, change the values in the CHANGE THESE section, Save, then press
#   the green Reload button on the Web tab.
#
# This copy in GitHub is only a template. Your real settings live in the copy on PythonAnywhere.

import os
import sys

# ---- CHANGE THESE ----------------------------------------------------------------------------

# Where you cloned the code. Replace YOUR_USERNAME with your PythonAnywhere username.
PROJECT_DIR = "/home/YOUR_USERNAME/door-kick-watch"

SETTINGS = {
    # OpenStreetMap's address search requires a way to contact you.
    "GEOCODER_USER_AGENT": "DoorKickWatch/1.0 (you@example.com)",
    # Shown on the privacy page so people can ask for a report to be removed.
    "CONTACT_EMAIL": "you@example.com",
    # Where the map opens: latitude,longitude,zoom. Right-click your town on openstreetmap.org
    # and choose "Show address" to get its latitude and longitude.
    "DEFAULT_VIEW": "39.8,-98.6,4",
    # Limit address search to these countries, e.g. "us". Leave blank for worldwide.
    "COUNTRY_CODES": "",
    # Leave blank: a random admin token is created in door-kick-watch/data/admin_token.txt,
    # which you can open from the Files tab. If you set your own, use 20+ random characters.
    "ADMIN_TOKEN": "",
}

# ---- NO CHANGES NEEDED BELOW -----------------------------------------------------------------

# PythonAnywhere's load balancer puts each visitor's real IP address in this header.
# Without it, every visitor looks the same and shares one rate limit.
SETTINGS["CLIENT_IP_HEADER"] = "X-Real-IP"

for key, value in SETTINGS.items():
    if value:
        os.environ[key] = value

if os.environ.get("ADMIN_TOKEN") and len(os.environ["ADMIN_TOKEN"]) < 20:
    raise RuntimeError("ADMIN_TOKEN must be at least 20 characters long, or left blank.")

if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

from app import app as application  # noqa: E402
