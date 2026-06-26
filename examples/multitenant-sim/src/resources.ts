import fs from "node:fs/promises";
import os from "node:os";

const PAGE_SIZE = 4096;

export type PidUsage = {
  /** Process ID */
  pid: number;
  /** Resident set size in `bytes` */
  rssBytes: number;
  /** Virtual memory size in `bytes` */
  vszBytes: number;
};

export type ResourceSnapshot = {
  /** Simulator process RSS in `bytes` */
  processRssBytes: number;
  /** Simulator JS heap usage in `bytes` */
  processHeapUsedBytes: number;
  /** Host free memory in `bytes` */
  freeMemBytes: number;
  /** Host total memory in `bytes` */
  totalMemBytes: number;
  /** Host load average */
  loadavg: number[];
  /** Sum of VMM RSS in `bytes` */
  vmmRssBytes: number;
  /** Sum of VMM VSZ in `bytes` */
  vmmVszBytes: number;
  /** Per-VM runner memory usage */
  pids: PidUsage[];
};

export async function sampleResources(pids: number[]): Promise<ResourceSnapshot> {
  const usages = (
    await Promise.all(pids.map((pid) => readPidUsage(pid)))
  ).filter((entry): entry is PidUsage => entry !== null);
  const mem = process.memoryUsage();

  return {
    processRssBytes: mem.rss,
    processHeapUsedBytes: mem.heapUsed,
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
    loadavg: os.loadavg(),
    vmmRssBytes: usages.reduce((sum, entry) => sum + entry.rssBytes, 0),
    vmmVszBytes: usages.reduce((sum, entry) => sum + entry.vszBytes, 0),
    pids: usages,
  };
}

async function readPidUsage(pid: number): Promise<PidUsage | null> {
  try {
    const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8");
    const [sizePages, residentPages] = statm.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(sizePages) || !Number.isFinite(residentPages)) {
      return null;
    }
    return {
      pid,
      rssBytes: residentPages * PAGE_SIZE,
      vszBytes: sizePages * PAGE_SIZE,
    };
  } catch {
    return null;
  }
}
