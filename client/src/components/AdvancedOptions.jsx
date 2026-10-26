const labelClass =
  "mb-1.5 block font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function NumberField({ label, value, onChange, min, max, hint }) {
  const id = `opt-${slug(label)}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="numeric"
        className="ui-field tabular-nums"
        value={value}
        min={min}
        max={max}
        aria-describedby={hintId}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && (
        <p id={hintId} className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  const id = `opt-${slug(label)}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start justify-between gap-3 rounded-[calc(var(--radius)-2px)] border px-3.5 py-3 transition-colors ${
        checked ? "border-primary-soft tint-primary" : "border-border bg-background"
      }`}
    >
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint && (
          <span id={hintId} className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center">
        <input
          id={id}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="absolute inset-0 rounded-full bg-input transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card" />
        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export default function AdvancedOptions({ options, setOptions }) {
  const set = (key) => (value) => setOptions((prev) => ({ ...prev, [key]: value }));

  // JS-rendered pages are much heavier per request — too much concurrency
  // starves each page of the CPU it needs to finish its own data fetches
  // before capture, producing pages with content missing rather than just a
  // slower crawl. The server enforces this cap regardless, but adjusting it
  // here keeps what's shown in sync with what actually happens.
  const handleRenderJsToggle = (enabled) => {
    setOptions((prev) => ({
      ...prev,
      renderJs: enabled,
      concurrency: enabled ? Math.min(prev.concurrency, 3) : prev.concurrency,
    }));
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <NumberField label="Max depth" value={options.maxDepth} min={1} max={10} onChange={set("maxDepth")} hint="How many link-hops from the start page" />
      <NumberField label="Max pages" value={options.maxPages} min={1} max={1000} onChange={set("maxPages")} hint="Hard ceiling on pages archived" />
      <NumberField label="Concurrent requests" value={options.concurrency} min={1} max={16} onChange={set("concurrency")} hint="Parallel downloads (higher = faster)" />
      <NumberField label="Delay between requests (ms)" value={options.delayMs} min={0} max={2000} onChange={set("delayMs")} hint="Politeness delay per request" />

      <div>
        <label htmlFor="opt-user-agent" className={labelClass}>
          User-Agent
        </label>
        <select id="opt-user-agent" name="opt-user-agent" className="ui-field" value={options.userAgent} onChange={(e) => set("userAgent")(e.target.value)}>
          <option value="chrome">Chrome (desktop)</option>
          <option value="firefox">Firefox (desktop)</option>
          <option value="safari">Safari (desktop)</option>
          <option value="bot">SiteMirrorBot (identifies itself)</option>
        </select>
      </div>

      <NumberField label="Max total size (MB)" value={options.maxTotalSizeMB} min={10} max={1000} onChange={set("maxTotalSizeMB")} hint="Stops the crawl once exceeded" />

      <Toggle
        label="Include external assets"
        hint="Also download CSS/JS/images hosted on other domains (e.g. CDNs)"
        checked={options.includeExternalAssets}
        onChange={set("includeExternalAssets")}
      />
      <Toggle
        label="Follow robots.txt"
        hint="Respect the site's crawling rules (recommended)"
        checked={options.respectRobots}
        onChange={set("respectRobots")}
      />
      <div className="sm:col-span-2">
        <Toggle
          label="Render JavaScript (slower)"
          hint="Loads pages in a real headless browser instead of a plain HTTP request — captures content that JS adds after load (SPAs, dynamic menus, CSS-in-JS). Much slower per page; concurrency is auto-lowered to 3 so each page gets enough CPU to finish loading its data before being captured."
          checked={options.renderJs}
          onChange={handleRenderJsToggle}
        />
      </div>
      {options.renderJs && (
        <div className="animate-fade-up sm:col-span-2">
          <Toggle
            label="Keep interactive (record & replay)"
            hint="Records the data each page loads and replays it offline so the site's own buttons, tabs and filters still work in the mirror. Turn off for a plain static snapshot (content shown but not clickable) if an interactive page misbehaves."
            checked={options.replayJs}
            onChange={set("replayJs")}
          />
        </div>
      )}
    </div>
  );
}
