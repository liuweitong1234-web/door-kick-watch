# Door Kick Watch

A community website where residents report door-kicking "challenge" incidents. Reports show up on
a public map so neighbours can see what's happening nearby. Moderators and police get the full details
and can download them as a spreadsheet.

## What it does

**Public site (`/`)**
- Map of reports, colour-coded by how recent they are (last 24 h / last 7 days / older). Reports at
  the same spot are grouped and show a count.
- Filter by period (24 h, 7 days, 30 days, 90 days, 1 year), with a list of the latest reports, totals,
  and the most common time of day.
- **Near me**: counts reports within 1 km of the visitor. Their location never leaves their device.
- **Report an incident** form: address (searched on OpenStreetMap, with a pin the reporter can drag,
  or a pin they place by clicking the map), date and time, how many people were involved, damage,
  whether they have camera footage, plus optional private fields: police report number, description,
  and contact details.

**Moderator & police view (`/admin`, needs the access token)**
- Every report with the exact address, private details and contact info.
- Map of exact locations, a list of the streets with the most reports, and reports by hour of day.
- Set each report's status: New, Verified, Forwarded to police, or Rejected. Rejected reports are hidden
  from the public map, and verified ones get a "Verified" badge.
- **Delete** removes a report permanently, for example when the reporter asks for it to be removed.
- **Download CSV for police**: a spreadsheet of all reports that opens cleanly in Excel.

**Privacy page (`/privacy`)**: explains who sees what, and how to have a report removed. It shows
your `CONTACT_EMAIL`.

## Privacy and abuse protections

- The public map never shows the exact address. Points are moved to the centre of a ~150 m grid square,
  and labels say "1200 block of Main St", never the house number.
- Description, police report number and contact details are private: only the admin view and the CSV
  export include them.
- The form asks people not to name or describe the people involved (many are minors) and to give
  footage to police directly. The site doesn't accept photos or videos.
- Each IP address can send 5 reports per hour and 20 address searches per minute (configurable).
- A hidden "honeypot" field quietly discards bot submissions. Dates in the future or more than a year
  ago are rejected.
- The CSV export defuses spreadsheet formulas, so a malicious report can't run code in Excel.
- All user text is shown as plain text, never HTML, and a strict Content-Security-Policy is applied.

## Run it on your computer

Requires Python 3.9+.

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

Then open http://127.0.0.1:5000. The admin token is created on first run and saved in
`data\admin_token.txt`. Paste it into http://127.0.0.1:5000/admin.

Reports are stored in `data\reports.db` (SQLite). Back up the `data` folder to keep them.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_TOKEN` | generated, saved in `data/admin_token.txt` | Password for the moderator & police view. **Required** by `serve.py` (20+ characters). |
| `CONTACT_EMAIL` | none | Shown on the privacy page so people can ask for a report to be corrected or removed. |
| `SITE_NAME` | `Door Kick Watch` | Name in the header and browser tab. |
| `DEFAULT_VIEW` | `39.8,-98.6,4` (USA) | Where the map opens before there are reports: `lat,lng,zoom`. Set this to your town, e.g. `40.71,-74.00,12`. |
| `COUNTRY_CODES` | worldwide | Limit address search to these countries, e.g. `us` or `us,ca`. Gives better matches. |
| `GEOCODER_USER_AGENT` | generic | **Set before going live.** OpenStreetMap's address search requires a name for your site and a way to contact you, e.g. `DoorKickWatch/1.0 (https://yoursite.org; you@yoursite.org)`. |
| `PUBLIC_GRID_METERS` | `150` | How much public map points are blurred. |
| `MAX_REPORTS_PER_HOUR` | `5` | Reports allowed per IP address per hour. |
| `MAX_GEOCODES_PER_MINUTE` | `20` | Address searches allowed per IP address per minute. |
| `DATA_DIR` | `./data` | Where the database and token are stored. Must be on a persistent disk when hosted. |
| `CLIENT_IP_HEADER` | none | Header in which the host passes each visitor's real IP. `X-Real-IP` on PythonAnywhere (the setup file sets this for you). Only set it when the host always overwrites the header. |
| `HOST` / `PORT` | `127.0.0.1` / `5000` (`app.py`), `0.0.0.0` / `8080` (`serve.py`) | Address and port to listen on. Most hosts set `PORT` for you. |

These only apply to `serve.py`, the production server:

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | `0` | Set to `1` when the host puts a proxy or load balancer in front of the app (Render, Railway, Fly.io, nginx). Without it, every visitor shares one rate limit. |
| `PROXY_COUNT` | `1` | Number of proxies in front of the app. Raise it only if your host chains several proxies. |
| `THREADS` | `8` | Worker threads. |

## Putting it online

### Before you start
- **Talk to your local police department** (non-emergency line or community liaison officer). Ask
  how they want to receive reports and who should get the admin token.
- **Pick a contact email** for the site. It appears on the privacy page and in the address-search
  User-Agent.
- **Find your town's coordinates** for `DEFAULT_VIEW`: right-click your town on
  [openstreetmap.org](https://www.openstreetmap.org), choose *Show address*, and use the latitude and
  longitude with a zoom of about 12. For example, `40.71,-74.00,12`.

### What the host must provide
The site is one Python app that stores reports in a SQLite file. The host needs:
1. **A persistent disk.** Without one, every deploy or restart wipes all reports.
2. **A single instance.** Don't scale it to several copies, because they can't share one SQLite file.
3. **HTTPS.** Most hosts provide it automatically. The "Near me" button only works over HTTPS.

`python serve.py` starts the production server (Waitress). It refuses to start without an
`ADMIN_TOKEN` of 20+ characters or a writable `DATA_DIR`, and it prints warnings for any
recommended settings that are missing. `GET /healthz` returns `{"ok": true}` for the host's
health checks.

### Free option: PythonAnywhere

PythonAnywhere's free "Beginner" plan can run this site. The free plan's limits:
- **One web app per account**, at `your-username.pythonanywhere.com`, with no custom domain. If
  your account already hosts another site, create a separate free account for this one.
  PythonAnywhere staff have said that's allowed, and you can use the same email address. When
  several accounts share an email, sign in with the username.
- **You must renew it every month.** Since January 2026, unused web apps on new free accounts
  expire after 1 month. Log in, open the **Web** tab and click the button that extends it. If it
  lapses, the site goes offline but your reports are kept. Set a monthly calendar reminder.
- **Small allowances:** 100 CPU-seconds a day, low bandwidth and 512 MB of storage. That's enough for
  a neighbourhood or small city. If you go over the CPU allowance, the site gets slower.
- **Limited internet access:** free accounts can only reach allowlisted sites. OpenStreetMap's
  address search (`nominatim.openstreetmap.org`) is on the list, so address lookup works.
- **No direct support:** free accounts get help from the community forums only.

**Steps** (replace `USERNAME` with your PythonAnywhere username):

1. **Create the account** at [pythonanywhere.com](https://www.pythonanywhere.com) using the free
   Beginner plan. The username becomes the web address, for example `doorkickwatch`.
2. **Make a read-only GitHub token,** so PythonAnywhere can download your private repository. On
   GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**. Under *Repository access*, choose **Only select repositories** and pick
   `door-kick-watch`. Under *Permissions*, set **Contents** to **Read-only**. Copy the token.
3. **Create the web app.** On PythonAnywhere, open the **Web** tab and choose **Add a new web app →
   Next → Manual configuration** (not "Flask") **→ Python 3.12 → Next**. If 3.12 isn't offered,
   pick the newest 3.x and use that version in step 4.
4. **Download the code.** Open **Consoles → Bash** and run:
   ```
   git clone https://github.com/liuweitong1234-web/door-kick-watch.git
   ```
   For *Username*, type your GitHub username. For *Password*, paste the token. Nothing shows while
   you paste. Then run:
   ```
   mkvirtualenv --python=/usr/bin/python3.12 dkw
   pip install -r ~/door-kick-watch/requirements.txt
   ```
5. **Configure the web app** on the **Web** tab:
   - **Virtualenv:** enter `/home/USERNAME/.virtualenvs/dkw`
   - **Static files:** add URL `/static/` with directory `/home/USERNAME/door-kick-watch/static`.
     This serves images and scripts without using your CPU allowance.
   - **Security:** turn **Force HTTPS** on. The "Near me" button needs HTTPS.
   - **WSGI configuration file:** click the link. Delete everything in the file and paste in
     [`deploy/pythonanywhere_wsgi.py`](deploy/pythonanywhere_wsgi.py). Replace `YOUR_USERNAME`, fill
     in your email, map location and country, then **Save**.
6. **Start it:** press the green **Reload** button, then open `https://USERNAME.pythonanywhere.com`.
7. **Get your admin token:** in the **Files** tab, open `door-kick-watch/data/admin_token.txt`. Use it
   to sign in at `https://USERNAME.pythonanywhere.com/admin`.
8. **Test it:** submit a report, check it on the map and in the admin page, then delete it there.

**Updating later:** push your changes to GitHub, then in a PythonAnywhere Bash console run
`cd ~/door-kick-watch && git pull`, and press **Reload** on the Web tab.

**If something's wrong:** the **Web** tab links to an *error log*. Most problems are a typo in the
WSGI file or a virtualenv path that doesn't match.

### Paid option A: Render (easiest, about US$7.25/month)
`render.yaml` sets everything up: the web service, a 1 GB disk for reports, health checks, and a
randomly generated admin token. Render needs a paid "Starter" instance to attach a disk.

1. Put this folder in a GitHub repository (private is fine).
2. On [render.com](https://render.com), choose **New → Blueprint** and select the repository.
3. When asked, fill in `GEOCODER_USER_AGENT`, `CONTACT_EMAIL`, `DEFAULT_VIEW` and `COUNTRY_CODES`.
4. After it deploys, open the service's **Environment** tab and copy `ADMIN_TOKEN`. Use it to sign in
   at `https://<your-app>.onrender.com/admin`.
5. Optional: add your own domain under **Settings → Custom Domains**.

Render takes daily snapshots of the disk. For your own backup, use **Download CSV** on the admin page.

### Paid option B: Docker (Railway, Fly.io, a VPS, anywhere)
```
docker build -t door-kick-watch .
docker run -d -p 8080:8080 --env-file .env -v dkw-data:/data --restart unless-stopped door-kick-watch
```
Copy `.env.example` to `.env` and fill it in first. Mount a persistent volume at `/data`. The app runs
as a non-root user (uid 10001). If your host mounts the volume owned by root and `serve.py` reports
it can't write to `DATA_DIR`, give uid 10001 write access to the volume.

On a VPS, put a reverse proxy such as Caddy or nginx in front of it for HTTPS, and set
`TRUST_PROXY=1`.

### After it's live
- Submit a test report, check it on the map and in `/admin`, then delete it from the admin page.
- Back up regularly: either the `reports.db` file in `DATA_DIR`, or the CSV from the admin page.
- To revoke someone's admin access, change `ADMIN_TOKEN` and restart. Everyone will then need the
  new token.

**Map and address search limits:** the map tiles and address search use OpenStreetMap's free public
services. They're fine for a neighbourhood or city site, but their usage policies don't allow heavy
traffic. If the site gets popular, switch to a paid provider (for example MapTiler, Stadia Maps, or
LocationIQ). Address search is configured with `GEOCODER_BASE`, and the tile URL is in
`static/app.js` and `static/admin.js`.

## Working with police

- Give each officer or moderator the token privately, never by public post or group chat.
- Use **Forwarded to police** to track which reports have been passed on, and filter by status before
  downloading the CSV.

## Files

```
app.py              Server: storage, address search, public and admin APIs
serve.py            Production launcher (Waitress), checks settings before starting
Dockerfile          Container image for Docker-based hosts
render.yaml         One-click Render setup (web service + disk + settings)
.env.example        Template for the settings file used with Docker
deploy/pythonanywhere_wsgi.py  Setup file to paste into PythonAnywhere (free hosting)
static/index.html   Public map page and report form
static/app.js       Public page logic
static/admin.html   Moderator & police view
static/admin.js     Admin page logic
static/privacy.html Privacy page (privacy.js fills in the site name and contact email)
static/style.css    Shared styles (light and dark mode)
static/admin.css    Admin-only styles
data/               Created at runtime: reports.db and admin_token.txt (do not share or commit)
```
