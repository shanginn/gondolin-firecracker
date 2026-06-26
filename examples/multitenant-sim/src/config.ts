import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Strategy = "cold" | "hot" | "warm-snapshot" | "hybrid";

export type SimConfig = {
  /** HTTP listen port */
  port: number;
  /** Tiny image directory */
  imagePath: string;
  /** Durable simulator state directory */
  workDir: string;
  /** VM lifecycle policy */
  strategy: Strategy;
  /** Logical user population */
  targetUsers: number;
  /** New queued tasks per `second` */
  arrivalRatePerSec: number;
  /** Maximum active VM slots */
  maxActiveVms: number;
  /** Concurrent boot or restore slots */
  bootConcurrency: number;
  /** Hot idle lifetime in `ms` */
  hotIdleTtlMs: number;
  /** Warm snapshot lifetime in `ms` */
  warmSnapshotTtlMs: number;
  /** Firecracker guest memory string */
  vmMemory: string;
  /** VM boot or restore timeout in `ms` */
  vmStartTimeoutMs: number;
  /** Synthetic guest CPU loop iterations */
  taskCpuIterations: number;
  /** Guest egress toggle */
  networkEnabled: boolean;
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../../..");

export function createDefaultConfig(
  env: Record<string, string | undefined> = process.env,
): SimConfig {
  return {
    port: intEnv(env.GONDOLIN_SIM_PORT, 8787, 1, 65535),
    imagePath: path.resolve(
      env.GONDOLIN_SIM_IMAGE ?? firstExistingTinyImage() ?? "guest/image/tiny",
    ),
    workDir: path.resolve(
      env.GONDOLIN_SIM_WORK_DIR ??
        path.join(os.tmpdir(), "gondolin-multitenant-sim"),
    ),
    strategy: parseStrategy(env.GONDOLIN_SIM_STRATEGY ?? "hybrid"),
    targetUsers: intEnv(env.GONDOLIN_SIM_USERS, 100, 1, 100000),
    arrivalRatePerSec: numEnv(env.GONDOLIN_SIM_RATE, 2, 0, 10000),
    maxActiveVms: intEnv(env.GONDOLIN_SIM_MAX_VMS, 8, 1, 100000),
    bootConcurrency: intEnv(env.GONDOLIN_SIM_BOOT_CONCURRENCY, 2, 1, 100000),
    hotIdleTtlMs: intEnv(env.GONDOLIN_SIM_HOT_TTL_MS, 30000, 0, 3600000),
    warmSnapshotTtlMs: intEnv(
      env.GONDOLIN_SIM_WARM_TTL_MS,
      15 * 60 * 1000,
      0,
      24 * 60 * 60 * 1000,
    ),
    vmMemory: env.GONDOLIN_SIM_MEMORY ?? "30M",
    vmStartTimeoutMs: intEnv(
      env.GONDOLIN_SIM_START_TIMEOUT_MS,
      30000,
      1,
      10 * 60 * 1000,
    ),
    taskCpuIterations: intEnv(
      env.GONDOLIN_SIM_TASK_ITERATIONS,
      20000,
      0,
      100000000,
    ),
    networkEnabled: boolEnv(env.GONDOLIN_SIM_NETWORK, true),
  };
}

export function applyConfigPatch(
  current: SimConfig,
  patch: Record<string, unknown>,
): SimConfig {
  const next = { ...current };

  if (typeof patch.imagePath === "string" && patch.imagePath.trim()) {
    next.imagePath = path.resolve(patch.imagePath.trim());
  }
  if (typeof patch.workDir === "string" && patch.workDir.trim()) {
    next.workDir = path.resolve(patch.workDir.trim());
  }
  if (typeof patch.strategy === "string") {
    next.strategy = parseStrategy(patch.strategy);
  }
  if (patch.targetUsers !== undefined) {
    next.targetUsers = boundedInt(patch.targetUsers, 1, 100000);
  }
  if (patch.arrivalRatePerSec !== undefined) {
    next.arrivalRatePerSec = boundedNumber(
      patch.arrivalRatePerSec,
      0,
      10000,
    );
  }
  if (patch.maxActiveVms !== undefined) {
    next.maxActiveVms = boundedInt(patch.maxActiveVms, 1, 100000);
  }
  if (patch.bootConcurrency !== undefined) {
    next.bootConcurrency = boundedInt(patch.bootConcurrency, 1, 100000);
  }
  if (patch.hotIdleTtlMs !== undefined) {
    next.hotIdleTtlMs = boundedInt(patch.hotIdleTtlMs, 0, 3600000);
  }
  if (patch.warmSnapshotTtlMs !== undefined) {
    next.warmSnapshotTtlMs = boundedInt(
      patch.warmSnapshotTtlMs,
      0,
      24 * 60 * 60 * 1000,
    );
  }
  if (typeof patch.vmMemory === "string" && patch.vmMemory.trim()) {
    next.vmMemory = patch.vmMemory.trim();
  }
  if (patch.vmStartTimeoutMs !== undefined) {
    next.vmStartTimeoutMs = boundedInt(
      patch.vmStartTimeoutMs,
      1,
      10 * 60 * 1000,
    );
  }
  if (patch.taskCpuIterations !== undefined) {
    next.taskCpuIterations = boundedInt(
      patch.taskCpuIterations,
      0,
      100000000,
    );
  }
  if (patch.networkEnabled !== undefined) {
    next.networkEnabled = Boolean(patch.networkEnabled);
  }

  return next;
}

export function parseStrategy(value: string): Strategy {
  if (
    value === "cold" ||
    value === "hot" ||
    value === "warm-snapshot" ||
    value === "hybrid"
  ) {
    return value;
  }
  throw new Error(`unknown strategy: ${value}`);
}

function firstExistingTinyImage(): string | null {
  for (const candidate of [
    path.join(repoRoot, "guest/image/tiny"),
    path.join(repoRoot, "guest/image/fast"),
    path.join(repoRoot, "guest/image/out"),
  ]) {
    if (fs.existsSync(path.join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  return null;
}

function intEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  return value === undefined ? fallback : boundedInt(value, min, max);
}

function numEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  return value === undefined ? fallback : boundedNumber(value, min, max);
}

function boolEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function boundedInt(value: unknown, min: number, max: number) {
  return Math.trunc(boundedNumber(value, min, max));
}

function boundedNumber(value: unknown, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${value}`);
  return Math.max(min, Math.min(max, n));
}
