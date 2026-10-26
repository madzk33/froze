import path from "node:path";

// Query params that don't change page content (tracking / session junk) — stripping
// these prevents the crawler from treating the same page as infinitely many URLs.
const IGNORED_PARAM_PATTERNS = [
  /^utm_/i,
  /^jsessionid$/i,
  /^phpsessid$/i,
  /^sid$/i,
  /^session(id)?$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^ref$/i,
  /^_ga$/i,
];

export function isIgnoredParam(key) {
  return IGNORED_PARAM_PATTERNS.some((re) => re.test(key));
}

/**
 * Normalizes a URL for dedup purposes: strips fragment + tracking params,
 * sorts remaining params, lowercases host, drops default ports & trailing
 * "index.html".
 */
export function normalizeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  const params = [...u.searchParams.entries()].filter(([k]) => !isIgnoredParam(k));
  params.sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);

  if (u.pathname.endsWith("/index.html")) {
    u.pathname = u.pathname.slice(0, -"index.html".length);
  }
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    // keep trailing slash — it's meaningful (directory vs file)
  }

  return u.toString();
}

export function resolveUrl(base, maybeRelative) {
  if (!maybeRelative) return null;
  const trimmed = maybeRelative.trim();
  if (!trimmed) return null;
  if (/^(data|blob|javascript|mailto|tel|about|ws|wss):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function sanitizeSegment(segment) {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();
  return decoded.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\.\.+/g, "_").slice(0, 120) || "_";
}

/**
 * Maps a remote URL to a path inside the mirror output directory.
 * `kind` is "page" or "asset" and only affects extension inference for
 * extension-less paths (pages become <path>/index.html).
 */
export function urlToLocalPath({ url, isSameOrigin, siteHost, fallbackExt, kind }) {
  const u = new URL(url);
  const segments = u.pathname.split("/").filter(Boolean).map(sanitizeSegment);

  let ext = path.extname(segments[segments.length - 1] || "");
  let relDir = segments.slice(0, -1);
  let fileName = segments[segments.length - 1];

  const isHtmlExt = ext.toLowerCase() === ".html" || ext.toLowerCase() === ".htm";
  if (!fileName || (kind === "page" && !isHtmlExt)) {
    // directory-style (or non-.html) URL -> index.html inside it, so static
    // servers report the correct text/html MIME type when serving offline.
    relDir = segments;
    fileName = "index.html";
    ext = ".html";
  } else if (!ext && fallbackExt) {
    fileName = `${fileName}${fallbackExt}`;
  }

  // Disambiguate query-string variants of the same path so they don't clobber each other.
  const search = [...u.searchParams.entries()];
  if (search.length) {
    const qHash = simpleHash(u.search);
    const dot = fileName.lastIndexOf(".");
    fileName = dot > 0 ? `${fileName.slice(0, dot)}__q${qHash}${fileName.slice(dot)}` : `${fileName}__q${qHash}`;
  }

  const prefix = isSameOrigin ? [] : ["_external", sanitizeSegment(u.hostname)];
  const parts = [...prefix, ...relDir, fileName];
  return parts.join("/");
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 6);
}

export function toRootRelative(localPath) {
  return "/" + localPath.replace(/^\/+/, "");
}

export function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname.toLowerCase() === ub.hostname.toLowerCase();
  } catch {
    return false;
  }
}
