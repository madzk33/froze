import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { extension as extFromMime } from "mime-types";
import { fetchRobots, isAllowed } from "./robots.js";
import {
  normalizeUrl,
  resolveUrl,
  urlToLocalPath,
  toRootRelative,
  sameOrigin,
} from "./urlUtils.js";
import { extractCssUrls, rewriteCssUrls, parseSrcset, buildSrcset } from "./cssUtils.js";
import { launchBrowser, newRenderContext, renderPage } from "./browserRenderer.js";
import { buildReplayShim } from "./replayShim.js";

const PAGE_LINK_SELECTORS = "a[href], area[href]";
const ASSET_ATTR_SELECTORS = [
  { sel: "link[rel~='stylesheet']", attr: "href", type: "css" },
  { sel: "link[rel~='icon']", attr: "href", type: "img" },
  { sel: "link[rel='manifest']", attr: "href", type: "manifest" },
  { sel: "link[rel='preload'][as='font']", attr: "href", type: "font" },
  { sel: "link[rel='preload'][as='style']", attr: "href", type: "css" },
  { sel: "link[rel='preload'][as='script']", attr: "href", type: "js" },
  { sel: "link[rel='apple-touch-icon']", attr: "href", type: "img" },
  { sel: "script[src]", attr: "src", type: "js" },
  { sel: "img[src]", attr: "src", type: "img" },
  // data-src / data-lazy-src: the near-universal lazysizes/lozad.js pattern for
  // below-the-fold images that only get a real `src` once JS runs on scroll.
  { sel: "img[data-src]", attr: "data-src", type: "img" },
  { sel: "img[data-lazy-src]", attr: "data-lazy-src", type: "img" },
  { sel: "source[src]", attr: "src", type: "media" },
  { sel: "video[src]", attr: "src", type: "media" },
  { sel: "audio[src]", attr: "src", type: "media" },
  { sel: "video[poster]", attr: "poster", type: "img" },
  { sel: "embed[src]", attr: "src", type: "media" },
  { sel: "iframe[src]", attr: "src", type: "page-embed" },
];
const SRCSET_ATTRS = ["srcset", "data-srcset"];
const EXT_BY_TYPE = { css: ".css", js: ".js", img: ".bin", font: ".woff", media: ".bin", manifest: ".json" };

// Cookie-consent platforms load their loader <script> from a fixed external
// domain and re-inject their banner at runtime whenever that script runs —
// so even after removing the banner's markup, leaving the script tag in
// place means it comes right back the moment the mirror is opened with a
// live internet connection. Stripping the script itself is the permanent
// fix; the container selectors are a fallback for markup rendered
// server-side (no JS execution involved) that the script tag pattern misses.
const CONSENT_SCRIPT_SRC_PATTERNS = [
  /cookiebot\.com/i,
  /cookielaw\.org/i, // OneTrust
  /onetrust\.com/i,
  /usercentrics\.eu/i,
  /consent\.usercentrics/i,
  /didomi\.io/i,
  /osano\.com/i,
  /quantcast\.mgr\.consensu\.org/i,
  /trustarc\.com/i,
  /iubenda\.com\/cs/i,
  /termly\.io/i,
];
// Vendor-keyword substring matches rather than exact IDs — CMP vendors add
// secondary widgets (e.g. Cookiebot's small persistent "reopen settings"
// icon, its offscreen helper iframes) beyond just the main dialog, and all
// of them consistently share the vendor name in their id/class.
const CONSENT_VENDOR_KEYWORDS = [
  "cookiebot",
  "onetrust",
  "didomi",
  "osano",
  "usercentrics",
  "qc-cmp",
  "cookie-consent",
  "cookie-banner",
];
const CONSENT_CONTAINER_SELECTORS = CONSENT_VENDOR_KEYWORDS.flatMap((kw) => [
  `[id*='${kw}' i]`,
  `[class*='${kw}' i]`,
]);

function stripConsentArtifacts($) {
  $("script[src], iframe[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (CONSENT_SCRIPT_SRC_PATTERNS.some((re) => re.test(src))) $(el).remove();
  });
  for (const sel of CONSENT_CONTAINER_SELECTORS) {
    $(sel).remove();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Crawler {
  constructor({
    startUrl,
    outDir,
    maxDepth = 4,
    maxPages = 300,
    maxTotalSizeMB = 400,
    includeExternalAssets = false,
    respectRobots = true,
    userAgent = "SiteMirrorBot/1.0 (+offline-archiver)",
    concurrency = 6,
    delayMs = 150,
    renderJs = false,
    replayJs = true,
    onProgress = () => {},
    control = { cancelled: false },
  }) {
    this.startUrl = startUrl;
    this.outDir = outDir;
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
    this.maxTotalBytes = maxTotalSizeMB * 1024 * 1024;
    this.includeExternalAssets = includeExternalAssets;
    this.respectRobots = respectRobots;
    this.userAgent = userAgent;
    this.renderJs = Boolean(renderJs);
    // Replay keeps the site's JS and serves its data from recordings so the
    // mirror stays interactive offline. Only meaningful alongside renderJs.
    this.replayJs = this.renderJs && replayJs !== false;
    // Headless-browser pages are far heavier than plain HTTP requests — cap
    // concurrency so a rendering crawl doesn't exhaust memory/CPU. Capped
    // lower than you might expect: sites that build their content from a
    // chain of several sequential API calls (common on SPAs) need each
    // concurrent Chromium page to get enough real CPU time for that chain to
    // finish before the capture timeout — too much parallelism starves them
    // and produces pages with missing content, not just a slower crawl.
    this.concurrency = Math.max(1, Math.min(this.renderJs ? 3 : 20, concurrency));
    this.delayMs = delayMs;
    this.onProgress = onProgress;
    this.control = control;
    this.browserContext = null;

    this.siteOrigin = new URL(startUrl).origin;
    this.resources = new Map(); // normalizedUrl -> resource record
    this.visited = new Set();
    this.pathVariantCounts = new Map();
    this.queue = [];
    this.inFlight = 0;
    this.pagesCrawled = 0;
    this.assetsDownloaded = 0;
    this.failedCount = 0;
    this.totalBytes = 0;
    this.startedAt = Date.now();
    this.currentUrl = null;
    this.errors = [];
    this.pageOrder = [];
  }

  _emit(extra = {}) {
    const processed = this.pagesCrawled + this.assetsDownloaded;
    const denom = processed + this.queue.length + this.inFlight;
    const percent = denom > 0 ? Math.min(99, Math.round((processed / denom) * 100)) : 0;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = elapsed > 0 ? processed / elapsed : 0;
    const remaining = this.queue.length + this.inFlight;
    const etaSeconds = rate > 0 ? Math.round(remaining / rate) : null;

    this.onProgress({
      phase: "crawling",
      pagesCrawled: this.pagesCrawled,
      assetsDownloaded: this.assetsDownloaded,
      queued: this.queue.length,
      currentUrl: this.currentUrl,
      totalBytes: this.totalBytes,
      percent,
      etaSeconds,
      failed: this.failedCount,
      recentPages: this.pageOrder.slice(-5).map((p) => p.url),
      ...extra,
    });
  }

  _isCancelled() {
    return this.control.cancelled;
  }

  _budgetExceeded() {
    return this.totalBytes >= this.maxTotalBytes;
  }

  _shouldSkipPathVariant(u) {
    const key = u.origin + u.pathname;
    const count = this.pathVariantCounts.get(key) || 0;
    if (count >= 15) return true;
    this.pathVariantCounts.set(key, count + 1);
    return false;
  }

  _enqueue(item) {
    const norm = normalizeUrl(item.url);
    if (!norm) return;
    if (this.visited.has(norm)) return;
    if (item.kind === "page" && this.pagesCrawled + this.queue.filter((q) => q.kind === "page").length >= this.maxPages) {
      return;
    }
    this.visited.add(norm);
    this.queue.push({ ...item, normalizedUrl: norm });
  }

  async run() {
    await fs.mkdir(this.outDir, { recursive: true });
    this.robots = this.respectRobots ? await fetchRobots(this.startUrl, this.userAgent) : null;

    let browser = null;
    if (this.renderJs) {
      this._emit({ phase: "crawling", currentUrl: "Starting headless browser…" });
      browser = await launchBrowser();
      this.browserContext = await newRenderContext(browser, this.userAgent);
    }

    try {
      this._enqueue({ url: this.startUrl, kind: "page", depth: 0 });
      // Always try the favicon, even if no <link rel=icon> is present.
      this._enqueue({ url: new URL("/favicon.ico", this.startUrl).toString(), kind: "asset", assetType: "img", depth: 0, optional: true });

      await this._drain();
    } finally {
      if (browser) await browser.close().catch(() => {});
      this.browserContext = null;
    }

    if (this._isCancelled()) {
      return { cancelled: true };
    }

    this._emit({ phase: "rewriting" });
    this._rewriteAll();

    this._emit({ phase: "writing" });
    await this._flushToDisk();

    const entry = this.resources.get(normalizeUrl(this.startUrl));
    return {
      cancelled: false,
      outDir: this.outDir,
      pageCount: this.pagesCrawled,
      assetCount: this.assetsDownloaded,
      failedCount: this.failedCount,
      totalBytes: this.totalBytes,
      entryLocalPath: entry ? entry.localPath : "/index.html",
      pages: this.pageOrder,
      errors: this.errors.slice(0, 50),
    };
  }

  async _drain() {
    while (!this._isCancelled()) {
      if (this.queue.length === 0 && this.inFlight === 0) break;
      if (this._budgetExceeded() && this.inFlight === 0) break;

      while (this.inFlight < this.concurrency && this.queue.length > 0 && !this._budgetExceeded()) {
        const item = this.queue.shift();
        this.inFlight++;
        this._processItem(item)
          .catch((err) => {
            this.failedCount++;
            this.errors.push(`${item.url}: ${err.message || err}`);
          })
          .finally(() => {
            this.inFlight--;
          });
        if (this.delayMs > 0) await sleep(this.delayMs / this.concurrency);
      }
      this._emit();
      await sleep(80);
    }
    this._emit(this._isCancelled() ? { phase: "cancelled" } : {});
  }

  async _processItem(item) {
    if (this._isCancelled()) return;
    this.currentUrl = item.url;

    const originOk = this.includeExternalAssets || item.force || sameOrigin(item.url, this.startUrl);
    if (!originOk && item.kind === "asset") return;
    if (item.kind === "page" && !sameOrigin(item.url, this.startUrl)) return; // never crawl external pages

    if (this.robots && !isAllowed(this.robots, item.url, this.userAgent, this.respectRobots)) {
      return;
    }

    let finalUrl, contentType, buffer, pageRecordings = null;

    if (item.kind === "page" && this.renderJs && this.browserContext) {
      let rendered;
      try {
        rendered = await renderPage(this.browserContext, item.url, { timeoutMs: 25_000, replay: this.replayJs });
      } catch (err) {
        if (item.optional) return;
        throw new Error(`render failed: ${err.message}`);
      }
      if (rendered.status >= 400) {
        if (item.optional) return;
        throw new Error(`HTTP ${rendered.status}`);
      }
      finalUrl = rendered.finalUrl;
      contentType = "text/html";
      buffer = Buffer.from(rendered.html, "utf8");
      pageRecordings = rendered.recordings;
      // Download every image/media/font the browser actually loaded, any
      // origin — a rendered SPA builds these URLs at runtime so they can't be
      // found statically. force bypasses the external-asset gate since these
      // are real page content.
      for (const u of rendered.mediaUrls || []) {
        this._enqueue({ url: u, kind: "asset", assetType: "img", depth: 0, force: true });
      }
    } else {
      let res;
      try {
        res = await fetch(item.url, {
          headers: { "User-Agent": this.userAgent, Accept: "*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (item.optional) return;
        throw new Error(`fetch failed: ${err.message}`);
      }

      if (!res.ok) {
        if (item.optional) return;
        throw new Error(`HTTP ${res.status}`);
      }

      finalUrl = res.url || item.url;
      contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
      buffer = Buffer.from(await res.arrayBuffer());
    }
    this.totalBytes += buffer.length;

    const isHtml = item.kind === "page" || contentType.includes("text/html");
    const isCss = contentType.includes("text/css") || item.assetType === "css";
    const isJs = contentType.includes("javascript") || item.assetType === "js";
    const isManifest = item.assetType === "manifest" || contentType.includes("application/manifest+json");

    const fallbackExt = contentType && !isHtml ? `.${extFromMime(contentType) || EXT_BY_TYPE[item.assetType] || "bin"}` : undefined;
    const localPath = urlToLocalPath({
      url: finalUrl,
      isSameOrigin: sameOrigin(finalUrl, this.startUrl),
      fallbackExt,
      kind: isHtml ? "page" : "asset",
    });

    const record = {
      url: item.url,
      finalUrl,
      normalizedUrl: item.normalizedUrl || normalizeUrl(finalUrl),
      localPath: toRootRelative(localPath),
      diskPath: path.join(this.outDir, localPath),
      kind: item.kind,
      contentType,
      isHtml,
      isCss,
      isJs,
      isManifest,
      buffer,
      recordings: pageRecordings,
    };
    this.resources.set(record.normalizedUrl, record);
    const finalNorm = normalizeUrl(finalUrl);
    if (finalNorm && finalNorm !== record.normalizedUrl) this.resources.set(finalNorm, record);

    if (item.kind === "page") {
      this.pagesCrawled++;
      this.pageOrder.push({ url: finalUrl, localPath: record.localPath });
      if (isHtml) this._extractFromHtml(record, buffer.toString("utf8"), item.depth ?? 0);
      // Recorded API responses (for replay) reference images/media that only
      // appear when the user later interacts (other tabs, filters). Pull those
      // asset URLs out of the recorded data and download them too — even if
      // they're on an external CDN — so interactive states aren't image-less
      // offline.
      if (pageRecordings && pageRecordings.length) this._harvestRecordingAssets(pageRecordings);
    } else {
      this.assetsDownloaded++;
      if (isCss) this._extractFromCss(record, buffer.toString("utf8"));
      if (isManifest) this._extractFromManifest(record, buffer.toString("utf8"));
      if (isHtml && item.assetType === "page-embed") {
        // An <iframe> pulled in as an asset is still a full document —
        // fetch its own assets too, or it'll render broken offline.
        this._extractFromHtml(record, buffer.toString("utf8"), item.depth ?? 0);
      }
    }

    this._emit();
  }

  _extractFromHtml(record, html, depth) {
    let $;
    try {
      $ = cheerio.load(html);
    } catch {
      return;
    }
    const baseHref = $("base[href]").first().attr("href");
    const base = baseHref ? resolveUrl(record.finalUrl, baseHref) || record.finalUrl : record.finalUrl;

    if (depth < this.maxDepth) {
      $(PAGE_LINK_SELECTORS).each((_, el) => {
        const href = $(el).attr("href");
        const abs = resolveUrl(base, href);
        if (!abs) return;
        if (!sameOrigin(abs, this.startUrl)) return;
        const u = new URL(abs);
        if (this._shouldSkipPathVariant(u)) return;
        this._enqueue({ url: abs, kind: "page", depth: depth + 1 });
      });
    }

    for (const { sel, attr, type } of ASSET_ATTR_SELECTORS) {
      $(sel).each((_, el) => {
        const val = $(el).attr(attr);
        const abs = resolveUrl(base, val);
        if (!abs) return;
        if (type === "page-embed") {
          if (sameOrigin(abs, this.startUrl)) this._enqueue({ url: abs, kind: "asset", assetType: "page-embed", depth });
          return;
        }
        this._enqueue({ url: abs, kind: "asset", assetType: type, depth });
      });
    }

    $("img, source").each((_, el) => {
      for (const attr of SRCSET_ATTRS) {
        const raw = $(el).attr(attr);
        if (!raw) continue;
        for (const e of parseSrcset(raw)) {
          const abs = resolveUrl(base, e.url);
          if (abs) this._enqueue({ url: abs, kind: "asset", assetType: "img", depth });
        }
      }
    });

    // Inline <style> blocks may reference url(...) assets too.
    $("style").each((_, el) => {
      const css = $(el).html() || "";
      for (const ref of extractCssUrls(css)) {
        const abs = resolveUrl(base, ref);
        if (abs) this._enqueue({ url: abs, kind: "asset", assetType: "img", depth });
      }
    });
  }

  _extractFromCss(record, css) {
    for (const ref of extractCssUrls(css)) {
      const abs = resolveUrl(record.finalUrl, ref);
      if (abs) this._enqueue({ url: abs, kind: "asset", assetType: "css-ref", depth: 0 });
    }
  }

  _extractFromManifest(record, jsonText) {
    try {
      const data = JSON.parse(jsonText);
      const icons = Array.isArray(data.icons) ? data.icons : [];
      for (const icon of icons) {
        if (!icon?.src) continue;
        const abs = resolveUrl(record.finalUrl, icon.src);
        if (abs) this._enqueue({ url: abs, kind: "asset", assetType: "img", depth: 0 });
      }
    } catch {
      /* not valid JSON manifest — ignore */
    }
  }

  // Matches absolute http(s) URLs to media assets embedded in recorded JSON.
  // The character class allows backslashes and the scheme allows `\/` because
  // many APIs serialize JSON with escaped forward slashes (https:\/\/host\/…);
  // without this the URL would be truncated at the first backslash.
  static RECORDING_ASSET_RE = /https?:(?:\\?\/){2}[^"'\s<>)]+?\.(?:jpg|jpeg|png|webp|avif|gif|svg|ico|mp4|webm|woff2?|ttf|otf)(?:\?[^"'\s<>)]*)?/gi;

  // Collapses JSON escaping (`\/` -> `/`) so a matched URL can be parsed/looked up.
  static _canonUrl(m) {
    return m.replace(/\\\//g, "/");
  }

  _harvestRecordingAssets(recordings) {
    for (const rec of recordings) {
      let body;
      try {
        body = Buffer.from(rec.bodyBase64, "base64").toString("utf8");
      } catch {
        continue;
      }
      const urls = body.match(Crawler.RECORDING_ASSET_RE);
      if (!urls) continue;
      for (const raw of new Set(urls)) {
        const u = Crawler._canonUrl(raw);
        // force: essential content referenced by replayed data — download it
        // even when it's on an external CDN and external assets are off.
        this._enqueue({ url: u, kind: "asset", assetType: "img", depth: 0, force: true });
      }
    }
  }

  _rewriteRecordingBody(body) {
    return body.replace(Crawler.RECORDING_ASSET_RE, (m) => {
      const norm = normalizeUrl(Crawler._canonUrl(m));
      const target = norm && this.resources.get(norm);
      if (!target) return m;
      // Preserve the original slash-escaping style so the surrounding JSON
      // string stays valid when the app parses it.
      return m.includes("\\/") ? target.localPath.replace(/\//g, "\\/") : target.localPath;
    });
  }

  _resolveMapped(fromRecord, ref) {
    const abs = resolveUrl(fromRecord.finalUrl, ref);
    if (!abs) return null;
    const norm = normalizeUrl(abs);
    const target = norm && this.resources.get(norm);
    return target ? target.localPath : null;
  }

  _rewriteAll() {
    for (const record of new Set(this.resources.values())) {
      if (record.isHtml) this._rewriteHtml(record);
      else if (record.isCss) this._rewriteCss(record);
      else if (record.isJs) this._rewriteJs(record);
    }
  }

  _rewriteHtml(record) {
    let $;
    try {
      $ = cheerio.load(record.buffer.toString("utf8"), { decodeEntities: false });
    } catch {
      return;
    }
    const base = record.finalUrl;

    $("base").remove(); // root-relative rewriting makes <base> redundant/harmful
    stripConsentArtifacts($);

    $(PAGE_LINK_SELECTORS).each((_, el) => {
      const href = $(el).attr("href");
      const mapped = this._resolveMapped(record, href);
      if (mapped) $(el).attr("href", mapped);
    });

    for (const { sel, attr, type } of ASSET_ATTR_SELECTORS) {
      $(sel).each((_, el) => {
        const val = $(el).attr(attr);
        const mapped = this._resolveMapped(record, val);
        if (mapped) $(el).attr(attr, mapped);
        else if (type !== "page-embed") {
          const abs = resolveUrl(base, val);
          if (abs) $(el).attr(attr, abs); // keep working via the live internet as a fallback
        }
      });
    }

    $("img, source").each((_, el) => {
      for (const attr of SRCSET_ATTRS) {
        const raw = $(el).attr(attr);
        if (!raw) continue;
        const entries = parseSrcset(raw).map((e) => {
          const mapped = this._resolveMapped(record, e.url);
          return mapped ? { ...e, url: mapped } : e;
        });
        $(el).attr(attr, buildSrcset(entries));
      }
    });

    $("style").each((_, el) => {
      const css = $(el).html() || "";
      const rewritten = rewriteCssUrls(css, (ref) => this._resolveMapped(record, ref));
      $(el).html(rewritten);
    });

    $("[style]").each((_, el) => {
      const css = $(el).attr("style") || "";
      if (!css.includes("url(")) return;
      $(el).attr("style", rewriteCssUrls(css, (ref) => this._resolveMapped(record, ref)));
    });

    // Inject the network-replay shim as the very first thing in <head>, so it
    // patches fetch/XHR before any of the site's own scripts run. This lets the
    // kept application JS fetch its data from the recordings we captured,
    // keeping the mirror interactive offline.
    if (this.replayJs && record.recordings && record.recordings.length) {
      // Rewrite asset URLs inside the recorded data to the local copies we
      // downloaded, so images/media in interactive states load offline.
      const recs = record.recordings.map((r) => {
        let body;
        try {
          body = Buffer.from(r.bodyBase64, "base64").toString("utf8");
        } catch {
          return r;
        }
        const rewritten = this._rewriteRecordingBody(body);
        return { ...r, bodyBase64: Buffer.from(rewritten, "utf8").toString("base64") };
      });
      // Map of original media pathname -> local path, so a runtime rewriter in
      // the shim can redirect images the app creates at runtime (with absolute
      // CDN URLs) to the local copies we downloaded.
      const mediaMap = {};
      for (const res of this.resources.values()) {
        if (res.kind !== "asset") continue;
        if (!/^image\/|^video\/|^audio\/|^font\/|application\/font/.test(res.contentType || "")) continue;
        try {
          mediaMap[new URL(res.finalUrl).pathname] = res.localPath;
        } catch {
          /* ignore unparseable */
        }
      }
      const shim = buildReplayShim(recs, mediaMap);
      const head = $("head").first();
      if (head.length) head.prepend(`<script>${shim}</script>`);
      else $.root().prepend(`<script>${shim}</script>`);
    }

    record.buffer = Buffer.from($.html(), "utf8");
  }

  _rewriteCss(record) {
    const css = record.buffer.toString("utf8");
    const rewritten = rewriteCssUrls(css, (ref) => this._resolveMapped(record, ref));
    record.buffer = Buffer.from(rewritten, "utf8");
  }

  _rewriteJs(record) {
    // In replay mode we keep the site's JS running, and the injected shim
    // intercepts its data requests by pathname regardless of whether they use
    // absolute or relative URLs. Rewriting minified bundles (especially the
    // blunt origin-strip below) risks corrupting them — e.g. merging tokens or
    // breaking `new URL(...)` construction — so we leave app JS pristine and
    // let the shim do the work.
    if (this.replayJs) return;

    let text = record.buffer.toString("utf8");
    for (const rec of this.resources.values()) {
      if (rec === record) continue;
      if (text.includes(rec.url)) text = text.split(rec.url).join(rec.localPath);
      if (rec.finalUrl && rec.finalUrl !== rec.url && text.includes(rec.finalUrl)) {
        text = text.split(rec.finalUrl).join(rec.localPath);
      }
    }
    text = text.split(this.siteOrigin).join("");
    record.buffer = Buffer.from(text, "utf8");
  }

  async _flushToDisk() {
    const seen = new Set();
    for (const record of this.resources.values()) {
      if (seen.has(record.diskPath)) continue;
      seen.add(record.diskPath);
      await fs.mkdir(path.dirname(record.diskPath), { recursive: true });
      await fs.writeFile(record.diskPath, record.buffer);
    }
  }
}
