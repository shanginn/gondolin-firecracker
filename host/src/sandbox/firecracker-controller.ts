import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";

import type { SandboxLogStream, SandboxState } from "./state.ts";

const activeChildren = new Set<ChildProcess>();
let exitHookRegistered = false;

function killActiveChildren() {
  for (const child of activeChildren) {
    killChild(child, "SIGKILL");
  }
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    killActiveChildren();
  });
}

function trackChild(child: ChildProcess) {
  registerExitHook();
  activeChildren.add(child);
  const cleanup = () => {
    activeChildren.delete(child);
  };
  child.once("exit", cleanup);
  child.once("error", cleanup);
}

export type FirecrackerConfig = {
  /** firecracker binary path */
  firecrackerPath: string;
  /** firecracker API socket path */
  apiSocketPath: string;
  /** firecracker vsock base Unix socket path */
  vsockPath: string;
  /** guest vsock CID */
  guestCid: number;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;
  /** root disk image path */
  rootDiskPath?: string;
  /** root disk image format */
  rootDiskFormat?: "raw";
  /** readonly mode for the root disk */
  rootDiskReadOnly?: boolean;
  /** vm memory size (e.g. "1G") */
  memory: string;
  /** vm cpu count */
  cpus: number;
  /** kernel cmdline append string */
  append: string;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
  /** host TAP interface name for mediated egress */
  netTapName?: string;
  /** guest mac address */
  netMac?: string;
  /** snapshot state loaded instead of cold boot configuration */
  snapshotLoad?: FirecrackerSnapshotLoadConfig;
};

export type FirecrackerSnapshotLoadConfig = {
  /** microVM state snapshot path */
  snapshotPath: string;
  /** guest memory snapshot path */
  memPath: string;
};

type FirecrackerJson =
  | null
  | boolean
  | number
  | string
  | FirecrackerJson[]
  | {
      [key: string]: FirecrackerJson;
    };

export class FirecrackerController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;
  private readonly config: FirecrackerConfig;

  constructor(config: FirecrackerConfig) {
    super();
    this.config = config;
  }

  setAppend(append: string) {
    this.config.append = append;
  }

  getState() {
    return this.state;
  }

  getHostPid(): number | null {
    return this.child?.pid ?? null;
  }

  async createSnapshot(snapshotPath: string, memPath: string): Promise<void> {
    if (!this.child || this.state !== "running") {
      throw new Error("Firecracker snapshot requires a running VM");
    }

    await firecrackerRequest(this.config.apiSocketPath, "PATCH", "/vm", {
      state: "Paused",
    });
    try {
      await firecrackerRequest(
        this.config.apiSocketPath,
        "PUT",
        "/snapshot/create",
        {
          snapshot_type: "Full",
          snapshot_path: snapshotPath,
          mem_file_path: memPath,
        },
      );
    } finally {
      await firecrackerRequest(this.config.apiSocketPath, "PATCH", "/vm", {
        state: "Resumed",
      }).catch(() => {});
    }
  }

  async start() {
    if (this.child) return;

    validateFirecrackerRuntimePreconditions(this.config);

    this.manualStop = false;
    this.setState("starting");
    this.emitStartupTiming("firecracker_start");
    this.cleanupSockets();

    this.child = child_process.spawn(
      this.config.firecrackerPath,
      ["--api-sock", this.config.apiSocketPath],
      {
        stdio: [
          "ignore",
          this.config.console === "stdio" ? "pipe" : "ignore",
          "pipe",
        ],
      },
    );
    this.emitStartupTiming("firecracker_spawned");
    trackChild(this.child);

    this.child.stdout?.on("data", (chunk) => {
      this.emit("log", chunk.toString(), "stdout" satisfies SandboxLogStream);
    });

    this.child.stderr?.on("data", (chunk) => {
      this.emit("log", chunk.toString(), "stderr" satisfies SandboxLogStream);
    });

    this.child.on("error", (err) => {
      this.cleanupSockets();
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code: null, signal: null, error: err });
    });

    this.child.on("exit", (code, signal) => {
      this.cleanupSockets();
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code, signal });
      if (this.manualStop) {
        this.manualStop = false;
        return;
      }
      if (this.config.autoRestart) {
        this.scheduleRestart();
      }
    });

    let cleanupStartupFailure = () => {};
    const startupFailure = new Promise<never>((_, reject) => {
      const child = this.child;
      if (!child) return;
      const onError = (err: Error) => reject(err);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail =
          code !== null
            ? `code=${code}`
            : signal
              ? `signal=${signal}`
              : "no exit status";
        reject(
          new Error(`Firecracker exited before startup completed (${detail})`),
        );
      };
      child.once("error", onError);
      child.once("exit", onExit);
      cleanupStartupFailure = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
    });

    try {
      try {
        await Promise.race([
          waitForApiSocket(this.config.apiSocketPath),
          startupFailure,
        ]);
      } finally {
        cleanupStartupFailure();
      }
      this.emitStartupTiming("firecracker_api_ready");

      if (this.config.snapshotLoad) {
        this.setState("running");
        await waitForSocketPaths(
          firecrackerVsockChannelPaths(this.config.vsockPath),
        );
        this.emitStartupTiming("host_vsock_paths_ready");
        await loadFirecrackerSnapshot(this.config);
        this.emitStartupTiming("snapshot_loaded");
        return;
      }

      await configureFirecracker(this.config);
      this.emitStartupTiming("firecracker_configured");

      // Let SandboxServer create the host Unix listeners that Firecracker will
      // target for guest-initiated vsock connections before the guest boots.
      this.setState("running");
      await waitForSocketPaths(
        firecrackerVsockChannelPaths(this.config.vsockPath),
      );
      this.emitStartupTiming("host_vsock_paths_ready");

      await firecrackerRequest(this.config.apiSocketPath, "PUT", "/actions", {
        action_type: "InstanceStart",
      });
      this.emitStartupTiming("instance_started");
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close() {
    if (!this.child) {
      this.cleanupSockets();
      this.setState("stopped");
      return;
    }
    const child = this.child;
    this.child = null;
    this.manualStop = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const waitForExit = waitForChildExit(child, 10_000);
    killChild(child, "SIGTERM");

    const sigkillTimer = setTimeout(() => {
      killChild(child, "SIGKILL");
    }, 3000);

    let exited = false;
    try {
      exited = await waitForExit;
    } finally {
      clearTimeout(sigkillTimer);
    }

    if (!exited) {
      killChild(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      killActiveChildren();
    }

    this.cleanupSockets();
    this.setState("stopped");
  }

  async restart() {
    await this.close();
    await this.start();
  }

  private scheduleRestart() {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 1000);
  }

  private cleanupSockets() {
    for (const socketPath of [
      this.config.apiSocketPath,
      this.config.vsockPath,
    ]) {
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  private setState(state: SandboxState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  private emitStartupTiming(name: string) {
    this.emit("startup-timing", name);
  }
}

function firecrackerVsockChannelPaths(vsockPath: string): string[] {
  return [
    `${vsockPath}_1024`,
    `${vsockPath}_1025`,
    `${vsockPath}_1026`,
    `${vsockPath}_1027`,
  ];
}

const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;

function validateLinuxUnixSocketPath(
  socketPath: string,
  fieldName: string,
): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes <= LINUX_UNIX_SOCKET_PATH_MAX_BYTES) return;

  throw new Error(
    `${fieldName} is too long for a Linux Unix socket path ` +
      `(${bytes} bytes, max ${LINUX_UNIX_SOCKET_PATH_MAX_BYTES}). ` +
      "Set GONDOLIN_RUNTIME_DIR to a short writable directory such as /run/gondolin, " +
      "or provide explicit Firecracker socket paths.",
  );
}

function validateSocketParent(socketPath: string, fieldName: string): void {
  const parentDir = path.dirname(socketPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
    fs.accessSync(
      parentDir,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    );
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(
      `${fieldName} parent directory is not writable (${parentDir})${detail}`,
    );
  }
}

function validateKvmDevice(): void {
  const kvmPath = "/dev/kvm";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(kvmPath);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(
      "Firecracker backend requires /dev/kvm, but it is not available" +
        `${detail}. In Kubernetes, expose /dev/kvm with a KVM device plugin ` +
        "or a privileged pod on a node with hardware virtualization enabled.",
    );
  }

  if (!stat.isCharacterDevice()) {
    throw new Error(
      "Firecracker backend requires /dev/kvm to be a character device. " +
        "Check the Kubernetes device mount and node configuration.",
    );
  }

  try {
    fs.accessSync(kvmPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(
      "Firecracker backend requires read/write access to /dev/kvm" +
        `${detail}. In Kubernetes, grant the pod KVM device-cgroup access ` +
        "via a device plugin or privileged securityContext.",
    );
  }
}

function validateFirecrackerRuntimePreconditions(
  config: FirecrackerConfig,
): void {
  if (process.platform !== "linux") {
    throw new Error(
      "Firecracker backend requires Linux/KVM and is not supported on this host platform.",
    );
  }

  validateKvmDevice();
  validateLinuxUnixSocketPath(
    config.apiSocketPath,
    "sandbox.firecrackerApiSocketPath",
  );
  validateLinuxUnixSocketPath(config.vsockPath, "sandbox.firecrackerVsockPath");
  validateSocketParent(
    config.apiSocketPath,
    "sandbox.firecrackerApiSocketPath",
  );
  validateSocketParent(config.vsockPath, "sandbox.firecrackerVsockPath");

  for (const [idx, socketPath] of firecrackerVsockChannelPaths(
    config.vsockPath,
  ).entries()) {
    const port = 1024 + idx;
    validateLinuxUnixSocketPath(
      socketPath,
      `sandbox.firecrackerVsockPath channel ${port}`,
    );
    validateSocketParent(
      socketPath,
      `sandbox.firecrackerVsockPath channel ${port}`,
    );
  }
}

async function configureFirecracker(config: FirecrackerConfig): Promise<void> {
  validateCpuCount(config.cpus);
  await firecrackerRequest(config.apiSocketPath, "PUT", "/machine-config", {
    vcpu_count: config.cpus,
    mem_size_mib: parseMemoryToMiB(config.memory),
  });

  const bootSource: Record<string, FirecrackerJson> = {
    kernel_image_path: config.kernelPath,
    boot_args: config.append,
  };
  if (config.initrdPath && fs.existsSync(config.initrdPath)) {
    bootSource.initrd_path = config.initrdPath;
  }
  await firecrackerRequest(
    config.apiSocketPath,
    "PUT",
    "/boot-source",
    bootSource,
  );

  if (config.rootDiskPath) {
    await firecrackerRequest(config.apiSocketPath, "PUT", "/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: config.rootDiskPath,
      is_root_device: true,
      is_read_only: config.rootDiskReadOnly ?? false,
    });
  }

  await firecrackerRequest(config.apiSocketPath, "PUT", "/vsock", {
    guest_cid: config.guestCid,
    uds_path: config.vsockPath,
  });

  if (config.netTapName) {
    await firecrackerRequest(
      config.apiSocketPath,
      "PUT",
      "/network-interfaces/net1",
      {
        iface_id: "net1",
        host_dev_name: config.netTapName,
        guest_mac: config.netMac ?? "02:00:00:00:00:01",
      },
    );
  }
}

async function loadFirecrackerSnapshot(
  config: FirecrackerConfig,
): Promise<void> {
  const snapshot = config.snapshotLoad;
  if (!snapshot) return;

  await firecrackerRequest(config.apiSocketPath, "PUT", "/snapshot/load", {
    snapshot_path: snapshot.snapshotPath,
    mem_file_path: snapshot.memPath,
    resume_vm: true,
    vsock_override: {
      uds_path: config.vsockPath,
    },
    ...(config.netTapName
      ? {
          network_overrides: [
            {
              iface_id: "net1",
              host_dev_name: config.netTapName,
            },
          ],
        }
      : {}),
  });
}

function validateCpuCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error(`invalid vm cpu count for Firecracker backend: ${value}`);
  }
}

async function waitForSocketPaths(
  socketPaths: string[],
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (socketPaths.every((socketPath) => fs.existsSync(socketPath))) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  const missing = socketPaths.filter(
    (socketPath) => !fs.existsSync(socketPath),
  );
  throw new Error(
    `timed out waiting for Firecracker vsock bridge sockets: ${missing.join(", ")}`,
  );
}

function parseMemoryToMiB(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)([kKmMgGtT]?)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid vm memory value for Firecracker backend: ${JSON.stringify(value)}`,
    );
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();

  let bytes = amount;
  if (unit === "K") bytes *= 1024;
  else if (unit === "M" || unit === "") bytes *= 1024 * 1024;
  else if (unit === "G") bytes *= 1024 * 1024 * 1024;
  else if (unit === "T") bytes *= 1024 * 1024 * 1024 * 1024;

  const mib = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
  if (!Number.isSafeInteger(mib) || mib > 0xffffffff) {
    throw new Error(`vm memory is too large for Firecracker backend: ${value}`);
  }

  return mib;
}

async function waitForApiSocket(
  socketPath: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() <= deadline) {
    try {
      await connectAndClose(socketPath);
      return;
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for Firecracker API socket${detail}`);
}

function connectAndClose(socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

export function firecrackerRequest(
  socketPath: string,
  method: "PUT" | "GET" | "PATCH",
  apiPath: string,
  body?: FirecrackerJson,
): Promise<string> {
  const payload =
    body === undefined ? undefined : JSON.stringify(body, null, 2) + "\n";

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: apiPath,
        agent: false,
        timeout: 5000,
        headers: {
          Accept: "application/json",
          Connection: "close",
          "Content-Length": Buffer.byteLength(payload ?? ""),
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(responseBody);
            return;
          }

          const trimmed = responseBody.trim();
          reject(
            new Error(
              `Firecracker API ${method} ${apiPath} failed with HTTP ${status || "?"}` +
                (trimmed ? `: ${trimmed}` : ""),
            ),
          );
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Firecracker API ${method} ${apiPath} timed out`));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("error", onExit);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.once("error", onExit);
    child.once("exit", onExit);
  });
}
