import { performance } from "node:perf_hooks";

import type { SimulatorConfig } from "./config.ts";

export type SimUserDescriptor = {
  /** User id shown in metrics */
  id: string;
  /** Dashboard display name */
  name: string;
  /** Behavior profile label */
  profileLabel: string;
};

export type MessageResult = {
  /** End-to-end message latency in `ms` */
  latencyMs: number;
  /** Small backend response summary */
  summary: string;
  /** Host process id when available */
  hostPid: number | null;
};

export type SessionHandle = {
  /** Backend session id */
  id: string;
  sendMessage(input: string, signal?: AbortSignal): Promise<MessageResult>;
  close(): Promise<void>;
};

export type SessionBackend = {
  /** Backend mode label */
  kind: string;
  start(user: SimUserDescriptor): Promise<SessionHandle>;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeMockBackend(): SessionBackend {
  return {
    kind: "mock",
    async start(user: SimUserDescriptor): Promise<SessionHandle> {
      await sleep(20 + Math.random() * 80);
      return {
        id: `mock-${user.id}`,
        async sendMessage(input: string, signal?: AbortSignal) {
          const start = performance.now();
          const delay = 40 + Math.min(700, input.length * 8) + Math.random() * 180;
          await sleep(delay, signal);
          return {
            latencyMs: performance.now() - start,
            summary: `mock ${input.length} bytes`,
            hostPid: null,
          };
        },
        async close() {
          await sleep(5);
        },
      };
    },
  };
}

type GondolinModule = {
  VM: {
    create(options: Record<string, unknown>): Promise<GondolinVm>;
  };
  MemoryProvider: new () => unknown;
};

type GondolinVm = {
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
  };
  exec(
    command: string[],
    options?: Record<string, unknown>,
  ): {
    result: Promise<{ ok: boolean; stdout: string; stderr: string }>;
  };
  getHostPid(): number | null;
  close(): Promise<void>;
};

async function makeGondolinBackend(
  config: SimulatorConfig,
): Promise<SessionBackend> {
  const mod = (await import("@earendil-works/gondolin")) as GondolinModule;

  return {
    kind: "gondolin",
    async start(user: SimUserDescriptor): Promise<SessionHandle> {
      const sandbox: Record<string, unknown> = {
        console: "none",
        netEnabled: config.vmNetEnabled,
      };
      if (config.vmImage) {
        sandbox.imagePath = config.vmImage;
      }

      const vm = await mod.VM.create({
        sessionLabel: `sim ${user.name} ${user.profileLabel}`,
        memory: config.vmMemory,
        cpus: config.vmCpus,
        startTimeoutMs: config.vmStartTimeoutMs,
        rootfs: { mode: config.vmRootfsMode },
        sandbox,
        vfs: {
          mounts: {
            "/workspace": new mod.MemoryProvider(),
          },
        },
      });
      const workspace = `/workspace/users/${user.id}`;
      await vm.fs.mkdir(workspace, { recursive: true });

      return {
        id: `vm-${user.id}`,
        async sendMessage(input: string, signal?: AbortSignal) {
          const start = performance.now();
          const messagePath = `${workspace}/last-message.txt`;
          await vm.fs.writeFile(messagePath, input);
          const cpuKiB = Math.max(0, Math.trunc(config.vmCpuWorkKiB));
          const script = [
            "set -eu",
            `bytes=$(wc -c < ${shellQuote(messagePath)})`,
            `head -c ${cpuKiB * 1024} /dev/zero | sha256sum >/dev/null`,
            'printf "bytes=%s work_kib=%s\\n" "$bytes" ' + shellQuote(String(cpuKiB)),
          ].join("; ");
          const result = await vm.exec(["/bin/bash", "-lc", script], {
            signal,
            stdout: "pipe",
            stderr: "pipe",
          }).result;
          if (!result.ok) {
            throw new Error(result.stderr.trim() || "message command failed");
          }
          return {
            latencyMs: performance.now() - start,
            summary: result.stdout.trim(),
            hostPid: vm.getHostPid(),
          };
        },
        async close() {
          await vm.close();
        },
      };
    },
  };
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function createSessionBackend(
  config: SimulatorConfig,
): Promise<SessionBackend> {
  if (config.backend === "gondolin") return makeGondolinBackend(config);
  return makeMockBackend();
}
