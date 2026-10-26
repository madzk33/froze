import { useState } from "react";
import CountUp from "./CountUp.jsx";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Stat({ value, label, highlight, format }) {
  return (
    <div className="rounded-[calc(var(--radius)-2px)] border border-border bg-background px-3 py-2.5">
      <div className={`font-mono text-lg font-semibold tabular-nums ${highlight ? "text-signal-ink" : "text-foreground"}`}>
        <CountUp value={value} format={format} />
      </div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
    </div>
  );
}

export default function ResultPanel({ result, downloadHref, onReset }) {
  const [downloadError, setDownloadError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  // Fetch the ZIP ourselves so we can verify it's actually a ZIP before saving.
  // A plain <a download> would silently save the server's JSON error as a
  // confusing ".json" file if the mirror has expired (jobs are kept in memory
  // and are lost when the backend restarts).
  const handleDownload = async () => {
    setDownloadError(null);
    setDownloading(true);
    try {
      const res = await fetch(downloadHref);
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.includes("zip")) {
        throw new Error(
          "This mirror is no longer available on the server (it expires after a while, or the server was restarted). Please run the crawl again."
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const match = /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") || "");
      a.download = match ? match[1] : "froze.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.message || "Download failed.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div role="status" className="panel-shadow glow-ring animate-fade-up space-y-5 rounded-2xl border border-primary-soft bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="fill-cta flex h-10 w-10 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" className="h-5 w-5">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-ink">Archive Ready</div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">Your Offline Mirror Is Ready</h2>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={result.pageCount} label="Pages" format={(n) => Math.round(n).toLocaleString()} />
        <Stat value={result.assetCount} label="Assets" format={(n) => Math.round(n).toLocaleString()} />
        <Stat value={result.zipSizeBytes} label="ZIP size" format={formatBytes} />
        <Stat value={result.failedCount} label="Failed" highlight={result.failedCount > 0} format={(n) => Math.round(n).toLocaleString()} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="btn-cta group inline-flex items-center justify-center gap-2 rounded-[calc(var(--radius)-2px)] px-5 py-3 text-sm font-semibold shadow-sm transition-[box-shadow,filter,transform] duration-200 hover:glow-ring hover:brightness-105 disabled:opacity-60"
        >
          {downloading ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              Preparing&hellip;
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 transition-transform group-hover:translate-y-0.5" aria-hidden="true">
                <path d="M12 16.5a.75.75 0 0 1-.53-.22l-4.5-4.5a.75.75 0 1 1 1.06-1.06l3.22 3.22V3a.75.75 0 0 1 1.5 0v11.94l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-.53.22Z" />
                <path d="M3.75 15a.75.75 0 0 1 .75.75v2.5c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25v-2.5a.75.75 0 0 1 1.5 0v2.5A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25v-2.5a.75.75 0 0 1 .75-.75Z" />
              </svg>
              Download ZIP
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center justify-center rounded-[calc(var(--radius)-2px)] border border-border bg-background px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Mirror Another Site
        </button>
      </div>

      {downloadError && (
        <p role="alert" className="rounded-[calc(var(--radius)-2px)] border border-signal-soft tint-signal px-3 py-2 font-mono text-xs text-foreground">
          {downloadError}
        </p>
      )}

      {result.pages?.length > 0 && (
        <details className="group text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
            Archived pages ({result.pages.length}
            {result.pageCount > result.pages.length ? "+" : ""})
          </summary>
          <ul className="scroll-slim mt-2 max-h-40 space-y-1 overflow-y-auto rounded-[calc(var(--radius)-2px)] border border-border bg-background p-3 font-mono text-xs" translate="no">
            {result.pages.map((p) => (
              <li key={p.url} className="truncate">
                <span className="text-muted-foreground">{p.url}</span>
                <span className="text-primary-ink"> &rarr; {p.localPath}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.errors?.length > 0 && (
        <details className="group text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 font-mono text-xs text-signal-ink transition-colors hover:brightness-110">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true">
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
            {result.errors.length} resource(s) skipped
          </summary>
          <ul className="scroll-slim mt-2 max-h-32 space-y-1 overflow-y-auto rounded-[calc(var(--radius)-2px)] border border-border bg-background p-3 font-mono text-xs text-muted-foreground" translate="no">
            {result.errors.map((e, idx) => (
              <li key={idx} className="truncate">{e}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
