import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
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

export type VfkitConfig = {
  /** vfkit binary path */
  vfkitPath: string;
  /** vfkit guest-to-host vsock base Unix socket path */
  vsockPath: string;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;
  /** root disk image path */
  rootDiskPath?: string;
  /** root disk image format */
  rootDiskFormat?: "raw";
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
};

export class VfkitController extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: SandboxState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private manualStop = false;
  private readonly config: VfkitConfig;

  constructor(config: VfkitConfig) {
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

  async start() {
    if (this.child) return;

    validateVfkitRuntimePreconditions(this.config);

    this.manualStop = false;
    this.setState("starting");
    this.emitStartupTiming("vfkit_start");

    const args = buildVfkitArgs(this.config);
    this.child = child_process.spawn(this.config.vfkitPath, args, {
      stdio: [
        "ignore",
        this.config.console === "stdio" ? "pipe" : "ignore",
        "pipe",
      ],
    });
    this.emitStartupTiming("vfkit_spawned");
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

    this.setState("running");
    this.emitStartupTiming("instance_started");
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
    for (const socketPath of vfkitVsockChannelPaths(this.config.vsockPath)) {
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

export function buildVfkitArgs(config: VfkitConfig): string[] {
  validateCpuCount(config.cpus);

  const args = [
    "--cpus",
    String(config.cpus),
    "--memory",
    String(parseMemoryToMiB(config.memory)),
    "--bootloader",
    [
      "linux",
      `kernel=${vfkitPathValue(config.kernelPath, "kernel path")}`,
      `initrd=${vfkitPathValue(config.initrdPath, "initrd path")}`,
      `cmdline=${quoteVfkitValue(config.append)}`,
    ].join(","),
  ];

  if (config.rootDiskPath) {
    if (config.rootDiskFormat && config.rootDiskFormat !== "raw") {
      throw new Error("vfkit backend only supports raw root disk images");
    }
    args.push(
      "--device",
      `virtio-blk,path=${vfkitPathValue(config.rootDiskPath, "root disk path")}`,
    );
  }

  for (const port of [1024, 1025, 1026, 1027]) {
    args.push(
      "--device",
      `virtio-vsock,port=${port},socketURL=${vfkitPathValue(
        `${config.vsockPath}_${port}`,
        `vsock channel ${port} path`,
      )}`,
    );
  }

  args.push("--device", "virtio-rng");

  if (config.console === "stdio") {
    args.push("--device", "virtio-serial,stdio");
  }

  return args;
}

function vfkitVsockChannelPaths(vsockPath: string): string[] {
  return [1024, 1025, 1026, 1027].map((port) => `${vsockPath}_${port}`);
}

function quoteVfkitValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function vfkitPathValue(value: string, label: string): string {
  if (value.includes(",")) {
    throw new Error(`vfkit ${label} cannot contain commas: ${value}`);
  }
  return value;
}

function validateVfkitRuntimePreconditions(config: VfkitConfig): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "vfkit backend requires macOS and is not supported on this host platform.",
    );
  }

  validateSocketParents(vfkitVsockChannelPaths(config.vsockPath));
}

function validateSocketParents(socketPaths: string[]): void {
  for (const socketPath of socketPaths) {
    const parent = path.dirname(socketPath);
    if (!fs.existsSync(parent)) {
      throw new Error(`vfkit socket parent directory does not exist: ${parent}`);
    }
  }
}

function validateCpuCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error(`invalid vm cpu count for vfkit backend: ${value}`);
  }
}

function parseMemoryToMiB(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)([kKmMgGtT]?)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid vm memory value for vfkit backend: ${JSON.stringify(value)}`,
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
    throw new Error(`vm memory is too large for vfkit backend: ${value}`);
  }

  return mib;
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(true);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function killChild(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (child.pid && !child.killed) {
      process.kill(child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // ignore
  }
}

export const __test = {
  buildVfkitArgs,
};
