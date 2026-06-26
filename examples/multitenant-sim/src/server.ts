import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MultitenantSimulator } from "./simulator.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");
const simulator = new MultitenantSimulator();

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  });
});

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/health"
  ) {
    sendJson(res, 200, { ok: true }, req.method === "HEAD");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    simulator.updateConfig(await readJson(req));
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    await simulator.start();
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pause") {
    simulator.pause();
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    await simulator.reset();
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/burst") {
    const body = await readJson(req);
    simulator.enqueueBurst(Number(body.count ?? 1));
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/user-task") {
    const body = await readJson(req);
    simulator.enqueueUser(String(body.userId ?? ""));
    sendJson(res, 200, await simulator.snapshotState());
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  await serveStatic(url.pathname, res, req.method === "HEAD");
}

async function serveStatic(
  route: string,
  res: http.ServerResponse,
  headOnly = false,
) {
  const cleanRoute = route === "/" ? "/index.html" : route;
  const filePath = path.resolve(publicDir, "." + cleanRoute);
  if (!filePath.startsWith(publicDir + path.sep)) {
    sendJson(res, 400, { error: "bad path" });
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(headOnly ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 1024 * 1024) {
      throw new Error("request body too large");
    }
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(headOnly ? undefined : JSON.stringify(body));
}

function contentType(filePath: string) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

server.listen(simulator.getConfig().port, () => {
  const { port } = simulator.getConfig();
  console.log(`multitenant simulator listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void simulator.shutdown().finally(() => process.exit(0));
  });
}
