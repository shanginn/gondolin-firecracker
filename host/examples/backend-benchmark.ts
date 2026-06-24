/**
 * Compare Gondolin backend startup and exec latency.
 *
 * Run with:
 *   node host/examples/backend-benchmark.ts --backends qemu,firecracker --iterations 20
 */

import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { VM, type VMOptions } from "../src/vm/core.ts";
import type { SandboxVmm } from "../src/sandbox/server-options.ts";

const execFileAsync = promisify(execFile);

type BackendResult =
  | {
      backend: SandboxVmm;
      ok: true;
      createMs: number;
      startMs: number;
      coldExecMs: number;
      warmExecP50Ms: number;
      warmExecP95Ms: number;
      rssAfterStartKb: number | null;
      rssAfterWarmKb: number | null;
      vszAfterStartKb: number | null;
      vszAfterWarmKb: number | null;
      closeMs: number;
    }
  | {
      backend: SandboxVmm;
      ok: false;
      error: string;
    };

type CliOptions = {
  backends: SandboxVmm[];
  iterations: number;
};

function parseOptions(argv: string[]): CliOptions {
  let backends: SandboxVmm[] = ["qemu", "krun", "firecracker"];
  let iterations = 20;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backends" && argv[i + 1]) {
      backends = parseBackendList(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--iterations" && argv[i + 1]) {
      iterations = parsePositiveInteger(argv[i + 1], "--iterations");
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { backends, iterations };
}

function parseBackendList(value: string): SandboxVmm[] {
  const backends = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (backends.length === 0) {
    throw new Error("--backends must include at least one backend");
  }

  return backends.map((backend) => {
    if (backend === "qemu" || backend === "krun" || backend === "firecracker") {
      return backend;
    }
    throw new Error(`unsupported backend: ${backend}`);
  });
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
  --backends qemu,krun,firecracker  Backends to run
  --iterations N                    Warm exec iterations per backend
`);
}

async function measure<T>(fn: () => Promise<T>): Promise<{
  value: T;
  ms: number;
}> {
  const start = performance.now();
  const value = await fn();
  return {
    value,
    ms: performance.now() - start,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)]!;
}

function backendOptions(backend: SandboxVmm): VMOptions {
  return {
    sessionLabel: `gondolin backend benchmark (${backend})`,
    sandbox: {
      vmm: backend,
      ...(backend === "firecracker"
        ? {
            console: "none" as const,
            netEnabled: false,
          }
        : {}),
    },
  };
}

async function samplePidMemory(pid: number | null): Promise<{
  rssKb: number | null;
  vszKb: number | null;
}> {
  if (!pid) return { rssKb: null, vszKb: null };

  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "rss=,vsz=",
      "-p",
      String(pid),
    ]);
    const [rssRaw, vszRaw] = stdout.trim().split(/\s+/, 2);
    const rssKb = Number.parseInt(rssRaw ?? "", 10);
    const vszKb = Number.parseInt(vszRaw ?? "", 10);
    return {
      rssKb: Number.isFinite(rssKb) ? rssKb : null,
      vszKb: Number.isFinite(vszKb) ? vszKb : null,
    };
  } catch {
    return { rssKb: null, vszKb: null };
  }
}

async function runBackend(
  backend: SandboxVmm,
  iterations: number,
): Promise<BackendResult> {
  let vm: VM | null = null;

  try {
    const created = await measure(() => VM.create(backendOptions(backend)));
    vm = created.value;

    const started = await measure(() => vm!.start());
    const memoryAfterStart = await samplePidMemory(vm.getHostPid());
    const coldExec = await measure(() => vm!.exec("/bin/true"));
    const warmExecTimes: number[] = [];

    for (let i = 0; i < iterations; i += 1) {
      const result = await measure(() => vm!.exec("/bin/true"));
      warmExecTimes.push(result.ms);
    }
    const memoryAfterWarm = await samplePidMemory(vm.getHostPid());

    const closed = await measure(() => vm!.close());
    vm = null;

    return {
      backend,
      ok: true,
      createMs: created.ms,
      startMs: started.ms,
      coldExecMs: coldExec.ms,
      warmExecP50Ms: percentile(warmExecTimes, 0.5),
      warmExecP95Ms: percentile(warmExecTimes, 0.95),
      rssAfterStartKb: memoryAfterStart.rssKb,
      rssAfterWarmKb: memoryAfterWarm.rssKb,
      vszAfterStartKb: memoryAfterStart.vszKb,
      vszAfterWarmKb: memoryAfterWarm.vszKb,
      closeMs: closed.ms,
    };
  } catch (err) {
    if (vm) {
      await vm.close().catch(() => {});
    }
    return {
      backend,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatMs(value: number): string {
  return value.toFixed(2);
}

function printResults(results: BackendResult[]) {
  console.log(
    [
      "backend",
      "ok",
      "create_ms",
      "start_ms",
      "cold_exec_ms",
      "warm_exec_p50_ms",
      "warm_exec_p95_ms",
      "rss_after_start_kb",
      "rss_after_warm_kb",
      "vsz_after_start_kb",
      "vsz_after_warm_kb",
      "close_ms",
      "error",
    ].join(","),
  );

  for (const result of results) {
    if (!result.ok) {
      console.log(
        [
          result.backend,
          "false",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          JSON.stringify(result.error),
        ].join(","),
      );
      continue;
    }

    console.log(
      [
        result.backend,
        "true",
        formatMs(result.createMs),
        formatMs(result.startMs),
        formatMs(result.coldExecMs),
        formatMs(result.warmExecP50Ms),
        formatMs(result.warmExecP95Ms),
        result.rssAfterStartKb ?? "",
        result.rssAfterWarmKb ?? "",
        result.vszAfterStartKb ?? "",
        result.vszAfterWarmKb ?? "",
        formatMs(result.closeMs),
        "",
      ].join(","),
    );
  }
}

const options = parseOptions(process.argv.slice(2));
const results: BackendResult[] = [];
for (const backend of options.backends) {
  results.push(await runBackend(backend, options.iterations));
}
printResults(results);
