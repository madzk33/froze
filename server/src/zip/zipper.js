import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

function readmeText({ startUrl, rootFolderName, crawlSummary }) {
  return `SiteMirror — offline archive of ${startUrl}
=====================================================

Generated: ${new Date().toISOString()}
Pages archived:  ${crawlSummary.pageCount}
Assets archived: ${crawlSummary.assetCount}
Failed fetches:  ${crawlSummary.failedCount}

HOW TO VIEW THIS SITE
----------------------
This is a static, offline snapshot. Because pages reference assets with
root-relative paths (e.g. /css/style.css), you MUST view it through a local
web server — double-clicking index.html in a browser (file:// URLs) will
show a broken/unstyled page.

Option A — Python (usually already installed):
    cd ${rootFolderName}
    python3 serve.py
    # then open http://localhost:8000

    (equivalent to: python3 -m http.server 8000)

Option B — Node.js:
    cd ${rootFolderName}
    npx serve -l 8000
    # then open http://localhost:8000

Option C — VS Code:
    Right-click index.html -> "Open with Live Server"

WHAT'S INCLUDED
----------------
- All crawled HTML pages, with internal links rewritten to point at the
  local copies.
- CSS, JavaScript, images, fonts, favicons, and web manifests referenced
  by those pages, with url()/srcset/import references rewritten as well.
- Assets that could not be mirrored (blocked by robots.txt, disallowed
  external hosts, or fetch failures) are left pointing at their original
  live URL, so the page still renders as closely as possible to the
  original — but those specific pieces require an internet connection.

KNOWN LIMITATIONS
-------------------
- Single-page apps that fetch content dynamically via JavaScript/APIs after
  load may not be fully captured (this crawler does not execute JavaScript).
- Content behind a login wall, paywalls, or aggressive anti-bot/CAPTCHA
  protection cannot be archived.
- Server-side functionality (search, forms, checkout, comments, etc.)
  cannot be mirrored — only what is server-rendered or statically loaded.
- Very large or highly dynamic sites may be partially archived if they hit
  the configured page/depth/size limits.

This archive is intended for personal backup, research, and offline
reading. You are responsible for respecting the original site's copyright
and terms of service.
`;
}

function servePyText() {
  return `#!/usr/bin/env python3
"""Tiny static file server for this SiteMirror archive.
Usage: python3 serve.py [port]   (default port: 8000)
"""
import http.server
import socketserver
import sys
import os

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))

Handler = http.server.SimpleHTTPRequestHandler
Handler.extensions_map.update({
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
})

with socketserver.TCPServer(("", port), Handler) as httpd:
    print(f"Serving SiteMirror archive at http://localhost:{port}")
    httpd.serve_forever()
`;
}

function packageJsonText() {
  return JSON.stringify(
    {
      name: "sitemirror-archive",
      private: true,
      version: "1.0.0",
      description: "Offline SiteMirror archive — static site, no build needed.",
      scripts: { start: "npx serve -l 8000 ." },
    },
    null,
    2
  );
}

export async function buildZip({ sourceDir, zipPath, rootFolderName, crawlSummary, startUrl }) {
  await fsp.writeFile(path.join(sourceDir, "README.txt"), readmeText({ startUrl, rootFolderName, crawlSummary }));
  await fsp.writeFile(path.join(sourceDir, "serve.py"), servePyText());
  await fsp.writeFile(path.join(sourceDir, "package.json"), packageJsonText());

  await fsp.mkdir(path.dirname(zipPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, rootFolderName);
    archive.finalize();
  });
}
