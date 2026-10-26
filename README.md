# Froze

Paste a URL, get back a ZIP that's a faithful, offline-browsable copy of that
site — extract it, run one command, and it looks and works like the original
when served on `localhost`.

- **Frontend:** React + Vite + Tailwind CSS, single page, dark/light mode, live progress via Server-Sent Events.
- **Backend:** Node.js + Express. A from-scratch BFS crawler (Cheerio for HTML/CSS parsing, native `fetch`) rewrites every URL to a root-relative local path, then `archiver` zips the result.
- **No build step for the crawler** — it's plain HTTP + HTML/CSS parsing, which is fast and requires no headless browser for the common case (see [Known limitations](#known-limitations)).

## Quick start (development)

Requires Node.js 18+ (native `fetch`).

```bash
# Terminal 1 — backend (port 8787)
cd server
npm install   # also downloads a headless Chromium (~300MB) for the JS-rendering mode
npm run dev

# Terminal 2 — frontend (port 5173, proxies /api to the backend)
cd client
npm install
npm run dev
```

Open **http://localhost:5173**, paste a URL, click **Mirror & Download**.

## Quick start (Docker, single container)

```bash
docker compose up --build
```

Then open **http://localhost:8787** — the same Express server serves the
built frontend and the API on one port. (Or `docker build -t froze . && docker run -p 8787:8787 froze`.)

## Deploying it live (public)

Froze is **not** a static site — the backend runs a headless browser,
holds job state in memory, streams progress over SSE, and writes temp files, so
it needs a **container host** (Render, Railway, Fly.io, or a VPS), not a
static/serverless host like GitHub Pages or Vercel functions. The included
`Dockerfile` builds the frontend and serves it from the Express server, so the
whole app is **one container on one port**.

**Render (one blueprint):** push this repo to GitHub, then in Render do
*New → Blueprint* and point it at the repo — it reads [`render.yaml`](render.yaml),
which already sets `NODE_ENV=production` (enabling the safeguards below). Any
Docker-capable host works the same way with the env vars in the table below.

### Safety when public

A crawler that will fetch any URL is, exposed to the internet, a **server-side
request forgery (SSRF)** risk — visitors could aim it at the host's own private
network or the cloud metadata endpoint (`169.254.169.254`) to steal
credentials. Public mode (on whenever `NODE_ENV=production` or `SSRF_PROTECT=1`)
turns on:

- **SSRF protection** (`server/src/crawler/ssrf.js`): every outbound target —
  the entry URL, every crawled page/asset, redirects, and every request the
  headless browser makes — is DNS-resolved and refused unless it's an ordinary
  **public** address. Loopback, RFC-1918 private ranges, link-local (incl. the
  metadata IP), unique-local v6, CGNAT, multicast and reserved ranges are all
  blocked, with a connect-time re-check that also defeats DNS-rebinding.
- **Rate limiting**: 5 crawls per minute per IP.
- **A global concurrency cap** (`MAX_CONCURRENT_JOBS`, default 3) so one visitor
  can't tie up the box.
- **Tighter abuse ceilings**: depth 4, 60 pages, 150 MB per crawl (vs. the
  generous local limits).

Locally these are **off** by default so you can still mirror `http://localhost`
test sites; set `SSRF_PROTECT=1` to exercise them in dev.

## Environment variables

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | server | `8787` | Port the Express API (and, in Docker, the built frontend) listens on. |
| `NODE_ENV` | server | — | `production` enables SSRF protection + public abuse caps. |
| `SSRF_PROTECT` | server | off | Set to `1` to force SSRF protection on (implied by `NODE_ENV=production`). |
| `MAX_CONCURRENT_JOBS` | server | 3 public / 100 local | Hard cap on crawls running at once across all visitors. |

The frontend needs no environment variables in dev — Vite's dev server proxies
`/api/*` to `http://localhost:8787` (see `client/vite.config.js`). In Docker,
frontend and backend share an origin, so no proxy/config is needed at all.

## How it works

1. **Crawl** (`server/src/crawler/Crawler.js`): starting from the entry URL,
   BFS-crawls same-origin pages up to a max depth/page count, downloading
   every HTML page and — from each page — every linked asset: stylesheets,
   scripts, images (`src`/`srcset`/`<picture>`), fonts, favicons, web app
   manifests, inline `<style>` blocks, and `style="…url(…)"` attributes.
   CSS files are parsed recursively for `url()` / `@import` references
   (fonts, background images, imported stylesheets). Web manifest `icons`
   are followed too.
2. **Politeness & safety:** `robots.txt` is fetched and honored by default;
   requests are capped by a configurable concurrency limit with a per-request
   delay; tracking/session query params (`utm_*`, `jsessionid`, …) are
   stripped before dedup so the same page isn't crawled dozens of times;
   a per-path visit cap defends against pagination/calendar traps; hard
   ceilings on depth, page count, and total download size prevent runaway
   crawls.
3. **Rewrite:** once crawling finishes, every downloaded HTML/CSS file has
   its URLs rewritten to **root-relative paths** (e.g. `/css/app.css`)
   pointing at the locally saved copy. Root-relative (rather than
   `../../relative`) paths mean every page resolves correctly from any
   directory depth as long as the mirror is served from its root — which
   is exactly what `serve.py` / `npx serve` / Live Server all do. JavaScript
   files get a best-effort literal string replacement of any absolute URL
   that matches a downloaded resource. Anything that couldn't be mirrored
   (blocked by robots.txt, an external host with "include external assets"
   off, or a failed fetch) is left pointing at its original live URL, so the
   page degrades gracefully instead of breaking. This same rewrite pass also
   strips known cookie-consent platforms (Cookiebot, OneTrust, Didomi, Osano,
   Usercentrics, Quantcast) — both their loader `<script>` and their banner
   markup. Without this, a banner that happened to be open when the page was
   captured (or whose styling lives on a CDN we don't mirror by default)
   would show up as an unstyled wall of cookie-policy text covering the real
   page; and leaving the loader script in place would just re-download it
   and reopen the banner the moment the mirror is opened with a live
   internet connection. A static archive can't submit real consent to
   anyone anyway, so removing it is strictly an improvement.
4. **Package:** the output folder is zipped with `archiver`, alongside a
   generated `README.txt`, `serve.py`, and `package.json` so a non-technical
   user can run one command and see the site.
5. **Progress & cancellation:** the crawler reports progress (pages/assets
   done, current URL, byte count, percent, ETA) via a callback; the server
   forwards it to the browser over Server-Sent Events; a shared `control`
   flag lets the client cancel mid-crawl, which stops scheduling new work
   and cleans up the job's temp directory.

## Example ZIP structure

```
froze-example.com.zip
└── example.com/
    ├── README.txt              ← how to run it locally + limitations
    ├── serve.py                ← python3 serve.py [port]
    ├── package.json            ← npx serve fallback
    ├── index.html              ← the entry page
    ├── favicon.ico
    ├── about/
    │   └── index.html          ← /about  →  /about/index.html
    ├── css/
    │   └── app.css
    ├── js/
    │   └── main.js
    ├── images/
    │   └── logo.png
    └── _external/
        └── fonts.googleapis.com/
            └── css2__qA1b2c3   ← external asset (only if "include external assets" is on)
```

Directory-style URLs (`/about`, `/`) become `<path>/index.html` so static
file servers report the correct `text/html` MIME type. Pages with query
strings get a short content hash appended to their filename so
`?page=1` and `?page=2` don't collide.

## Advanced options (UI)

| Option | Default | Notes |
|---|---|---|
| Max depth | 4 | Link-hops from the start page (hard cap: 10) |
| Max pages | 300 | Hard cap: 1000 |
| Max total size | 400 MB | Hard cap: 1000 MB; crawl stops once exceeded |
| Concurrent requests | 6 | Hard cap: 16 |
| Delay between requests | 150 ms | Politeness delay |
| Include external assets | off | Download CSS/JS/images from other domains (e.g. CDNs) |
| Follow robots.txt | on | Recommended; turning off is on you |
| Render JavaScript | off | Loads each page in headless Chromium instead of a raw HTTP request — see below |
| User-Agent | Chrome | Chrome / Firefox / Safari / a self-identifying bot UA |

## JavaScript rendering mode

By default Froze is a plain HTTP + HTML/CSS crawler — fast, but it only
sees what the server actually sends. Many modern sites (React/Vue/Next SPAs)
ship an near-empty HTML shell and build the real page with JavaScript after
load; those pages mirror as blank or broken without rendering.

**Render JavaScript** is on by default. The crawler loads each page in a real
headless Chromium (via Playwright): it waits for the page to finish loading and
network activity to settle, then captures the fully-rendered DOM as that page's
HTML before running it through the normal asset-download/rewrite pipeline. This
also captures CSS-in-JS frameworks' injected `<style>` tags directly, since
they're serialized straight into the DOM. It's heavier per page than a plain
HTTP request (a full browser instance), so concurrency is automatically capped
lower (max 3) when it's on.

**Keeping it interactive (record & replay)** — also on by default, under
render mode. A client-rendered app (React/Vue/Next/etc.) is a problem to
archive: if you just save its HTML, opening the mirror re-runs the app's
JavaScript, which re-mounts with an *empty* state (wiping the captured
content) and re-fetches its data live from the origin's API — which fails
offline, leaving a blank page. To solve this, while rendering, Froze
**records every data response the page fetches** (the JSON/XHR APIs it calls)
and **every image/media file it loads**. It saves those recordings into the
page and injects a small shim that runs before the site's own scripts,
patching `fetch`/`XMLHttpRequest` to serve the recorded data and redirecting
runtime-built image URLs to the local copies. The result: the site's *real*
JavaScript runs offline against its *real* data, so tabs, filters, and other
client-side interactions keep working in the mirror. This is the same idea
behind Webrecorder/ArchiveBox's high-fidelity captures.

- **What works:** the fully-rendered default state of every page, plus
  client-side interactions whose data was already loaded at capture time
  (e.g. switching a "Meals / Breakfast / Add-ons" tab, a "Balanced / Lean"
  toggle, in-page filters).
- **What doesn't:** interactions that would fetch data or images *not*
  loaded during the capture (e.g. a tab whose images only download when you
  first click it) won't have those specific assets offline — the text/data
  still switches correctly, and the missing images load if you're online.
  Also, anything requiring a live server (login, checkout, search) can't work
  in a static mirror.

If an interactive page misbehaves under replay, turn off **Keep interactive**
to fall back to a frozen static snapshot instead: the site's executable
scripts are removed so the rendered DOM can't be wiped, guaranteeing the
captured content shows (but nothing is clickable). Inert data scripts like
JSON-LD are kept.

Before capturing, render mode also makes several passes trying to click
through cookie-consent banners and common "close"/"no thanks"-style
promotional popups, so a popup that happened to be open at capture time
doesn't get baked into the archive.

**What it doesn't do:** it captures one rendered snapshot of each page — it
does not click tabs, filters, "load more" buttons, or otherwise interact
with the page. A page whose content changes based on a UI toggle (e.g. a
"Balanced" vs "Lean" meal-plan switch) will be archived showing whichever
state renders by default; the other states aren't crawled. It also won't
trigger scroll-based lazy-loading — though the crawler separately picks up
the common `data-src`/`data-srcset` lazy-load attributes used by libraries
like lazysizes, regardless of this setting.

## Known limitations

- **JavaScript rendering is opt-in and single-snapshot.** See the section
  above — with it off, JS-built content isn't captured at all; with it on,
  only the page's default rendered state is captured, not every
  tab/filter/interaction combination.
- **Cookie-consent banners are stripped from the saved HTML** (see "How it
  works" above), but a live, un-mirrored tag-management script (e.g. Google
  Tag Manager) can still dynamically re-inject a CMP's script at runtime if
  the mirror is opened with an internet connection, since its configuration
  is fetched live from the vendor's servers and is outside the crawler's
  visibility. In practice this has been inert in testing, and it never
  happens at all with no internet connection, but it isn't something a
  static-file crawler can categorically prevent.
- **Third-party marketing popups** (email-capture offers, A/B-tested promos
  from tools like Klaviyo or Convert) are a much larger, less standardized
  category than cookie-consent platforms, so they aren't stripped by vendor
  the way CMPs are. In render mode, the crawler makes several delayed
  passes trying to click through anything matching common dismiss labels
  ("close", "no thanks", "×", etc.) before capturing the page, which
  resolves this in most cases — but if one of these popups is mid-open at
  the exact moment of capture and doesn't match those patterns, it can end
  up stuck open with non-functional buttons in the archive, since its
  underlying JS usually lives on a third-party domain not mirrored by
  default. Re-running the crawl, or enabling "include external assets" so
  that widget's own script gets mirrored too, are the practical workarounds.
- **Login-walled / paywalled content** cannot be archived — the crawler
  never authenticates.
- **Aggressive anti-bot protection** (Cloudflare challenges, CAPTCHAs, strict
  rate limiting) will cause fetches to fail; those resources are skipped and
  reported, not silently dropped.
- **Server-side functionality** — search, forms, checkout, comments, live
  data — cannot be mirrored; only what is delivered as static HTML/CSS/JS
  is archived.
- **JS string rewriting is best-effort.** Absolute URLs baked into JavaScript
  as string literals are replaced only when they exactly match a URL that
  was actually mirrored; URLs built dynamically at runtime (string
  concatenation, template literals with variables) won't be caught.
- **Large/highly dynamic sites** may be only partially archived if they hit
  the configured page/depth/size limits — increase them if you know the
  site is bigger, mindful of the hard ceilings above.

## Legal / responsible use

This tool is for **personal archival, backup, and research use**. You are
responsible for complying with the target site's copyright and terms of
service, and for respecting `robots.txt` (on by default for this reason).

## Project structure

```
.
├── server/                  Express API + crawler
│   └── src/
│       ├── crawler/         Crawler.js, urlUtils.js, cssUtils.js, robots.js
│       ├── jobs/            JobManager.js — job lifecycle, SSE, TTL cleanup
│       ├── zip/             zipper.js — README/serve.py generation + zip
│       └── index.js         Express routes
├── client/                  React + Vite + Tailwind frontend
│   └── src/
│       ├── components/      AdvancedOptions, ProgressPanel, ResultPanel, ThemeToggle
│       ├── api.js           fetch/SSE helpers
│       └── App.jsx
├── Dockerfile                Multi-stage build: client → static assets served by the API
└── docker-compose.yml
```
