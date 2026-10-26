import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Crawler } from "../crawler/Crawler.js";
import { buildZip } from "../zip/zipper.js";

const TTL_MS = 30 * 60 * 1000; // job artifacts are wiped 30 minutes after completion
const TMP_ROOT = path.join(process.cwd(), "tmp");

export class JobManager {
  constructor() {
    this.jobs = new Map();
    setInterval(() => this._sweep(), 60_000).unref();
  }

  createJob(options) {
    const id = randomUUID();
    const job = {
      id,
      options,
      status: "queued", // queued | running | rewriting | zipping | done | error | cancelled
      subscribers: new Set(),
      control: { cancelled: false },
      progress: { percent: 0, pagesCrawled: 0, assetsDownloaded: 0 },
      outDir: path.join(TMP_ROOT, id, "site"),
      zipPath: path.join(TMP_ROOT, id, "mirror.zip"),
      createdAt: Date.now(),
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this._run(job).catch((err) => {
      job.status = "error";
      job.error = err.message || String(err);
      this._broadcast(job, { type: "error", message: job.error });
    });
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.control.cancelled = true;
    job.status = "cancelled";
    this._broadcast(job, { type: "cancelled" });
    return true;
  }

  subscribe(id, res) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.subscribers.add(res);
    res.on("close", () => job.subscribers.delete(res));
    this._send(res, "progress", job.progress);
    if (job.status === "done") this._send(res, "done", job.result);
    if (job.status === "error") this._send(res, "error", { message: job.error });
    if (job.status === "cancelled") this._send(res, "cancelled", {});
    return true;
  }

  _send(res, type, data) {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client disconnected */
    }
  }

  _broadcast(job, { type, ...data }) {
    for (const res of job.subscribers) this._send(res, type, data);
  }

  async _run(job) {
    job.status = "running";
    const crawler = new Crawler({
      ...job.options,
      outDir: job.outDir,
      control: job.control,
      onProgress: (p) => {
        job.progress = p;
        job.status = p.phase === "rewriting" ? "rewriting" : p.phase === "writing" ? "writing" : job.status;
        this._broadcast(job, { type: "progress", ...p });
      },
    });

    const result = await crawler.run();

    if (job.control.cancelled || result.cancelled) {
      job.status = "cancelled";
      this._broadcast(job, { type: "cancelled" });
      fs.rm(path.dirname(job.outDir), { recursive: true, force: true }).catch(() => {});
      return;
    }

    job.status = "zipping";
    this._broadcast(job, { type: "progress", phase: "zipping", percent: 99, pagesCrawled: result.pageCount, assetsDownloaded: result.assetCount });

    const domain = new URL(job.options.startUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
    await buildZip({ sourceDir: job.outDir, zipPath: job.zipPath, rootFolderName: domain, crawlSummary: result, startUrl: job.options.startUrl });

    job.status = "done";
    job.result = {
      pageCount: result.pageCount,
      assetCount: result.assetCount,
      failedCount: result.failedCount,
      totalBytes: result.totalBytes,
      pages: result.pages.slice(0, 25),
      errors: result.errors,
      downloadUrl: `/api/jobs/${job.id}/download`,
      zipSizeBytes: (await fs.stat(job.zipPath)).size,
    };
    this._broadcast(job, { type: "done", ...job.result });
  }

  async _sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const finished = ["done", "error", "cancelled"].includes(job.status);
      if (finished && now - job.createdAt > TTL_MS) {
        await fs.rm(path.join(TMP_ROOT, id), { recursive: true, force: true }).catch(() => {});
        this.jobs.delete(id);
      }
    }
  }
}
