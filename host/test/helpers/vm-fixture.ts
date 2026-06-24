import fs from "fs";
import { execFileSync } from "child_process";

import { VM, type VMOptions } from "../../src/vm/core.ts";

/** Check whether Linux KVM is available for Firecracker. */
export function hasHardwareAccel(): boolean {
  if (process.platform !== "linux") return false;
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether VM tests should be skipped (no hardware acceleration available).
 * Can be overridden by setting GONDOLIN_FORCE_VM_TESTS=1.
 */
export function shouldSkipVmTests(): boolean {
  if (process.env.GONDOLIN_FORCE_VM_TESTS === "1") {
    return false;
  }
  return !hasHardwareAccel();
}

/** Resolve a runnable Firecracker binary path for integration tests. */
export function resolveFirecrackerPath(): string | null {
  const envPath = process.env.GONDOLIN_FIRECRACKER?.trim();
  const candidates = [envPath, "firecracker"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

/** Return a skip reason for Firecracker VM integration tests or false when runnable. */
export function shouldSkipFirecrackerVmTests(): string | false {
  if (process.platform !== "linux") {
    return "Firecracker requires Linux/KVM";
  }
  if (shouldSkipVmTests()) {
    return "hardware virtualization unavailable";
  }

  const firecrackerPath = resolveFirecrackerPath();
  if (!firecrackerPath) {
    return "Firecracker binary unavailable (install firecracker or set GONDOLIN_FIRECRACKER)";
  }

  return false;
}

let firecrackerRuntimeSkipCheck: Promise<string | false> | null = null;

const firecrackerPrecheckTimeoutMs = Math.max(
  1,
  Number(process.env.GONDOLIN_FIRECRACKER_PRECHECK_TIMEOUT_MS ?? 30000),
);

/** Probe whether Firecracker can actually boot/exec on this host. */
export async function getFirecrackerRuntimeSkipReason(): Promise<string | false> {
  const staticReason = shouldSkipFirecrackerVmTests();
  if (staticReason) {
    return staticReason;
  }

  if (!firecrackerRuntimeSkipCheck) {
    firecrackerRuntimeSkipCheck = (async () => {
      let vm: VM | null = null;
      try {
        vm = await VM.create({
          startTimeoutMs: firecrackerPrecheckTimeoutMs,
          sandbox: {
            firecrackerPath: resolveFirecrackerPath() ?? undefined,
            netEnabled: false,
            console: "none",
          },
        });

        await vm.start();
        const probe = await vm.exec(["/bin/sh", "-lc", "echo preflight-ok"]);
        if (probe.exitCode !== 0) {
          return `Firecracker runtime preflight exec failed (exit ${probe.exitCode})`;
        }
        return false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Firecracker runtime unavailable: ${message}`;
      } finally {
        if (vm) {
          await closeWithTimeout(vm);
        }
      }
    })();
  }

  return await firecrackerRuntimeSkipCheck;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private count: number;

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.count += 1;
  }
}

type VmEntry = {
  vm: VM;
  semaphore: Semaphore;
};

const pool = new Map<string, VmEntry>();
const pending = new Map<string, Promise<VmEntry>>();

async function getEntry(key: string, options: VMOptions): Promise<VmEntry> {
  const existing = pool.get(key);
  if (existing) {
    return existing;
  }

  const inFlight = pending.get(key);
  if (inFlight) {
    return inFlight;
  }

  const created = (async () => {
    try {
      const vm = await VM.create(options);
      const entry = { vm, semaphore: new Semaphore(1) };
      pool.set(key, entry);
      return entry;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, created);
  return created;
}

export async function withVm<T>(
  key: string,
  options: VMOptions,
  fn: (vm: VM) => Promise<T>,
): Promise<T> {
  const entry = await getEntry(key, options);
  await entry.semaphore.acquire();
  try {
    return await fn(entry.vm);
  } finally {
    entry.semaphore.release();
  }
}

/** Try to close a VM, giving up after {@link ms} milliseconds. */
async function closeWithTimeout(vm: VM, ms = 5000): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      vm.close(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function closeVm(key: string): Promise<void> {
  const entry = pool.get(key);
  if (entry) {
    pool.delete(key);
    pending.delete(key);
    await closeWithTimeout(entry.vm);
    return;
  }

  // VM.create() may still be in-flight (e.g. booting). Wait briefly for
  // it to resolve so we can close the underlying process; otherwise the child
  // keeps node alive forever.
  const inflight = pending.get(key);
  pending.delete(key);
  if (inflight) {
    let timeout: NodeJS.Timeout | null = null;
    try {
      const created = await Promise.race([
        inflight,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 5000);
        }),
      ]);
      if (created) {
        await closeWithTimeout(created.vm);
      }
    } catch {
      // VM.create() itself failed — nothing to clean up
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

/**
 * Schedule a hard process.exit() as a safety net.  If vm.close() fails to
 * kill the Firecracker child, the orphaned process keeps node alive via its
 * stdio pipes. Calling process.exit() triggers process exit cleanup.
 *
 * The timer is unref'd so it does not *itself* keep node alive — it only
 * fires when something else is holding the event loop open.
 *
 * Each call refreshes the deadline so early-finishing files don't force-exit
 * while later tests are still running.
 */
let forceExitTimer: NodeJS.Timeout | null = null;

export function scheduleForceExit(ms = 120000): void {
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
  }

  forceExitTimer = setTimeout(() => {
    console.error("[vm-fixture] force-exiting — VM cleanup timed out");
    process.exit(1);
  }, ms);
  forceExitTimer.unref();
}
