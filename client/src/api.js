export async function createJob(options) {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to start crawl.");
  return data.id;
}

export function subscribeToJob(id, { onProgress, onDone, onError, onCancelled }) {
  // Build an explicit absolute URL rather than handing EventSource a relative
  // one. Safari's EventSource does its own relative->absolute resolution
  // against document.baseURI and, if that ever lands on a non-http(s) URL,
  // throws a bare "The string did not match the expected pattern." with no
  // indication of why — resolving against window.location.origin ourselves
  // sidesteps that resolution entirely.
  const url = new URL(`/api/jobs/${id}/events`, window.location.origin).toString();
  let source;
  try {
    source = new EventSource(url);
  } catch {
    // Belt-and-suspenders: if this ever throws again for some other reason,
    // surface something actionable instead of a bare browser-internal string.
    throw new Error("Couldn't connect to the crawl progress stream. Try refreshing the page.");
  }
  source.addEventListener("progress", (e) => onProgress?.(JSON.parse(e.data)));
  source.addEventListener("done", (e) => {
    onDone?.(JSON.parse(e.data));
    source.close();
  });
  source.addEventListener("error", (e) => {
    if (e.data) {
      try {
        onError?.(JSON.parse(e.data));
      } catch {
        onError?.({ message: "Connection to server lost." });
      }
    }
    source.close();
  });
  source.addEventListener("cancelled", () => {
    onCancelled?.();
    source.close();
  });
  source.onerror = () => {
    // Native EventSource error (network/connection) — browser auto-retries;
    // give a clean failure instead of an infinite silent retry loop.
    source.close();
  };
  return () => source.close();
}

export async function cancelJob(id) {
  await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export function downloadUrl(id) {
  return `/api/jobs/${id}/download`;
}
