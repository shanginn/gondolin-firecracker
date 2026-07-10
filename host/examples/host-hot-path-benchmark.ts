/**
 * Measure allocation-sensitive host exec and VFS hot paths without starting a VM.
 *
 * Run with:
 *   node host/examples/host-hot-path-benchmark.ts --iterations 50000 --rounds 7
 */

import { performance } from "node:perf_hooks";

import {
  applyOutputChunk,
  createExecSession,
  finishExecSession,
} from "../src/exec.ts";
import { NetworkStack } from "../src/net/network-stack.ts";
import { encodeOutputFrame } from "../src/sandbox/control-protocol.ts";
import { encodeFrame } from "../src/sandbox/virtio-protocol.ts";
import { MountRouterProvider } from "../src/vfs/mounts.ts";
import { MemoryProvider } from "../src/vfs/node/index.ts";
import { SandboxVfsProvider } from "../src/vfs/provider.ts";
import { FsRpcService } from "../src/vfs/rpc-service.ts";

type CliOptions = {
  iterations: number;
  rounds: number;
};

type Benchmark = {
  name: string;
  iterations: number;
  run: () => Promise<void> | void;
};

function parseOptions(argv: string[]): CliOptions {
  let iterations = 50_000;
  let rounds = 7;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--iterations" && argv[index + 1]) {
      iterations = parsePositiveInteger(argv[++index], "--iterations");
      continue;
    }
    if (arg === "--rounds" && argv[index + 1]) {
      rounds = parsePositiveInteger(argv[++index], "--rounds");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { iterations, rounds };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: node host/examples/host-hot-path-benchmark.ts [options]

Options:
  --iterations N  Operations per measured round
  --rounds N      Measured rounds (median is reported)
`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function createRequest(id: number, op: string, req: Record<string, unknown>) {
  return {
    v: 1,
    t: "fs_request" as const,
    id,
    p: { op, req },
  };
}

async function createBenchmarks(iterations: number): Promise<Benchmark[]> {
  const backend = new MemoryProvider();
  const setupHandle = await backend.open("/hot.txt", "w+");
  await setupHandle.writeFile(Buffer.alloc(4096, 0x61));
  await setupHandle.close();

  const provider = new SandboxVfsProvider(
    new MountRouterProvider(new Map([["/", backend]])),
  );
  const service = new FsRpcService(provider);
  const lookup = await service.handleRequest(
    createRequest(1, "lookup", { parent_ino: 1, name: "hot.txt" }),
  );
  if (lookup.p.err !== 0) {
    throw new Error(
      `benchmark lookup failed: ${lookup.p.message ?? "unknown"}`,
    );
  }
  const ino = (lookup.p.res?.entry as { ino: number }).ino;
  const opened = await service.handleRequest(
    createRequest(2, "open", { ino, flags: 0 }),
  );
  if (opened.p.err !== 0) {
    throw new Error(`benchmark open failed: ${opened.p.message ?? "unknown"}`);
  }
  const fh = opened.p.res?.fh as number;

  const hookedProvider = new SandboxVfsProvider(
    new MountRouterProvider(new Map([["/", backend]])),
    { before: () => {}, after: () => {} },
  );
  const hookedService = new FsRpcService(hookedProvider);
  const hookedLookup = await hookedService.handleRequest(
    createRequest(6, "lookup", { parent_ino: 1, name: "hot.txt" }),
  );
  if (hookedLookup.p.err !== 0) {
    throw new Error(
      `hooked benchmark lookup failed: ${hookedLookup.p.message ?? "unknown"}`,
    );
  }
  const hookedIno = (hookedLookup.p.res?.entry as { ino: number }).ino;
  const hookedOpened = await hookedService.handleRequest(
    createRequest(7, "open", { ino: hookedIno, flags: 0 }),
  );
  if (hookedOpened.p.err !== 0) {
    throw new Error(
      `hooked benchmark open failed: ${hookedOpened.p.message ?? "unknown"}`,
    );
  }
  const hookedFh = hookedOpened.p.res?.fh as number;

  const getattrRequest = createRequest(3, "getattr", { ino });
  const lookupRequest = createRequest(4, "lookup", {
    parent_ino: 1,
    name: "hot.txt",
  });
  const readRequest = createRequest(5, "read", { fh, offset: 0, size: 4096 });
  const hookedGetattrRequest = createRequest(8, "getattr", { ino: hookedIno });
  const hookedLookupRequest = createRequest(9, "lookup", {
    parent_ino: 1,
    name: "hot.txt",
  });
  const hookedReadRequest = createRequest(10, "read", {
    fh: hookedFh,
    offset: 0,
    size: 4096,
  });
  const outputChunk = Buffer.alloc(4096, 0x61);
  const smallOutputChunk = outputChunk.subarray(0, 128);
  const networkStack = new NetworkStack({
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });
  const ethernetFrame = Buffer.alloc(1514, 0x61);
  const framedEthernet = Buffer.alloc(4 + ethernetFrame.length);
  framedEthernet.writeUInt32BE(ethernetFrame.length, 0);
  ethernetFrame.copy(framedEthernet, 4);
  const ipPacket = Buffer.alloc(1500, 0x61);
  const virtioMessage = {
    v: 1,
    t: "tcp_data",
    id: 7,
    p: { data: outputChunk },
  };

  return [
    {
      name: "mounted provider lstat (no hooks)",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await provider.lstat("/hot.txt");
        }
      },
    },
    {
      name: "fs rpc getattr",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await service.handleRequest(getattrRequest);
        }
      },
    },
    {
      name: "fs rpc lookup",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await service.handleRequest(lookupRequest);
        }
      },
    },
    {
      name: "fs rpc read 4 KiB",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await service.handleRequest(readRequest);
        }
      },
    },
    {
      name: "mounted provider lstat (sync hooks)",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await hookedProvider.lstat("/hot.txt");
        }
      },
    },
    {
      name: "fs rpc getattr (sync hooks)",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await hookedService.handleRequest(hookedGetattrRequest);
        }
      },
    },
    {
      name: "fs rpc lookup (sync hooks)",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await hookedService.handleRequest(hookedLookupRequest);
        }
      },
    },
    {
      name: "fs rpc read 4 KiB (sync hooks)",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          await hookedService.handleRequest(hookedReadRequest);
        }
      },
    },
    {
      name: "exec buffered output 4 KiB",
      iterations,
      run: async () => {
        for (let index = 0; index < iterations; index += 1) {
          const session = createExecSession(index, {
            stdinEnabled: false,
            stdout: { mode: "buffer" },
            stderr: { mode: "buffer" },
          });
          session.sendWindowUpdate = () => {};
          applyOutputChunk(session, "stdout", outputChunk);
          finishExecSession(session, 0);
          await session.resultPromise;
        }
      },
    },
    {
      name: "control output frame encode 128 B",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          encodeOutputFrame(index, "stdout", smallOutputChunk);
        }
      },
    },
    {
      name: "control output frame encode 4 KiB",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          encodeOutputFrame(index, "stdout", outputChunk);
        }
      },
    },
    {
      name: "virtio CBOR frame encode 4 KiB",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          encodeFrame(virtioMessage);
        }
      },
    },
    {
      name: "network production frame rx 1514 B",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          networkStack.writeFrameToNetwork(ethernetFrame);
        }
      },
    },
    {
      name: "network production frame tx 1500 B",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          networkStack.send(ipPacket, 0x0800);
          networkStack.readFrameFromNetwork();
        }
      },
    },
    {
      name: "network legacy length-prefixed rx 1514 B",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          networkStack.writeToNetwork(framedEthernet);
        }
      },
    },
    {
      name: "network legacy length-prefixed tx 1500 B",
      iterations,
      run: () => {
        for (let index = 0; index < iterations; index += 1) {
          networkStack.send(ipPacket, 0x0800);
          networkStack.readFromNetwork(2048);
        }
      },
    },
  ];
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const benchmarks = await createBenchmarks(options.iterations);

  for (const benchmark of benchmarks) {
    await benchmark.run();
    const samples: number[] = [];
    for (let round = 0; round < options.rounds; round += 1) {
      const started = performance.now();
      await benchmark.run();
      samples.push(performance.now() - started);
    }

    const medianMs = median(samples);
    const operationsPerSecond = benchmark.iterations / (medianMs / 1000);
    console.log(
      `${benchmark.name}: ${operationsPerSecond.toFixed(0)} ops/s (${(
        (medianMs * 1_000_000) /
        benchmark.iterations
      ).toFixed(0)} ns/op)`,
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
