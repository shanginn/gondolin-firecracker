import fs from "node:fs/promises";
import path from "node:path";

import {
  VM,
  RealFSProvider,
  type FirecrackerVmSnapshot,
} from "../../../host/src/index.ts";

import {
  applyConfigPatch,
  createDefaultConfig,
  type SimConfig,
} from "./config.ts";
import { sampleResources, type ResourceSnapshot } from "./resources.ts";

type SessionStatus =
  | "empty"
  | "queued"
  | "starting"
  | "running"
  | "hot"
  | "snapshotting"
  | "warm"
  | "closing"
  | "error";

type WorkItem = {
  id: number;
  userId: string;
  createdAt: number;
};

type Session = {
  id: string;
  status: SessionStatus;
  vm: VM | null;
  snapshot: FirecrackerVmSnapshot | null;
  snapshotDir: string | null;
  snapshotBytes: number;
  snapshotExpiresAt: number | null;
  busy: boolean;
  slotReserved: boolean;
  hotTimer: NodeJS.Timeout | null;
  hotSince: number | null;
  lastResult: string;
  lastError: string;
  lastUsedAt: number;
  tasksCompleted: number;
};

type Metrics = {
  startedAt: number;
  tasksQueued: number;
  tasksStarted: number;
  tasksCompleted: number;
  tasksFailed: number;
  coldBoots: number;
  restores: number;
  hotReuses: number;
  snapshots: number;
  snapshotFailures: number;
  closes: number;
  pressureEvictions: number;
  totalWaitMs: number;
  totalRunMs: number;
};

type SimEvent = {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
};

type HistoryPoint = {
  at: number;
  queued: number;
  active: number;
  hot: number;
  warm: number;
  vmmRssBytes: number;
};

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
    this.drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
    }
  }
}

export class MultitenantSimulator {
  private config: SimConfig;
  private sessions = new Map<string, Session>();
  private queue: WorkItem[] = [];
  private events: SimEvent[] = [];
  private history: HistoryPoint[] = [];
  private metrics: Metrics = createMetrics();
  private nextTaskId = 1;
  private running = false;
  private arrivalCarry = 0;
  private arrivalTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private pumpActive = false;
  private bootSemaphore: Semaphore;

  constructor(config = createDefaultConfig()) {
    this.config = config;
    this.bootSemaphore = new Semaphore(config.bootConcurrency);
  }

  getConfig() {
    return this.config;
  }

  updateConfig(patch: Record<string, unknown>) {
    this.config = applyConfigPatch(this.config, patch);
    this.bootSemaphore.setLimit(this.config.bootConcurrency);
    this.event("info", "configuration updated");
  }

  async start() {
    await this.ensureDirs();
    if (this.running) return;
    this.running = true;
    this.metrics.startedAt ||= Date.now();
    this.arrivalTimer = setInterval(() => this.arrivalTick(), 1000);
    this.maintenanceTimer = setInterval(() => void this.maintenance(), 1000);
    this.event("info", "simulation started");
  }

  pause() {
    this.running = false;
    if (this.arrivalTimer) clearInterval(this.arrivalTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.arrivalTimer = null;
    this.maintenanceTimer = null;
    this.event("info", "simulation paused");
  }

  async reset() {
    this.pause();
    await this.closeAll();
    await fs.rm(this.config.workDir, { recursive: true, force: true });
    this.sessions.clear();
    this.queue = [];
    this.history = [];
    this.metrics = createMetrics();
    this.nextTaskId = 1;
    this.arrivalCarry = 0;
    await this.ensureDirs();
    this.event("info", "simulation reset");
  }

  async shutdown() {
    this.pause();
    await this.closeAll();
  }

  enqueueBurst(count: number) {
    const n = Math.max(1, Math.min(10000, Math.trunc(count)));
    for (let i = 0; i < n; i += 1) {
      this.enqueueTask(this.pickUserId());
    }
    void this.pump();
  }

  enqueueUser(userId: string) {
    this.enqueueTask(userId.trim() || this.pickUserId());
    void this.pump();
  }

  async snapshotState() {
    const resource = await sampleResources(this.vmPids());
    this.recordHistory(resource);
    const counts = this.counts();
    return {
      running: this.running,
      config: this.config,
      metrics: this.metricsView(),
      counts,
      resource,
      history: this.history,
      events: this.events.slice(-120).reverse(),
      sessions: [...this.sessions.values()]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, 200)
        .map((session) => ({
          id: session.id,
          status: session.status,
          pid: session.vm?.getHostPid() ?? null,
          tasksCompleted: session.tasksCompleted,
          snapshotBytes: session.snapshotBytes,
          snapshotExpiresAt: session.snapshotExpiresAt,
          lastResult: session.lastResult,
          lastError: session.lastError,
          lastUsedAt: session.lastUsedAt,
        })),
    };
  }

  private arrivalTick() {
    if (!this.running) return;
    this.arrivalCarry += this.config.arrivalRatePerSec;
    const count = Math.floor(this.arrivalCarry);
    this.arrivalCarry -= count;
    for (let i = 0; i < count; i += 1) {
      this.enqueueTask(this.pickUserId());
    }
    void this.pump();
  }

  private enqueueTask(userId: string) {
    const session = this.getSession(userId);
    if (session.status === "empty") session.status = "queued";
    this.queue.push({
      id: this.nextTaskId++,
      userId,
      createdAt: Date.now(),
    });
    this.metrics.tasksQueued += 1;
  }

  private async pump() {
    if (this.pumpActive) return;
    this.pumpActive = true;
    try {
      for (;;) {
        const index = this.findRunnableQueueIndex();
        if (index === -1) {
          if (this.queue.length > 0 && (await this.evictOneHotForPressure())) {
            continue;
          }
          return;
        }
        const [task] = this.queue.splice(index, 1);
        void this.runTask(task);
      }
    } finally {
      this.pumpActive = false;
    }
  }

  private findRunnableQueueIndex() {
    for (let i = 0; i < this.queue.length; i += 1) {
      const session = this.getSession(this.queue[i].userId);
      if (session.busy) continue;
      if (session.status === "snapshotting" || session.status === "closing") {
        continue;
      }
      if (session.vm || this.vmSlotCount() < this.config.maxActiveVms) {
        return i;
      }
    }
    return -1;
  }

  private async runTask(task: WorkItem) {
    const session = this.getSession(task.userId);
    session.busy = true;
    if (!session.vm) session.slotReserved = true;
    session.status = "starting";
    session.lastUsedAt = Date.now();
    this.metrics.tasksStarted += 1;
    this.metrics.totalWaitMs += Date.now() - task.createdAt;

    const startedAt = Date.now();
    try {
      const vm = await this.ensureVm(session);
      session.status = "running";
      const result = await this.runPiWorkload(vm, session, task);
      session.lastResult = result.trim();
      session.lastError = "";
      session.tasksCompleted += 1;
      this.metrics.tasksCompleted += 1;
      this.metrics.totalRunMs += Date.now() - startedAt;
      this.event("info", `${session.id} completed task ${task.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.status = "error";
      session.lastError = message;
      this.metrics.tasksFailed += 1;
      this.event("error", `${session.id} failed task ${task.id}: ${message}`);
    } finally {
      session.busy = false;
      session.slotReserved = false;
      session.lastUsedAt = Date.now();
      void this.afterTask(session);
      void this.pump();
    }
  }

  private async ensureVm(session: Session) {
    if (session.hotTimer) {
      clearTimeout(session.hotTimer);
      session.hotTimer = null;
      session.hotSince = null;
    }

    if (session.vm) {
      this.metrics.hotReuses += 1;
      return session.vm;
    }

    await this.ensureDirs();
    await fs.mkdir(this.workspaceDir(session.id), { recursive: true });
    if (session.snapshot && !this.snapshotExpired(session)) {
      const snapshot = session.snapshot;
      try {
        const vm = await this.bootSemaphore.run(async () =>
          VM.restoreFirecrackerSnapshot(snapshot, this.vmOptions(session)),
        );
        await vm.start();
        session.vm = vm;
        this.metrics.restores += 1;
        await this.deleteSnapshot(session);
        this.event("info", `${session.id} restored warm VM-state`);
        return vm;
      } catch (error) {
        this.metrics.snapshotFailures += 1;
        this.event(
          "warn",
          `${session.id} warm restore failed, cold booting: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.deleteSnapshot(session);
      }
    }

    await this.deleteSnapshot(session);
    const vm = await this.bootSemaphore.run(async () =>
      VM.create(this.vmOptions(session)),
    );
    await vm.start();
    session.vm = vm;
    this.metrics.coldBoots += 1;
    this.event("info", `${session.id} cold booted`);
    return vm;
  }

  private async runPiWorkload(vm: VM, session: Session, task: WorkItem) {
    const inputPath = `/data/workspace/input-${task.id}.txt`;
    const resultPath = `/data/workspace/result-${task.id}.txt`;
    await vm.fs.mkdir("/data/workspace", { recursive: true });
    await vm.fs.writeFile(
      inputPath,
      [
        `user=${session.id}`,
        `task=${task.id}`,
        `strategy=${this.config.strategy}`,
        `createdAt=${new Date(task.createdAt).toISOString()}`,
        "",
      ].join("\n"),
    );

    const script = [
      "set -euo pipefail",
      "mkdir -p /data/workspace",
      `echo ${shellQuote(`task ${task.id} for ${session.id}`)} >> /data/workspace/actions.log`,
      `cat ${shellQuote(inputPath)} >> /data/workspace/transcript.log`,
      this.config.networkEnabled
        ? [
            "exec 3<>/dev/tcp/example.com/80",
            'printf "GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n" >&3',
            "IFS= read -r line <&3",
            'echo "$line" >> /data/workspace/network.log',
          ].join("\n")
        : "echo network=disabled >> /data/workspace/network.log",
      "i=0",
      `while [ "$i" -lt ${this.config.taskCpuIterations} ]; do i=$((i + 1)); done`,
      `echo ${shellQuote(`user=${session.id} task=${task.id} iterations=`)}"$i" > ${shellQuote(resultPath)}`,
    ].join("\n");

    const result = await vm.exec(["/bin/bash", "-lc", script]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `guest exit ${result.exitCode}`);
    }
    return await vm.fs.readFile(resultPath, { encoding: "utf8" });
  }

  private async afterTask(session: Session) {
    if (this.queue.some((task) => task.userId === session.id)) {
      session.status = session.vm ? "hot" : "queued";
      void this.pump();
      return;
    }

    if (this.config.strategy === "cold") {
      await this.closeVm(session, "cold strategy");
      return;
    }

    if (this.config.strategy === "warm-snapshot") {
      await this.snapshotAndClose(session, "idle");
      return;
    }

    session.status = "hot";
    session.hotSince = Date.now();
    if (this.config.hotIdleTtlMs === 0) {
      if (this.config.strategy === "hybrid") {
        await this.snapshotAndClose(session, "hot ttl");
      } else {
        await this.closeVm(session, "hot ttl");
      }
      return;
    }

    session.hotTimer = setTimeout(() => {
      session.hotTimer = null;
      if (this.config.strategy === "hybrid") {
        void this.snapshotAndClose(session, "hot ttl");
      } else {
        void this.closeVm(session, "hot ttl");
      }
    }, this.config.hotIdleTtlMs);
    session.hotTimer.unref?.();
  }

  private async snapshotAndClose(session: Session, reason: string) {
    if (!session.vm || session.busy) return;
    if (session.hotTimer) clearTimeout(session.hotTimer);
    session.hotTimer = null;
    session.hotSince = null;
    session.status = "snapshotting";
    try {
      const snapshotDir = path.join(this.config.workDir, "snapshots", session.id);
      await fs.rm(snapshotDir, { recursive: true, force: true });
      await fs.mkdir(snapshotDir, { recursive: true });
      const snapshot = await session.vm.createFirecrackerSnapshot(snapshotDir);
      const bytes = await snapshotBytes(snapshot);
      await session.vm.close();
      session.vm = null;
      session.snapshot = snapshot;
      session.snapshotDir = snapshotDir;
      session.snapshotBytes = bytes;
      session.snapshotExpiresAt =
        this.config.warmSnapshotTtlMs > 0
          ? Date.now() + this.config.warmSnapshotTtlMs
          : null;
      session.status = "warm";
      this.metrics.snapshots += 1;
      this.event("info", `${session.id} saved warm VM-state (${reason})`);
    } catch (error) {
      this.metrics.snapshotFailures += 1;
      this.event(
        "warn",
        `${session.id} snapshot failed, closing VM: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.closeVm(session, "snapshot failed");
    } finally {
      void this.pump();
    }
  }

  private async closeVm(session: Session, reason: string) {
    if (session.hotTimer) clearTimeout(session.hotTimer);
    session.hotTimer = null;
    session.hotSince = null;
    if (!session.vm) {
      if (!session.snapshot) session.status = "empty";
      return;
    }
    session.status = "closing";
    try {
      await session.vm.close();
      this.metrics.closes += 1;
      this.event("info", `${session.id} closed VM (${reason})`);
    } finally {
      session.vm = null;
      session.status = session.snapshot ? "warm" : "empty";
      void this.pump();
    }
  }

  private async evictOneHotForPressure() {
    const hot = [...this.sessions.values()]
      .filter((session) => session.vm && !session.busy && session.status === "hot")
      .sort((a, b) => (a.hotSince ?? 0) - (b.hotSince ?? 0))[0];
    if (!hot) return false;
    this.metrics.pressureEvictions += 1;
    if (this.config.strategy === "hybrid") {
      await this.snapshotAndClose(hot, "pressure");
    } else {
      await this.closeVm(hot, "pressure");
    }
    return true;
  }

  private async maintenance() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (
        session.snapshot &&
        session.snapshotExpiresAt !== null &&
        session.snapshotExpiresAt <= now &&
        !session.busy
      ) {
        await this.deleteSnapshot(session);
        session.status = "empty";
        this.event("info", `${session.id} expired warm VM-state`);
      }
    }
  }

  private async deleteSnapshot(session: Session) {
    if (session.snapshotDir) {
      await fs.rm(session.snapshotDir, { recursive: true, force: true });
    }
    session.snapshot = null;
    session.snapshotDir = null;
    session.snapshotBytes = 0;
    session.snapshotExpiresAt = null;
  }

  private async closeAll() {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        if (session.hotTimer) clearTimeout(session.hotTimer);
        session.hotTimer = null;
        if (session.vm) await session.vm.close().catch(() => {});
      }),
    );
  }

  private vmOptions(session: Session) {
    return {
      memory: this.config.vmMemory,
      startTimeoutMs: this.config.vmStartTimeoutMs,
      vfs: {
        mounts: {
          "/": new RealFSProvider(this.workspaceDir(session.id)),
        },
      },
      sandbox: {
        imagePath: this.config.imagePath,
        netEnabled: this.config.networkEnabled,
        console: "off" as const,
      },
    };
  }

  private getSession(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        status: "empty",
        vm: null,
        snapshot: null,
        snapshotDir: null,
        snapshotBytes: 0,
        snapshotExpiresAt: null,
        busy: false,
        slotReserved: false,
        hotTimer: null,
        hotSince: null,
        lastResult: "",
        lastError: "",
        lastUsedAt: Date.now(),
        tasksCompleted: 0,
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  private pickUserId() {
    const index = Math.floor(Math.random() * this.config.targetUsers) + 1;
    return `user-${String(index).padStart(5, "0")}`;
  }

  private workspaceDir(userId: string) {
    return path.join(this.config.workDir, "workspaces", userId);
  }

  private async ensureDirs() {
    await fs.mkdir(path.join(this.config.workDir, "workspaces"), {
      recursive: true,
    });
    await fs.mkdir(path.join(this.config.workDir, "snapshots"), {
      recursive: true,
    });
  }

  private vmSlotCount() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.vm || session.slotReserved) count += 1;
    }
    return count;
  }

  private vmPids() {
    return [...this.sessions.values()]
      .map((session) => session.vm?.getHostPid() ?? null)
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);
  }

  private snapshotExpired(session: Session) {
    return (
      session.snapshotExpiresAt !== null && session.snapshotExpiresAt <= Date.now()
    );
  }

  private counts() {
    const counts: Record<string, number> = {
      queued: this.queue.length,
      slots: this.vmSlotCount(),
    };
    for (const session of this.sessions.values()) {
      counts[session.status] = (counts[session.status] ?? 0) + 1;
    }
    return counts;
  }

  private metricsView() {
    const completed = Math.max(1, this.metrics.tasksCompleted);
    const started = Math.max(1, this.metrics.tasksStarted);
    const snapshotBytes = [...this.sessions.values()].reduce(
      (sum, session) => sum + session.snapshotBytes,
      0,
    );
    return {
      ...this.metrics,
      avgWaitMs: this.metrics.totalWaitMs / started,
      avgRunMs: this.metrics.totalRunMs / completed,
      snapshotBytes,
    };
  }

  private recordHistory(resource: ResourceSnapshot) {
    const last = this.history[this.history.length - 1];
    const now = Date.now();
    if (last && now - last.at < 1000) return;
    const counts = this.counts();
    this.history.push({
      at: now,
      queued: counts.queued ?? 0,
      active: (counts.running ?? 0) + (counts.starting ?? 0),
      hot: counts.hot ?? 0,
      warm: counts.warm ?? 0,
      vmmRssBytes: resource.vmmRssBytes,
    });
    if (this.history.length > 300) {
      this.history.splice(0, this.history.length - 300);
    }
  }

  private event(level: SimEvent["level"], message: string) {
    this.events.push({ at: Date.now(), level, message });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
  }
}

function createMetrics(): Metrics {
  return {
    startedAt: Date.now(),
    tasksQueued: 0,
    tasksStarted: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    coldBoots: 0,
    restores: 0,
    hotReuses: 0,
    snapshots: 0,
    snapshotFailures: 0,
    closes: 0,
    pressureEvictions: 0,
    totalWaitMs: 0,
    totalRunMs: 0,
  };
}

async function snapshotBytes(snapshot: FirecrackerVmSnapshot) {
  const [state, memory] = await Promise.all([
    fs.stat(snapshot.snapshotPath),
    fs.stat(snapshot.memPath),
  ]);
  return state.size + memory.size;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
