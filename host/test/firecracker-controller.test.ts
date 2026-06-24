import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { firecrackerRequest } from "../src/sandbox/firecracker-controller.ts";

test("firecrackerRequest sends JSON over a Unix HTTP socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-api-"));
  const socketPath = path.join(dir, "api.sock");
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "PUT");
    assert.equal(req.url, "/machine-config");
    req.on("data", (chunk) => bodies.push(chunk.toString()));
    req.on("end", () => {
      res.writeHead(204);
      res.end();
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    assert.equal(
      await firecrackerRequest(socketPath, "PUT", "/machine-config", {
        vcpu_count: 1,
      }),
      "",
    );
    assert.equal(bodies.join(""), '{\n  "vcpu_count": 1\n}\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
