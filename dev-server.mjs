// Local development server: serves public/ and runs the api/ functions the same way
// Vercel does (Web Request in, Response out). Without Redis env vars the API uses an
// in-memory store, so scores and rooms reset when this process restarts.
//   node dev-server.mjs            (PORT env var, default 3000)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT) || 3000;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const routes = { "/api/scores": "./api/scores.js", "/api/rooms": "./api/rooms.js" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (routes[url.pathname]) {
      const mod = await import(routes[url.pathname]);
      const handler = mod[req.method];
      if (!handler) { res.writeHead(405).end(); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method, headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = normalize(join(publicDir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    if (!path.startsWith(publicDir)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") { res.writeHead(404).end("Not found"); return; }
    console.error(e);
    res.writeHead(500).end("Server error");
  }
});

server.listen(port, async () => {
  const { store } = await import("./lib/store.js");
  console.log(`sketchX on http://localhost:${port} (scores and rooms: ${store.kind === "redis" ? "Upstash Redis" : "in memory"})`);
});
