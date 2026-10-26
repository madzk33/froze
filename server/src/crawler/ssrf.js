import dns from "node:dns/promises";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";

// Only ordinary public unicast addresses are allowed out. Everything else —
// loopback, private RFC1918, link-local (incl. the 169.254.169.254 cloud
// metadata endpoint), unique-local v6, carrier-grade NAT, multicast, reserved,
// broadcast — is refused, because a public crawler that will fetch any URL is
// otherwise a server-side request forgery (SSRF) tool that can reach the host's
// own internal network and credential endpoints.
const ALLOWED_RANGES = new Set(["unicast"]);

export function isBlockedIp(ip) {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable → refuse
  }
  let range = addr.range();
  if (addr.kind() === "ipv6" && range === "ipv4Mapped") {
    range = addr.toIPv4Address().range();
  }
  return !ALLOWED_RANGES.has(range);
}

// Disabled entirely unless SSRF_PROTECT is on, so local/self-hosted runs can
// still mirror http://localhost test sites. Production sets SSRF_PROTECT=1.
export function ssrfEnabled() {
  return process.env.SSRF_PROTECT === "1" || process.env.NODE_ENV === "production";
}

/** Resolves a hostname and throws if any resolved address is non-public. */
export async function assertPublicHost(hostname) {
  if (!ssrfEnabled()) return;
  // A bare IP literal is checked directly.
  if (ipaddr.isValid(hostname)) {
    if (isBlockedIp(hostname)) throw new Error(`Blocked non-public address: ${hostname}`);
    return;
  }
  if (/^(localhost|.*\.localhost)$/i.test(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  if (!records.length) throw new Error(`Host did not resolve: ${hostname}`);
  for (const { address } of records) {
    if (isBlockedIp(address)) throw new Error(`Blocked non-public address ${address} for ${hostname}`);
  }
}

// A custom lookup validates the actual connected IP at socket time, which also
// defeats DNS-rebinding and redirects to internal hosts (every connection the
// dispatcher makes is re-checked), not just the pre-flight hostname.
function safeLookup(hostname, options, callback) {
  dns
    .lookup(hostname, { all: true, verbatim: true })
    .then((records) => {
      if (!records.length) return callback(new Error(`Host did not resolve: ${hostname}`));
      for (const { address } of records) {
        if (isBlockedIp(address)) return callback(new Error(`Blocked address ${address} for ${hostname}`));
      }
      // undici calls this with { all: true } and then expects the array form;
      // net.connect's plain form expects (err, address, family).
      if (options && options.all) {
        callback(
          null,
          records.map((r) => ({ address: r.address, family: r.family }))
        );
      } else {
        callback(null, records[0].address, records[0].family);
      }
    })
    .catch((err) => callback(err));
}

let cachedDispatcher = null;

/** undici dispatcher for `fetch({ dispatcher })` that blocks internal targets. */
export function getSafeDispatcher() {
  if (!ssrfEnabled()) return undefined;
  if (!cachedDispatcher) {
    cachedDispatcher = new Agent({ connect: { lookup: safeLookup } });
  }
  return cachedDispatcher;
}

/**
 * Guards a Playwright browser context so the headless browser can't be used to
 * reach internal hosts either. Every request's host is resolved and aborted if
 * it maps to a non-public address.
 */
export async function guardBrowserContext(context) {
  if (!ssrfEnabled()) return;
  const verdicts = new Map(); // host -> boolean (blocked)
  await context.route("**/*", async (route) => {
    try {
      const host = new URL(route.request().url()).hostname;
      let blocked = verdicts.get(host);
      if (blocked === undefined) {
        blocked = await assertPublicHost(host).then(
          () => false,
          () => true
        );
        verdicts.set(host, blocked);
      }
      if (blocked) return route.abort("addressunreachable");
      return route.continue();
    } catch {
      return route.abort("failed");
    }
  });
}
