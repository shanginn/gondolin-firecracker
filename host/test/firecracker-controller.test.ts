import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test,
  FirecrackerController,
  firecrackerRequest,
  type FirecrackerConfig,
} from "../src/sandbox/firecracker-controller.ts";

test("controller cleanup preserves an unowned adjacent config file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-cleanup-"));
  const apiSocketPath = path.join(dir, "api.sock");
  const vsockPath = path.join(dir, "vsock.sock");
  const adjacentPath = `${apiSocketPath}.config.json`;
  fs.writeFileSync(apiSocketPath, "old api socket");
  fs.writeFileSync(vsockPath, "old vsock");
  fs.writeFileSync(adjacentPath, "user data");

  const controller = new FirecrackerController({
    firecrackerPath: "firecracker",
    apiSocketPath,
    vsockPath,
    guestCid: 7,
    kernelPath: path.join(dir, "kernel"),
    initrdPath: path.join(dir, "initrd"),
    memory: "52M",
    cpus: 1,
    append: "",
    autoRestart: false,
  });

  try {
    (controller as unknown as { cleanupSockets: () => void }).cleanupSockets();
    assert.equal(fs.readFileSync(adjacentPath, "utf8"), "user data");
    assert.equal(fs.existsSync(apiSocketPath), false);
    assert.equal(fs.existsSync(vsockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Firecracker boot configs use private unique files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-private-"));
  const apiSocketPath = path.join(dir, "api.sock");
  try {
    const first = __test.writeFirecrackerBootConfigFile(apiSocketPath, {});
    const second = __test.writeFirecrackerBootConfigFile(apiSocketPath, {});
    assert.notEqual(first, second);
    assert.notEqual(first, `${apiSocketPath}.config.json`);
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Firecracker config file includes cold-boot devices", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-config-"));
  const kernelPath = path.join(dir, "kernel");
  const initrdPath = path.join(dir, "initrd");
  const rootDiskPath = path.join(dir, "rootfs");
  fs.writeFileSync(kernelPath, "kernel");
  fs.writeFileSync(initrdPath, "initrd");
  fs.writeFileSync(rootDiskPath, "rootfs");

  const config: FirecrackerConfig = {
    firecrackerPath: "firecracker",
    apiSocketPath: path.join(dir, "api.sock"),
    vsockPath: path.join(dir, "vsock.sock"),
    guestCid: 7,
    kernelPath,
    initrdPath,
    rootDiskPath,
    rootDiskFormat: "raw",
    rootDiskReadOnly: true,
    memory: "52M",
    cpus: 2,
    append: "console=null init=/init",
    autoRestart: false,
    netTapName: "gtap0",
    netMac: "02:00:00:00:00:02",
  };

  try {
    assert.deepEqual(__test.buildFirecrackerBootConfig(config), {
      "boot-source": {
        kernel_image_path: kernelPath,
        boot_args: "console=null init=/init",
        initrd_path: initrdPath,
      },
      "machine-config": { vcpu_count: 2, mem_size_mib: 52 },
      vsock: { guest_cid: 7, uds_path: config.vsockPath },
      drives: [
        {
          drive_id: "rootfs",
          path_on_host: rootDiskPath,
          is_root_device: true,
          is_read_only: true,
        },
      ],
      "network-interfaces": [
        {
          iface_id: "net1",
          host_dev_name: "gtap0",
          guest_mac: "02:00:00:00:00:02",
        },
      ],
    });

    fs.rmSync(initrdPath);
    const withoutInitrd = __test.buildFirecrackerBootConfig(config);
    assert.equal(
      "initrd_path" in (withoutInitrd["boot-source"] as object),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.equal(bodies.join(""), '{"vcpu_count":1}\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("firecrackerRequest reuses an explicit keep-alive agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-fc-agent-"));
  const socketPath = path.join(dir, "api.sock");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let connections = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  server.on("connection", () => {
    connections += 1;
  });

  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await firecrackerRequest(socketPath, "PUT", "/machine-config", {}, agent);
    await firecrackerRequest(socketPath, "PUT", "/boot-source", {}, agent);
    assert.equal(connections, 1);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
