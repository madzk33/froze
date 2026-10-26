const URL_FN_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/gi;

/** Extracts every URL referenced by url(...) and @import in a CSS string. */
export function extractCssUrls(css) {
  const found = new Set();
  let m;
  URL_FN_RE.lastIndex = 0;
  while ((m = URL_FN_RE.exec(css))) {
    if (m[2] && !m[2].startsWith("data:")) found.add(m[2]);
  }
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(css))) {
    const ref = m[1] || m[2];
    if (ref && !ref.startsWith("data:")) found.add(ref);
  }
  return [...found];
}

/** Replaces every URL reference in CSS using `resolveToLocal(originalRef) -> newRef|null`. */
export function rewriteCssUrls(css, resolveToLocal) {
  let out = css.replace(URL_FN_RE, (whole, quote, ref) => {
    if (ref.startsWith("data:")) return whole;
    const replacement = resolveToLocal(ref);
    if (!replacement) return whole;
    return `url(${quote || '"'}${replacement}${quote || '"'})`;
  });
  out = out.replace(IMPORT_RE, (whole, url1, url2) => {
    const ref = url1 || url2;
    if (!ref || ref.startsWith("data:")) return whole;
    const replacement = resolveToLocal(ref);
    if (!replacement) return whole;
    return url1 ? `@import url("${replacement}")` : `@import "${replacement}"`;
  });
  return out;
}

/** Parses an <img srcset> / <source srcset> value into [{url, descriptor}]. */
export function parseSrcset(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const spaceIdx = part.search(/\s/);
      if (spaceIdx === -1) return { url: part, descriptor: "" };
      return { url: part.slice(0, spaceIdx), descriptor: part.slice(spaceIdx).trim() };
    });
}

export function buildSrcset(entries) {
  return entries.map((e) => (e.descriptor ? `${e.url} ${e.descriptor}` : e.url)).join(", ");
}
