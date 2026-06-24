/**
 * Measure Firecracker startup and exec latency.
 *
 * Run with:
 *   node host/examples/backend-benchmark.ts --iterations 20
 */

import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { VM } from "../src/vm/core.ts";

const execFileAsync = promisify(execFile);

type CliOptions = {
  iterations: number;
};

function parseOptions(argv: string[]): CliOptions {
  let iterations = 20;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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

  return { iterations };
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
  if (!pid || process.platform !== "linux") {
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
  const { iterations } = parseOptions(process.argv.slice(2));

  let vm: VM | null = null;
  try {
    const create = await measure(async () =>
      VM.create({
        sessionLabel: "gondolin firecracker benchmark",
        sandbox: { console: "none", netEnabled: false },
      }),
    );
    vm = create.value;

    const start = await measure(() => vm!.start());
    const afterStart = await processStats(vm.getHostPid());

    const coldExec = await measure(() => vm!.exec(["/bin/true"]).result);

    const warm: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const result = await measure(() => vm!.exec(["/bin/true"]).result);
      warm.push(result.ms);
    }

    const afterWarm = await processStats(vm.getHostPid());
    const close = await measure(() => vm!.close());
    vm = null;

    console.log(
      JSON.stringify(
        {
          backend: "firecracker",
          createMs: create.ms,
          startMs: start.ms,
          coldExecMs: coldExec.ms,
          warmExecP50Ms: percentile(warm, 0.5),
          warmExecP95Ms: percentile(warm, 0.95),
          rssAfterStartKb: afterStart.rssKb,
          rssAfterWarmKb: afterWarm.rssKb,
          vszAfterStartKb: afterStart.vszKb,
          vszAfterWarmKb: afterWarm.vszKb,
          closeMs: close.ms,
        },
        null,
        2,
      ),
    );
  } finally {
    await vm?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
