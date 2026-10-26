import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { JobManager } from "./jobs/JobManager.js";
import { assertPublicHost, ssrfEnabled } from "./crawler/ssrf.js";

const PORT = process.env.PORT || 8787;
const PUBLIC = ssrfEnabled(); // tighter limits + rate limiting when exposed publicly
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || (PUBLIC ? 3 : 100);
const app = express();
app.set("trust proxy", 1); // behind a platform proxy (Render/Railway/Fly) so rate-limit sees the real IP
const jobs = new JobManager();

app.use(cors());
app.use(express.json({ limit: "64kb" }));

// Cap how often one IP can kick off a crawl — each job is heavy (a headless
// browser + arbitrary downloads), so this is the first line against abuse.
const createJobLimiter = rateLimit({
  windowMs: 60_000,
  limit: PUBLIC ? 5 : 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many crawls started. Please wait a minute and try again." },
});

const USER_AGENTS = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  bot: "FrozeBot/1.0 (+offline-archiver; respects robots.txt)",
};

// Hard ceilings — independent of what the client requests — to prevent abuse.
// Public instances get much tighter caps than a trusted local/self-host run.
const LIMITS = PUBLIC
  ? { maxDepth: 4, maxPages: 60, maxTotalSizeMB: 150, concurrency: 4 }
  : { maxDepth: 10, maxPages: 1000, maxTotalSizeMB: 1000, concurrency: 16 };

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

app.post("/api/jobs", createJobLimiter, async (req, res) => {
  const body = req.body || {};
  let startUrl, hostname;
  try {
    const u = new URL(body.startUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    startUrl = u.toString();
    hostname = u.hostname;
  } catch {
    return res.status(400).json({ error: "Please enter a valid http(s) URL." });
  }

  // Reject internal/metadata targets up front with a clear message (the crawler
  // enforces this again at fetch time; this is the friendly early rejection).
  try {
    await assertPublicHost(hostname);
  } catch {
    return res.status(400).json({ error: "That address can't be mirrored — only public websites are allowed." });
  }

  if (jobs.runningCount() >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: "The server is busy with other crawls right now. Please try again shortly." });
  }

  const options = {
    startUrl,
    maxDepth: clamp(body.maxDepth, 1, LIMITS.maxDepth, 4),
    maxPages: clamp(body.maxPages, 1, LIMITS.maxPages, 300),
    maxTotalSizeMB: clamp(body.maxTotalSizeMB, 10, LIMITS.maxTotalSizeMB, 400),
    concurrency: clamp(body.concurrency, 1, LIMITS.concurrency, 6),
    delayMs: clamp(body.delayMs, 0, 5000, 150),
    includeExternalAssets: Boolean(body.includeExternalAssets),
    respectRobots: body.respectRobots !== false,
    renderJs: Boolean(body.renderJs),
    replayJs: body.replayJs !== false,
    userAgent: USER_AGENTS[body.userAgent] || USER_AGENTS.chrome,
  };

  const job = jobs.createJob(options);
  res.json({ id: job.id });
});

app.get("/api/jobs/:id/events", (req, res) => {
  const ok = jobs.get(req.params.id);
  if (!ok) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  jobs.subscribe(req.params.id, res);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ id: job.id, status: job.status, progress: job.progress, result: job.result, error: job.error });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const ok = jobs.cancel(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ cancelled: true });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done") return res.status(404).json({ error: "not ready" });
  const domain = new URL(job.options.startUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
  if (!fs.existsSync(job.zipPath)) return res.status(410).json({ error: "expired" });
  res.download(job.zipPath, `froze-${domain}.zip`);
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// In Docker/production, the client is pre-built and served from the same
// process so the whole app is a single container on one port.
const clientDist = path.resolve(process.cwd(), "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`Froze API listening on http://localhost:${PORT}`);
});
