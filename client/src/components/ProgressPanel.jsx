function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(seconds) {
  if (seconds == null) return "—";
  if (seconds <= 1) return "~done";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const PHASE_LABEL = {
  crawling: "Crawling pages & assets",
  rewriting: "Rewriting links for offline use",
  writing: "Writing files to disk",
  zipping: "Building ZIP archive",
  cancelled: "Cancelling…",
};

function Stat({ label, value }) {
  return (
    <div className="rounded-[calc(var(--radius)-2px)] border border-border bg-background px-3 py-2.5">
      <div className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
    </div>
  );
}

export default function ProgressPanel({ progress, onCancel }) {
  const percent = progress?.percent ?? 0;
  const phaseLabel = PHASE_LABEL[progress?.phase] || "Working…";

  return (
    <div className="panel-shadow animate-fade-up space-y-5 rounded-2xl border border-border bg-card p-5">
      {/* concise, polite announcement for assistive tech */}
      <p className="sr-only" role="status" aria-live="polite">
        {phaseLabel}, {percent}% complete.
      </p>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <p className="text-sm font-semibold text-foreground">{phaseLabel}</p>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={progress?.currentUrl || ""} translate="no">
            <span className="text-primary-ink" aria-hidden="true">▸</span>{" "}
            {progress?.currentUrl ? progress.currentUrl : "initializing…"}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-[calc(var(--radius)-4px)] border border-destructive-soft px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-destructive transition-colors hover:tint-destructive"
        >
          Cancel
        </button>
      </div>

      {/* progress bar */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between font-mono text-xs">
          <span className="text-muted-foreground">progress</span>
          <span className="text-lg font-semibold tabular-nums text-foreground">{percent}%</span>
        </div>
        <div
          className="relative h-2.5 w-full overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={phaseLabel}
        >
          <div
            className="fill-cta relative h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(4, percent)}%` }}
          >
            <div className="absolute inset-0 overflow-hidden rounded-full">
              <div className="animate-shimmer absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pages" value={progress?.pagesCrawled ?? 0} />
        <Stat label="Assets" value={progress?.assetsDownloaded ?? 0} />
        <Stat label="Downloaded" value={formatBytes(progress?.totalBytes)} />
        <Stat label="ETA" value={formatEta(progress?.etaSeconds)} />
      </div>

      {progress?.failed > 0 && (
        <p className="font-mono text-xs text-signal-ink">
          <span className="font-semibold">{progress.failed}</span> resource(s) failed to fetch and were skipped.
        </p>
      )}

      {progress?.recentPages?.length > 0 && (
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Crawl log</p>
          <ul className="scroll-slim max-h-36 space-y-1 overflow-y-auto rounded-[calc(var(--radius)-2px)] border border-border bg-background p-3 font-mono text-xs" translate="no">
            {progress.recentPages
              .slice(-5)
              .reverse()
              .map((u) => (
                <li key={u} className="flex min-w-0 items-start gap-2">
                  <span className="shrink-0 text-primary-ink">GET</span>
                  <span className="truncate text-muted-foreground">{u}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
