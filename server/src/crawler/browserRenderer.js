import { chromium } from "playwright";

export async function launchBrowser() {
  return chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

export async function newRenderContext(browser, userAgent) {
  return browser.newContext({ userAgent, ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
}

// "Accept" buttons for the most common cookie-consent platforms. Dismissing
// the banner properly (rather than leaving it open) matters for a mirror:
// its styling frequently lives on a third-party CDN we don't download by
// default, so a captured-open banner renders as an unstyled wall of text
// that blocks the real page underneath.
const CONSENT_ACCEPT_SELECTORS = [
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
  "#CybotCookiebotDialogBodyButtonAccept",
  "#onetrust-accept-btn-handler", // OneTrust
  "#didomi-notice-agree-button", // Didomi
  ".osano-cm-accept-all", // Osano
  "button[data-testid='uc-accept-all-button']", // Usercentrics
  "#usercentrics-root button[data-testid='uc-accept-all-button']",
  ".qc-cmp2-summary-buttons button[mode='primary']", // Quantcast/IAB TCF
];

// Root containers to strip if a banner is still present after the click
// attempts (unrecognized CMP, or the click didn't fully dismiss it) — a
// static mirror can't submit real consent anyway, so leaving it visible only
// obscures the actual page.
const CONSENT_CONTAINER_SELECTORS = [
  "#CybotCookiebotDialog",
  "#onetrust-consent-sdk",
  "#didomi-host",
  ".osano-cm-window",
  "#usercentrics-root",
  ".qc-cmp2-container",
  "[id*='cookie-consent' i]",
  "[class*='cookie-consent' i]",
  "[id*='cookie-banner' i]",
  "[class*='cookie-banner' i]",
];

// Beyond cookie-consent, many sites run a promotional popup (email capture,
// discount offer, "wait — before you go") from a third-party marketing/A-B
// testing platform (Klaviyo, Convert, OptinMonster, Privy, …). There are far
// too many such platforms to enumerate by vendor selector, so this is a
// generic text/label match instead — deliberately limited to unambiguous
// dismiss affordances so it never fires on a real page action.
const GENERIC_DISMISS_TEXT = /^(accept all|allow all|i agree|agree|accept cookies|got it|no,? thanks|close|maybe later|not now|skip|dismiss|continue without|no thank you|not interested)$/i;

async function clickOneDismissTarget(page) {
  for (const sel of CONSENT_ACCEPT_SELECTORS) {
    const clicked = await page
      .click(sel, { timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return true;
  }
  return page
    .evaluate((textPattern) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const re = new RegExp(textPattern.source, textPattern.flags);
      const candidates = Array.from(document.querySelectorAll("button, a[role='button'], [role='button'], [class*='close' i]"));
      const match = candidates.find((el) => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || "").trim();
        const aria = el.getAttribute("aria-label") || "";
        return re.test(text) || /close/i.test(aria);
      });
      if (!match) return false;
      match.click();
      return true;
    }, GENERIC_DISMISS_TEXT)
    .catch(() => false);
}

/**
 * Best-effort dismissal of cookie-consent banners and promotional
 * popups/overlays before the page is captured. Marketing popups are often
 * time-delayed (appearing a few seconds after load), so this runs several
 * passes rather than a single check.
 */
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await clickOneDismissTarget(page);
    await page.waitForTimeout(clicked ? 500 : 1500);
    if (!clicked && attempt > 0) break;
  }

  // Belt-and-suspenders: remove whatever cookie-consent container is still
  // standing (unrecognized CMP, or the click didn't fully dismiss it) — a
  // static mirror can't submit real consent anyway, so leaving it visible
  // only obscures the real page. Deliberately scoped to consent platforms
  // only, not generic popups, which are too varied to safely auto-remove.
  await page
    .evaluate((selectors) => {
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }, CONSENT_CONTAINER_SELECTORS)
    .catch(() => {});
}

// Once the page is fully rendered and captured, the site's own executable
// JavaScript is not just unnecessary — it's actively destructive to the
// archive. A client-rendered app (React/Vue/etc.) that re-runs from the saved
// HTML will re-mount with an EMPTY client state, wiping the content we just
// captured out of the DOM, then try to re-fetch it live from the origin's API
// — which fails cross-origin from localhost, leaving a blank page. So for a
// faithful static snapshot we freeze the rendered DOM by removing executable
// scripts. Non-executing data scripts (JSON-LD, etc.) are kept since they're
// inert and sometimes carry useful metadata. This is the same approach
// dedicated page-archivers (SingleFile, ArchiveBox) take. The trade-off is
// that client-side interactivity (JS-driven tab switches, etc.) stops working
// — but render mode was always a single-snapshot capture, not a live app.
async function freezeRenderedDom(page) {
  await page
    .evaluate(() => {
      const EXECUTABLE = new Set(["", "text/javascript", "application/javascript", "module", "text/babel", "text/jsx"]);
      document.querySelectorAll("script").forEach((s) => {
        const type = (s.getAttribute("type") || "").trim().toLowerCase();
        if (EXECUTABLE.has(type)) s.remove();
      });
      // Common SPA mount roots sometimes get emptied by a teardown handler
      // before removal takes effect; nothing else to do here, but leaving the
      // captured markup intact is the whole point.
    })
    .catch(() => {});
}

const MAX_RECORD_BYTES = 16 * 1024 * 1024; // per-page cap on recorded API data

// Records the data responses (XHR/fetch returning JSON/text) the page fetches
// while rendering. These are replayed offline by an injected shim so the
// site's own JavaScript can run against them — restoring client-side
// interactivity (tab switches, filters, etc.) that a static snapshot loses.
// Keyed by pathname+search because our URL-rewrite pass strips the origin from
// the app's JS, so offline it requests same-origin relative paths.
function attachRecorder(page) {
  const recordings = [];
  const seen = new Set();
  let bytes = 0;

  page.on("response", async (response) => {
    try {
      const req = response.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;
      if (req.method() !== "GET") return; // POST replay matching is unreliable
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      if (!/json|text|javascript|xml/.test(ct)) return;

      const u = new URL(response.url());
      const key = u.pathname + u.search;
      if (seen.has(key)) return;

      const buf = await response.body().catch(() => null);
      if (!buf || bytes + buf.length > MAX_RECORD_BYTES) return;

      seen.add(key);
      bytes += buf.length;
      recordings.push({
        key,
        pathname: u.pathname,
        status: response.status(),
        contentType: response.headers()["content-type"] || "application/octet-stream",
        bodyBase64: buf.toString("base64"),
      });
    } catch {
      /* non-capturable response (redirect, 204, already consumed) — skip */
    }
  });

  return recordings;
}

// Collects the URLs of image/media/font resources the browser actually loaded
// while rendering — regardless of origin. A rendered SPA often builds image
// URLs at runtime (from media IDs, on an external CDN), so they can't be found
// by parsing the static HTML or the JSON; the only reliable source is what the
// real browser fetched. We download these and redirect them to local copies.
function attachMediaCollector(page) {
  const urls = new Set();
  page.on("response", (response) => {
    try {
      const rt = response.request().resourceType();
      if (rt !== "image" && rt !== "media" && rt !== "font") return;
      if (response.status() >= 400) return;
      urls.add(response.url());
    } catch {
      /* ignore */
    }
  });
  return urls;
}

/**
 * Loads `url` in a real browser and returns the fully rendered DOM as HTML —
 * captures content that JavaScript injects after the initial page load
 * (SPA data fetches, CSS-in-JS <style> tags, etc.).
 *
 * Two modes:
 * - replay off (default static snapshot): the site's executable scripts are
 *   removed so the frozen DOM can't be wiped when opened offline.
 * - replay on: the site's scripts are kept, and every data response is
 *   recorded (returned as `recordings`) so an injected shim can serve them
 *   offline — letting the real app run and stay interactive.
 */
export async function renderPage(context, url, { timeoutMs = 25_000, replay = false } = {}) {
  const page = await context.newPage();
  const recordings = replay ? attachRecorder(page) : null;
  const mediaUrls = replay ? attachMediaCollector(page) : null;
  try {
    let status = 200;
    try {
      const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      status = response ? response.status() : 200;
    } catch (err) {
      throw new Error(`navigation failed: ${err.message}`);
    }
    // "load" fires early on JS-heavy sites; give in-flight XHR/fetch calls a
    // chance to settle, but don't hang forever on pages with polling/websockets.
    // Some sites fire a long chain of *sequential* API calls before the real
    // content renders (settings -> data -> pricing -> content, etc.), which
    // can run past a short timeout under concurrent render load — 8s was
    // occasionally not enough when several pages render at once.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await dismissOverlays(page);
    if (!replay) await freezeRenderedDom(page);
    const html = await page.content();
    return {
      html,
      finalUrl: page.url(),
      status,
      recordings: recordings || [],
      mediaUrls: mediaUrls ? [...mediaUrls] : [],
    };
  } finally {
    await page.close();
  }
}
