import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PREVIEW_ROOT = __dirname;
const ASSETS_ROOT = path.join(REPO_ROOT, "miniprogram", "assets");
const ADMIN_ROOT = path.join(REPO_ROOT, "admin");

const HOST = process.env.PREVIEW_HOST || "0.0.0.0";
const PORT = Number(process.env.PREVIEW_PORT || 8799);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function safeResolve(baseDir, reqSubpath) {
  const clean = path.posix.normalize("/" + reqSubpath).replace(/^\/+/, "");
  const full = path.resolve(baseDir, clean);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
    return null;
  }
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    let filePath = null;
    if (pathname.startsWith("/assets/")) {
      filePath = safeResolve(ASSETS_ROOT, pathname.slice("/assets/".length));
    } else if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      const sub = pathname === "/admin" ? "index.html" : pathname.slice("/admin/".length) || "index.html";
      if (sub.endsWith(".test.mjs")) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      filePath = safeResolve(ADMIN_ROOT, sub);
    } else {
      filePath = safeResolve(PREVIEW_ROOT, pathname.slice(1));
    }

    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let data;
    let resolvedPath = filePath;
    try {
      data = await fs.readFile(resolvedPath);
    } catch (err) {
      if (err && err.code === "ENOENT" && /^\/pages\/[a-z0-9-]+\.html$/i.test(pathname)) {
        resolvedPath = path.join(PREVIEW_ROOT, "pages", "_placeholder.html");
        data = await fs.readFile(resolvedPath);
      } else {
        throw err;
      }
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(data);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EISDIR")) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UI Preview server listening on http://${HOST}:${PORT}/`);
});
