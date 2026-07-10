/**
 * Measure VM startup and exec latency.
 *
 * Run with:
 *   node host/examples/backend-benchmark.ts --runs 5 --iterations 20
 */

import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { VM } from "../src/vm/core.ts";
import type { RootfsMode } from "../src/build/config.ts";
import type { SandboxVmm } from "../src/sandbox/server-options.ts";

const execFileAsync = promisify(execFile);

type CliOptions = {
  iterations: number;
  runs: number;
  vmm: SandboxVmm;
  image?: string;
  memory?: string;
  rootfsMode?: RootfsMode;
  vfs: boolean;
};

function parseOptions(argv: string[]): CliOptions {
  let iterations = 20;
  let runs = 1;
  let vmm: SandboxVmm = "firecracker";
  let image: string | undefined;
  let memory: string | undefined;
  let rootfsMode: RootfsMode | undefined;
  let vfs = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--iterations" && argv[i + 1]) {
      iterations = parsePositiveInteger(argv[i + 1], "--iterations");
      i += 1;
      continue;
    }
    if (arg === "--runs" && argv[i + 1]) {
      runs = parsePositiveInteger(argv[i + 1], "--runs");
      i += 1;
      continue;
    }
    if (arg === "--vmm" && argv[i + 1]) {
      const value = argv[i + 1];
      if (value !== "firecracker" && value !== "vfkit") {
        throw new Error("--vmm must be firecracker or vfkit");
      }
      vmm = value;
      i += 1;
      continue;
    }
    if (arg === "--image" && argv[i + 1]) {
      image = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--memory" && argv[i + 1]) {
      memory = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--rootfs-mode" && argv[i + 1]) {
      const value = argv[i + 1];
      if (value !== "readonly" && value !== "memory" && value !== "cow") {
        throw new Error("--rootfs-mode must be readonly, memory, or cow");
      }
      rootfsMode = value;
      i += 1;
      continue;
    }
    if (arg === "--no-vfs") {
      vfs = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { iterations, runs, vmm, image, memory, rootfsMode, vfs };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: node host/examples/backend-benchmark.ts [options]

Options:
  --iterations N  Warm exec iterations
  --runs N        Fresh VM runs used for cold-start medians
  --vmm NAME      VM backend: firecracker|vfkit
  --image IMAGE   Guest image directory, build id, or name:tag
  --memory SIZE   Guest memory size
  --rootfs-mode MODE  Root disk mode: readonly|memory|cow
  --no-vfs        Disable guest VFS integration
`);
}

async function measure<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)]!;
}

async function processStats(pid: number | null): Promise<{
  rssKb: number | null;
  vszKb: number | null;
}> {
  if (!pid) {
    return { rssKb: null, vszKb: null };
  }

  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "rss=,vsz=",
      "-p",
      String(pid),
    ]);
    const [rss, vsz] = stdout.trim().split(/\s+/).map(Number);
    return {
      rssKb: Number.isFinite(rss) ? rss : null,
      vszKb: Number.isFinite(vsz) ? vsz : null,
    };
  } catch {
    return { rssKb: null, vszKb: null };
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const measurements: Array<{
    createMs: number;
    startMs: number;
    coldExecMs: number;
    coldTotalMs: number;
    warmMs: number[];
    rssAfterStartKb: number | null;
    rssAfterWarmKb: number | null;
    vszAfterStartKb: number | null;
    vszAfterWarmKb: number | null;
    closeMs: number;
    startupTimings: ReturnType<VM["getStartupTimings"]>;
  }> = [];

  for (let run = 0; run < options.runs; run += 1) {
    let vm: VM | null = null;
    try {
      const create = await measure(async () =>
        VM.create({
          sessionLabel: `gondolin ${options.vmm} benchmark`,
          memory: options.memory,
          rootfs: options.rootfsMode ? { mode: options.rootfsMode } : undefined,
          vfs: options.vfs ? undefined : null,
          sandbox: {
            vmm: options.vmm,
            imagePath: options.image,
            console: "none",
            netEnabled: false,
          },
        }),
      );
      vm = create.value;

      const start = await measure(() => vm!.start());
      const afterStart = await processStats(vm.getHostPid());
      const coldExec = await measure(() => vm!.exec(["/bin/true"]).result);

      const warmMs: number[] = [];
      for (let i = 0; i < options.iterations; i += 1) {
        const result = await measure(() => vm!.exec(["/bin/true"]).result);
        warmMs.push(result.ms);
      }

      const afterWarm = await processStats(vm.getHostPid());
      const startupTimings = vm.getStartupTimings();
      const close = await measure(() => vm!.close());
      vm = null;
      measurements.push({
        createMs: create.ms,
        startMs: start.ms,
        coldExecMs: coldExec.ms,
        coldTotalMs: create.ms + start.ms + coldExec.ms,
        warmMs,
        rssAfterStartKb: afterStart.rssKb,
        rssAfterWarmKb: afterWarm.rssKb,
        vszAfterStartKb: afterStart.vszKb,
        vszAfterWarmKb: afterWarm.vszKb,
        closeMs: close.ms,
        startupTimings,
      });
    } finally {
      await vm?.close();
    }
  }

  const values = (key: keyof (typeof measurements)[number]) =>
    measurements
      .map((entry) => entry[key])
      .filter((value) => typeof value === "number") as number[];
  const warm = measurements.flatMap((entry) => entry.warmMs);
  const medianOrNull = (key: keyof (typeof measurements)[number]) => {
    const samples = values(key);
    return samples.length > 0 ? percentile(samples, 0.5) : null;
  };
  const startupTimingNames = [
    ...new Set(
      measurements.flatMap((entry) =>
        entry.startupTimings.map((timing) => timing.name),
      ),
    ),
  ];
  const startupTimingsMs = Object.fromEntries(
    startupTimingNames.map((name) => [
      name,
      percentile(
        measurements.flatMap((entry) =>
          entry.startupTimings
            .filter((timing) => timing.name === name)
            .map((timing) => timing.atMs),
        ),
        0.5,
      ),
    ]),
  );

  console.log(
    JSON.stringify(
      {
        backend: options.vmm,
        image: options.image ?? null,
        memory: options.memory ?? null,
        rootfsMode: options.rootfsMode ?? null,
        vfs: options.vfs,
        runs: options.runs,
        warmIterationsPerRun: options.iterations,
        createMs: medianOrNull("createMs"),
        startMs: medianOrNull("startMs"),
        coldExecMs: medianOrNull("coldExecMs"),
        coldTotalMs: medianOrNull("coldTotalMs"),
        warmExecP50Ms: percentile(warm, 0.5),
        warmExecP95Ms: percentile(warm, 0.95),
        rssAfterStartKb: medianOrNull("rssAfterStartKb"),
        rssAfterWarmKb: medianOrNull("rssAfterWarmKb"),
        vszAfterStartKb: medianOrNull("vszAfterStartKb"),
        vszAfterWarmKb: medianOrNull("vszAfterWarmKb"),
        closeMs: medianOrNull("closeMs"),
        startupTimingsMs,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
