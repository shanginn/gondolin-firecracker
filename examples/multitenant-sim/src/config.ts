export type SimulatorBackend = "mock" | "gondolin";

export type RootfsMode = "readonly" | "cow" | "memory";

export type SimulatorConfig = {
  /** HTTP listen host */
  host: string;
  /** HTTP listen port */
  port: number;
  /** Session implementation */
  backend: SimulatorBackend;
  /** Initial traffic switch state */
  pausedOnStart: boolean;
  /** Deterministic random seed */
  seed: string;
  /** Maximum active user records */
  maxActiveUsers: number;
  /** Maximum concurrently running or starting VMs */
  maxActiveVms: number;
  /** Initial active user target */
  targetUsers: number;
  /** Initial arrivals per `minute` */
  spawnRatePerMinute: number;
  /** Maximum arrivals per `minute` */
  maxSpawnRatePerMinute: number;
  /** Initial profile tempo multiplier */
  tempo: number;
  /** Maximum profile tempo multiplier */
  maxTempo: number;
  /** VM memory size string */
  vmMemory: string;
  /** VM CPU count */
  vmCpus: number;
  /** VM rootfs write mode */
  vmRootfsMode: RootfsMode;
  /** VM image selector or asset directory */
  vmImage: string | null;
  /** Whether to enable mediated guest networking */
  vmNetEnabled: boolean;
  /** VM startup timeout in `ms` */
  vmStartTimeoutMs: number;
  /** Per-message synthetic CPU work in `KiB` */
  vmCpuWorkKiB: number;
  /** Per-session lifetime cap in `ms` */
  maxUserLifetimeMs: number;
  /** Automatic pause threshold for VM boot failures */
  bootFailurePauseThreshold: number;
};

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_ACTIVE_USERS = 24;
const DEFAULT_MAX_ACTIVE_VMS = 8;
const DEFAULT_TARGET_USERS = 6;
const DEFAULT_SPAWN_RATE_PER_MINUTE = 6;
const DEFAULT_MAX_SPAWN_RATE_PER_MINUTE = 60;
const DEFAULT_TEMPO = 1;
const DEFAULT_MAX_TEMPO = 8;
const DEFAULT_VM_START_TIMEOUT_MS = 120_000;
const DEFAULT_VM_CPU_WORK_KIB = 64;
const DEFAULT_MAX_USER_LIFETIME_MS = 15 * 60_000;
const DEFAULT_BOOT_FAILURE_PAUSE_THRESHOLD = 3;

function readString(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function readOptionalString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, parsed));
}

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, parsed));
}

function readBackend(env: NodeJS.ProcessEnv): SimulatorBackend {
  const raw = env.SIM_BACKEND?.trim().toLowerCase();
  if (raw === "mock" || raw === "gondolin") return raw;
  return "mock";
}

function readRootfsMode(env: NodeJS.ProcessEnv): RootfsMode {
  const raw = env.SIM_VM_ROOTFS_MODE?.trim().toLowerCase();
  if (raw === "readonly" || raw === "cow" || raw === "memory") return raw;
  return "readonly";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readSimulatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): SimulatorConfig {
  const maxActiveUsers = readInteger(
    env,
    "SIM_MAX_ACTIVE_USERS",
    DEFAULT_MAX_ACTIVE_USERS,
    { min: 1, max: 1000 },
  );
  const maxActiveVms = readInteger(
    env,
    "SIM_MAX_ACTIVE_VMS",
    Math.min(DEFAULT_MAX_ACTIVE_VMS, maxActiveUsers),
    { min: 1, max: maxActiveUsers },
  );
  const maxSpawnRatePerMinute = readInteger(
    env,
    "SIM_MAX_SPAWN_RATE_PER_MINUTE",
    DEFAULT_MAX_SPAWN_RATE_PER_MINUTE,
    { min: 1, max: 10_000 },
  );
  const maxTempo = readNumber(env, "SIM_MAX_TEMPO", DEFAULT_MAX_TEMPO, {
    min: 0.1,
    max: 100,
  });

  return {
    host: readString(env, "HOST", "0.0.0.0"),
    port: readInteger(env, "PORT", DEFAULT_PORT, { min: 1, max: 65_535 }),
    backend: readBackend(env),
    pausedOnStart: readBoolean(env, "SIM_PAUSED_ON_START", true),
    seed: readString(env, "SIM_SEED", String(Date.now())),
    maxActiveUsers,
    maxActiveVms,
    targetUsers: readInteger(env, "SIM_TARGET_USERS", DEFAULT_TARGET_USERS, {
      min: 0,
      max: maxActiveUsers,
    }),
    spawnRatePerMinute: readNumber(
      env,
      "SIM_SPAWN_RATE_PER_MINUTE",
      DEFAULT_SPAWN_RATE_PER_MINUTE,
      { min: 0, max: maxSpawnRatePerMinute },
    ),
    maxSpawnRatePerMinute,
    tempo: readNumber(env, "SIM_TEMPO", DEFAULT_TEMPO, {
      min: 0.1,
      max: maxTempo,
    }),
    maxTempo,
    vmMemory: readString(env, "SIM_VM_MEMORY", "84M"),
    vmCpus: readInteger(env, "SIM_VM_CPUS", 1, { min: 1, max: 64 }),
    vmRootfsMode: readRootfsMode(env),
    vmImage: readOptionalString(env, "SIM_VM_IMAGE"),
    vmNetEnabled: readBoolean(env, "SIM_VM_NET_ENABLED", false),
    vmStartTimeoutMs: readInteger(
      env,
      "SIM_VM_START_TIMEOUT_MS",
      DEFAULT_VM_START_TIMEOUT_MS,
      { min: 1_000, max: 20 * 60_000 },
    ),
    vmCpuWorkKiB: readInteger(
      env,
      "SIM_VM_CPU_WORK_KIB",
      DEFAULT_VM_CPU_WORK_KIB,
      { min: 0, max: 1024 * 1024 },
    ),
    maxUserLifetimeMs: readInteger(
      env,
      "SIM_MAX_USER_LIFETIME_MS",
      DEFAULT_MAX_USER_LIFETIME_MS,
      { min: 1_000, max: 24 * 60 * 60_000 },
    ),
    bootFailurePauseThreshold: readInteger(
      env,
      "SIM_BOOT_FAILURE_PAUSE_THRESHOLD",
      DEFAULT_BOOT_FAILURE_PAUSE_THRESHOLD,
      { min: 1, max: 100 },
    ),
  };
}
