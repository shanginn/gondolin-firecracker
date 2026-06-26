import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createSessionBackend } from "./backends.ts";
import type { SimulatorConfig } from "./config.ts";
import { dashboardHtml } from "./dashboard.ts";
import { ResourceMonitor } from "./resource-monitor.ts";
import { MultiTenantSimulator } from "./simulator.ts";

const MAX_BODY_BYTES = 64 * 1024;

export type SimulatorServer = {
  /** Node HTTP server */
  server: ReturnType<typeof createServer>;
  /** Running simulator instance */
  simulator: MultiTenantSimulator;
};

export async function createSimulatorServer(
  config: SimulatorConfig,
): Promise<SimulatorServer> {
  const backend = await createSessionBackend(config);
  const simulator = new MultiTenantSimulator(config, backend);
  const resourceMonitor = new ResourceMonitor(config);

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, simulator, resourceMonitor);
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { server, simulator };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  simulator: MultiTenantSimulator,
  resourceMonitor: ResourceMonitor,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, dashboardHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/readyz") {
    sendJson(res, 200, { ok: true, backend: simulator.snapshot().backend });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, simulator.snapshot());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    const snapshot = simulator.snapshot();
    const resources = await resourceMonitor.sample({
      activeSlots: snapshot.gauges.activeVms,
      configuredSlots: snapshot.settings.maxActiveVms,
    });
    sendJson(res, 200, resources);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const settings = simulator.updateSettings({
      targetUsers: numberValue(body.targetUsers),
      maxActiveVms: numberValue(body.maxActiveVms),
      spawnRatePerMinute: numberValue(body.spawnRatePerMinute),
      tempo: numberValue(body.tempo),
    });
    sendJson(res, 200, { settings });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    const body = await readJson(req);
    const action = String(body.action ?? "");
    if (
      action !== "start" &&
      action !== "pause" &&
      action !== "reset" &&
      action !== "burst"
    ) {
      sendJson(res, 400, { error: "invalid action" });
      return;
    }
    await simulator.action(action, numberValue(body.value));
    sendJson(res, 200, simulator.snapshot());
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
