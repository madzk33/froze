import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import Lenis from "lenis";
import AdvancedOptions from "./components/AdvancedOptions.jsx";
import ProgressPanel from "./components/ProgressPanel.jsx";
import ResultPanel from "./components/ResultPanel.jsx";
import ThemeToggle from "./components/ThemeToggle.jsx";
import VantaBackground from "./components/VantaBackground.jsx";
import { usePrefersReducedMotion } from "./hooks/useTheme.js";
import { cancelJob, createJob, downloadUrl, subscribeToJob } from "./api.js";

const DEFAULT_OPTIONS = {
  maxDepth: 4,
  maxPages: 300,
  maxTotalSizeMB: 400,
  // Render JavaScript is on by default: most modern sites build their content
  // client-side, so a plain HTTP crawl captures blank/broken pages. Concurrency
  // is set to 3 to match — render mode needs each headless page to get enough
  // CPU to finish its own data fetches before capture.
  concurrency: 3,
  delayMs: 150,
  includeExternalAssets: false,
  respectRobots: true,
  renderJs: true,
  replayJs: true,
  userAgent: "chrome",
};

const CAPABILITIES = ["js-rendering", "record-replay", "link-rewriting", "robots-aware", "offline-zip"];

function normalizeUrlInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="fill-cta glow-ring flex h-8 w-8 items-center justify-center rounded-lg" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="h-5 w-5" fill="none" aria-hidden="true">
          <path d="M16 7v12M11 14.5l5 5 5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="9" y="23.5" width="14" height="2.6" rx="1.3" fill="currentColor" />
        </svg>
      </span>
      <div className="leading-none">
        <span className="block text-base font-bold tracking-tight" translate="no">
          SiteMirror
        </span>
        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          offline archiver
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [status, setStatus] = useState("idle"); // idle | running | done | error | cancelled
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const jobIdRef = useRef(null);
  const unsubscribeRef = useRef(null);
  const scopeRef = useRef(null);
  const reduced = usePrefersReducedMotion();

  // Lenis smooth scroll — skipped for reduced-motion.
  useEffect(() => {
    if (reduced) return;
    const lenis = new Lenis({ duration: 1.1, smoothWheel: true });
    let raf;
    const loop = (t) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [reduced]);

  // GSAP entrance — a single staggered reveal on load. Hides elements before
  // paint (useLayoutEffect) so there's no flash; reduced-motion shows them as-is.
  useLayoutEffect(() => {
    if (reduced) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-anim]", {
        opacity: 0,
        y: 18,
        duration: 0.7,
        ease: "power3.out",
        stagger: 0.09,
        delay: 0.05,
      });
    }, scopeRef);
    return () => ctx.revert();
  }, [reduced]);

  const reset = useCallback(() => {
    unsubscribeRef.current?.();
    jobIdRef.current = null;
    setStatus("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const cleanUrl = normalizeUrlInput(url);
    if (!cleanUrl) {
      setError("Please enter a website URL.");
      setStatus("error");
      return;
    }
    setError(null);
    setResult(null);
    setStatus("running");
    setProgress({ phase: "crawling", percent: 0, pagesCrawled: 0, assetsDownloaded: 0 });

    try {
      const id = await createJob({ startUrl: cleanUrl, ...options });
      jobIdRef.current = id;
      unsubscribeRef.current = subscribeToJob(id, {
        onProgress: setProgress,
        onDone: (data) => {
          setResult(data);
          setStatus("done");
        },
        onError: (err) => {
          setError(err.message || "The crawl failed unexpectedly.");
          setStatus("error");
        },
        onCancelled: () => setStatus("cancelled"),
      });
    } catch (err) {
      setError(err.message || "Could not start the crawl.");
      setStatus("error");
    }
  };

  const handleCancel = async () => {
    if (jobIdRef.current) await cancelJob(jobIdRef.current);
  };

  const running = status === "running";

  return (
    <div ref={scopeRef} className="clip-x relative min-h-screen">
      {/* living WebGL network field (reduced-motion safe); hero glow sits on top for warmth */}
      <VantaBackground />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[520px] hero-glow" aria-hidden="true" />

      <a
        href="#main"
        className="sr-only rounded-md bg-card px-4 py-2 text-sm font-medium text-foreground shadow focus-visible:not-sr-only focus-visible:absolute focus-visible:left-4 focus-visible:top-4 focus-visible:z-50"
      >
        Skip to content
      </a>

      <div className="relative z-10">
        <header className="sticky top-0 z-20 bg-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 sm:px-6">
            <Wordmark />
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="mx-auto max-w-3xl px-4 pb-16 pt-14 sm:px-6 sm:pt-20">
          {/* hero */}
          <div className="mb-10 text-center">
            <p data-anim className="mb-4 font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-primary-ink">
              <span aria-hidden="true">— </span>Self-Hosted Web Archiver
            </p>
            <h1 data-anim className="mx-auto max-w-2xl text-balance text-3xl font-bold leading-[1.08] tracking-tight sm:text-5xl">
              Mirror Any Website Into a{" "}
              <span className="text-primary-ink">Self-Contained ZIP.</span>
            </h1>
            <p data-anim className="mx-auto mt-4 max-w-lg text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base">
              Paste a URL. We crawl, render, and rewrite it into a ZIP that runs offline &mdash; no
              internet required.
            </p>
          </div>

          {/* command panel */}
          <form
            data-anim
            onSubmit={handleSubmit}
            className="panel-shadow rounded-2xl border border-border bg-card p-4 transition-shadow focus-within:glow-ring sm:p-5"
          >
            <label htmlFor="target-url" className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Target URL
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
                  </svg>
                </span>
                <input
                  id="target-url"
                  name="url"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={running}
                  className="ui-field !pl-11 text-base disabled:opacity-60"
                  style={{ paddingTop: "0.85rem", paddingBottom: "0.85rem" }}
                />
              </div>
              <button
                type="submit"
                disabled={running}
                className="btn-cta group inline-flex shrink-0 items-center justify-center gap-2 rounded-[calc(var(--radius)-2px)] px-6 py-3.5 text-base font-semibold shadow-sm transition-[box-shadow,filter,transform] duration-200 hover:glow-ring hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
              >
                {running ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    Mirroring&hellip;
                  </>
                ) : (
                  <>
                    Mirror &amp; Download
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 transition-transform group-hover:translate-y-0.5" aria-hidden="true">
                      <path d="M12 16.5a.75.75 0 0 1-.53-.22l-4.5-4.5a.75.75 0 1 1 1.06-1.06l3.22 3.22V3a.75.75 0 0 1 1.5 0v11.94l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-.53.22Z" />
                      <path d="M3.75 15a.75.75 0 0 1 .75.75v2.5c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25v-2.5a.75.75 0 0 1 1.5 0v2.5A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25v-2.5a.75.75 0 0 1 .75-.75Z" />
                    </svg>
                  </>
                )}
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                aria-controls="advanced-options"
                className="inline-flex items-center gap-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-90" : ""}`} aria-hidden="true">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
                </svg>
                Configure Crawl
              </button>
              <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline" translate="no">
                depth {options.maxDepth} &middot; {options.maxPages} pages &middot; render {options.renderJs ? "on" : "off"}
              </span>
            </div>

            {showAdvanced && (
              <div id="advanced-options" className="mt-4 animate-fade-up border-t border-border pt-5">
                <AdvancedOptions options={options} setOptions={setOptions} />
              </div>
            )}
          </form>

          {/* capability spec line — reads like a tech spec, not SaaS pills */}
          <p data-anim className="mt-5 text-center font-mono text-[11px] text-muted-foreground" translate="no">
            {CAPABILITIES.map((cap, i) => (
              <span key={cap}>
                {i > 0 && <span className="text-border"> / </span>}
                {cap}
              </span>
            ))}
          </p>

          <p data-anim className="mx-auto mt-3 max-w-md text-center font-mono text-[11px] leading-relaxed text-muted-foreground">
            For personal / archival use only. Respect the target site&rsquo;s copyright and terms of
            service.
          </p>

          {/* live states */}
          <div className="mt-8 space-y-6">
            {status === "error" && (
              <div role="alert" className="animate-fade-up rounded-xl border border-destructive-soft tint-destructive p-4">
                <div className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                  </svg>
                  Something Went Wrong
                </div>
                <p className="mt-1.5 text-sm text-foreground">{error}</p>
              </div>
            )}

            {status === "cancelled" && (
              <div className="animate-fade-up rounded-xl border border-border bg-secondary p-4 text-sm text-secondary-foreground">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Cancelled &middot; </span>
                Crawl stopped.{" "}
                <button onClick={reset} className="font-medium text-primary-ink underline-offset-2 hover:underline">
                  Start a New One
                </button>
              </div>
            )}

            {running && <ProgressPanel progress={progress} onCancel={handleCancel} />}

            {status === "done" && result && (
              <ResultPanel result={result} downloadHref={downloadUrl(jobIdRef.current)} onReset={reset} />
            )}
          </div>
        </main>

        <footer className="mx-auto max-w-3xl px-4 pb-10 sm:px-6">
          <div className="border-t border-border pt-6 text-center font-mono text-[11px] leading-relaxed text-muted-foreground">
            Renders each page in a real browser to capture JavaScript-built content. Login-walled or
            bot-protected sites may not mirror perfectly.
          </div>
        </footer>
      </div>
    </div>
  );
}
