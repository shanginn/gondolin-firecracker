import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import crypto from "crypto";
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
  private apiAgent: http.Agent | null = null;
  private bootConfigPath: string | null = null;
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

    await firecrackerRequest(
      this.config.apiSocketPath,
      "PATCH",
      "/vm",
      { state: "Paused" },
      this.apiAgent ?? undefined,
    );
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
        this.apiAgent ?? undefined,
      );
    } finally {
      await firecrackerRequest(
        this.config.apiSocketPath,
        "PATCH",
        "/vm",
        { state: "Resumed" },
        this.apiAgent ?? undefined,
      ).catch(() => {});
    }
  }

  async start() {
    if (this.child) return;

    validateFirecrackerRuntimePreconditions(this.config);

    this.manualStop = false;
    this.setState("starting");
    this.emitStartupTiming("firecracker_start");
    const launchArgs = ["--api-sock", this.config.apiSocketPath];
    try {
      this.cleanupSockets();
      await waitForSocketPaths(
        firecrackerVsockChannelPaths(this.config.vsockPath),
      );
      this.emitStartupTiming("host_vsock_paths_ready");

      if (!this.config.snapshotLoad) {
        this.bootConfigPath = writeFirecrackerBootConfigFile(
          this.config.apiSocketPath,
          buildFirecrackerBootConfig(this.config),
        );
        launchArgs.push("--config-file", this.bootConfigPath);
        this.emitStartupTiming("firecracker_config_written");
      }
    } catch (err) {
      await this.close();
      throw err;
    }

    this.destroyApiAgent();
    this.apiAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    this.child = child_process.spawn(this.config.firecrackerPath, launchArgs, {
      stdio: [
        "ignore",
        this.config.console === "stdio" ? "pipe" : "ignore",
        "pipe",
      ],
    });
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
      this.destroyApiAgent();
      this.child = null;
      this.setState("stopped");
      this.emit("exit", { code: null, signal: null, error: err });
    });

    this.child.on("exit", (code, signal) => {
      this.cleanupSockets();
      this.destroyApiAgent();
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
          (async () => {
            await waitForApiSocket(this.config.apiSocketPath);
            this.emitStartupTiming("firecracker_api_ready");

            if (this.config.snapshotLoad) {
              await loadFirecrackerSnapshot(
                this.config,
                this.apiAgent ?? undefined,
              );
              this.emitStartupTiming("snapshot_loaded");
            } else {
              await waitForFirecrackerRunning(
                this.config.apiSocketPath,
                this.apiAgent ?? undefined,
              );
              this.cleanupBootConfig();
              this.emitStartupTiming("instance_started");
            }

            this.setState("running");
          })(),
          startupFailure,
        ]);
      } finally {
        cleanupStartupFailure();
      }
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close() {
    if (!this.child) {
      this.destroyApiAgent();
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
    this.destroyApiAgent();
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
    this.cleanupBootConfig();
  }

  private cleanupBootConfig() {
    if (!this.bootConfigPath) return;
    const configPath = this.bootConfigPath;
    this.bootConfigPath = null;
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // ignore
    }
  }

  private destroyApiAgent() {
    this.apiAgent?.destroy();
    this.apiAgent = null;
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
  const socketFields: Array<[socketPath: string, fieldName: string]> = [
    [config.apiSocketPath, "sandbox.firecrackerApiSocketPath"],
    [config.vsockPath, "sandbox.firecrackerVsockPath"],
    ...firecrackerVsockChannelPaths(config.vsockPath).map(
      (socketPath, idx): [string, string] => [
        socketPath,
        `sandbox.firecrackerVsockPath channel ${1024 + idx}`,
      ],
    ),
  ];

  const validatedParents = new Set<string>();
  for (const [socketPath, fieldName] of socketFields) {
    validateLinuxUnixSocketPath(socketPath, fieldName);
    const parent = path.dirname(socketPath);
    if (validatedParents.has(parent)) continue;
    validateSocketParent(socketPath, fieldName);
    validatedParents.add(parent);
  }
}

function writeFirecrackerBootConfigFile(
  apiSocketPath: string,
  config: Record<string, FirecrackerJson>,
): string {
  const contents = JSON.stringify(config);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const suffix = crypto.randomBytes(8).toString("hex");
    const configPath = `${apiSocketPath}.config.${process.pid}.${suffix}.json`;
    try {
      fs.writeFileSync(configPath, contents, { mode: 0o600, flag: "wx" });
      return configPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("Failed to create a unique Firecracker boot config file");
}

function buildFirecrackerBootConfig(
  config: FirecrackerConfig,
): Record<string, FirecrackerJson> {
  validateCpuCount(config.cpus);
  const bootSource: Record<string, FirecrackerJson> = {
    kernel_image_path: config.kernelPath,
    boot_args: config.append,
  };
  if (config.initrdPath && fs.existsSync(config.initrdPath)) {
    bootSource.initrd_path = config.initrdPath;
  }

  const result: Record<string, FirecrackerJson> = {
    "boot-source": bootSource,
    "machine-config": {
      vcpu_count: config.cpus,
      mem_size_mib: parseMemoryToMiB(config.memory),
    },
    vsock: {
      guest_cid: config.guestCid,
      uds_path: config.vsockPath,
    },
  };

  if (config.rootDiskPath) {
    result.drives = [
      {
        drive_id: "rootfs",
        path_on_host: config.rootDiskPath,
        is_root_device: true,
        is_read_only: config.rootDiskReadOnly ?? false,
      },
    ];
  }

  if (config.netTapName) {
    result["network-interfaces"] = [
      {
        iface_id: "net1",
        host_dev_name: config.netTapName,
        guest_mac: config.netMac ?? "02:00:00:00:00:01",
      },
    ];
  }

  return result;
}

async function loadFirecrackerSnapshot(
  config: FirecrackerConfig,
  agent?: http.Agent,
): Promise<void> {
  const snapshot = config.snapshotLoad;
  if (!snapshot) return;

  await firecrackerRequest(
    config.apiSocketPath,
    "PUT",
    "/snapshot/load",
    {
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
    },
    agent,
  );
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
  let retryDelayMs = 1;

  while (Date.now() <= deadline) {
    if (socketPaths.every((socketPath) => fs.existsSync(socketPath))) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(10, retryDelayMs * 2);
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

async function waitForFirecrackerRunning(
  socketPath: string,
  agent?: http.Agent,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "instance state unavailable";
  let retryDelayMs = 1;

  while (Date.now() <= deadline) {
    try {
      const body = await firecrackerRequest(
        socketPath,
        "GET",
        "/",
        undefined,
        agent,
      );
      const state = (JSON.parse(body) as { state?: unknown }).state;
      if (state === "Running") return;
      lastDetail = `instance state is ${String(state)}`;
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(10, retryDelayMs * 2);
  }

  throw new Error(`timed out waiting for Firecracker to run: ${lastDetail}`);
}

async function waitForApiSocket(
  socketPath: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let retryDelayMs = 1;

  while (Date.now() <= deadline) {
    try {
      await connectAndClose(socketPath);
      return;
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(25, retryDelayMs * 2);
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
  agent?: http.Agent,
): Promise<string> {
  const payload =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body) + "\n");

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: apiPath,
        agent: agent ?? false,
        timeout: 5000,
        headers: {
          Accept: "application/json",
          Connection: agent ? "keep-alive" : "close",
          "Content-Length": payload?.length ?? 0,
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          const responseBody =
            chunks.length === 0
              ? ""
              : chunks.length === 1
                ? chunks[0]!.toString("utf8")
                : Buffer.concat(chunks).toString("utf8");
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

/** @internal */
export const __test = {
  buildFirecrackerBootConfig,
  writeFirecrackerBootConfigFile,
};
