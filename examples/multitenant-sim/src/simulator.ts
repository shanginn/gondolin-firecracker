import type {
  MessageResult,
  SessionBackend,
  SessionHandle,
} from "./backends.ts";
import { type SimulatorConfig, clamp } from "./config.ts";
import {
  type BehaviorProfile,
  createUserPlan,
  nextDelayMs,
} from "./profiles.ts";
import { type Rng, createRng } from "./rng.ts";

export type UserState = "queued" | "starting" | "live" | "closing" | "error";

export type RuntimeSettings = {
  /** Traffic generator switch */
  running: boolean;
  /** Desired active user count */
  targetUsers: number;
  /** Arrivals per `minute` */
  spawnRatePerMinute: number;
  /** Active VM slot count */
  maxActiveVms: number;
  /** Profile tempo multiplier */
  tempo: number;
};

export type SimulatorEvent = {
  /** Event timestamp in Unix `ms` */
  at: number;
  /** Event severity */
  level: "info" | "warn" | "error";
  /** Short event title */
  title: string;
  /** Event detail */
  detail: string;
};

type SimUser = {
  id: string;
  name: string;
  profile: BehaviorProfile;
  state: UserState;
  createdAt: number;
  expiresAt: number;
  messageBudget: number;
  messagesSent: number;
  nextMessageAt: number;
  lastLatencyMs: number | null;
  lastSummary: string;
  hostPid: number | null;
  handle: SessionHandle | null;
  inFlight: boolean;
  abortController: AbortController | null;
};

type TimeSample = {
  at: number;
  value: number;
};

export type PublicSimulatorState = ReturnType<MultiTenantSimulator["snapshot"]>;

const LOOP_INTERVAL_MS = 250;
const EVENT_LIMIT = 80;
const SAMPLE_WINDOW_MS = 60_000;
const USER_NAMES = [
  "Nova",
  "Pixel",
  "Orbit",
  "Relay",
  "Neon",
  "Comet",
  "Turbo",
  "Echo",
  "Vector",
  "Signal",
  "Pulse",
  "Arcade",
  "Kite",
  "Quartz",
  "Beacon",
  "Tempo",
];

export class MultiTenantSimulator {
  readonly config: SimulatorConfig;
  private readonly rng: Rng;
  private readonly users = new Map<string, SimUser>();
  private readonly events: SimulatorEvent[] = [];
  private readonly latencies: TimeSample[] = [];
  private readonly messages: TimeSample[] = [];
  private readonly starts: TimeSample[] = [];
  private readonly backend: SessionBackend;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastStepAt = 0;
  private spawnCredit = 0;
  private stepping = false;
  private nextUserNumber = 1;
  private totalUsers = 0;
  private totalMessages = 0;
  private totalErrors = 0;
  private totalBootFailures = 0;
  private consecutiveBootFailures = 0;

  readonly settings: RuntimeSettings;

  constructor(
    config: SimulatorConfig,
    backend: SessionBackend,
    now: () => number = () => Date.now(),
  ) {
    this.config = config;
    this.backend = backend;
    this.now = now;
    this.rng = createRng(config.seed);
    this.settings = {
      running: !config.pausedOnStart,
      targetUsers: config.targetUsers,
      spawnRatePerMinute: config.spawnRatePerMinute,
      maxActiveVms: config.maxActiveVms,
      tempo: config.tempo,
    };
    this.event("info", "Loaded", `${backend.kind} backend ready`);
  }

  startLoop(): void {
    if (this.timer) return;
    this.lastStepAt = this.now();
    this.timer = setInterval(() => void this.step(), LOOP_INTERVAL_MS);
  }

  stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  updateSettings(input: Partial<RuntimeSettings>): RuntimeSettings {
    if (input.running !== undefined) {
      this.settings.running = Boolean(input.running);
    }
    if (input.targetUsers !== undefined) {
      this.settings.targetUsers = Math.trunc(
        clamp(input.targetUsers, 0, this.config.maxActiveUsers),
      );
    }
    if (input.spawnRatePerMinute !== undefined) {
      this.settings.spawnRatePerMinute = clamp(
        input.spawnRatePerMinute,
        0,
        this.config.maxSpawnRatePerMinute,
      );
    }
    if (input.maxActiveVms !== undefined) {
      this.settings.maxActiveVms = Math.trunc(
        clamp(input.maxActiveVms, 1, this.config.maxActiveVms),
      );
    }
    if (input.tempo !== undefined) {
      this.settings.tempo = clamp(input.tempo, 0.1, this.config.maxTempo);
    }
    this.event("info", "Tuned", "Runtime dials updated");
    return { ...this.settings };
  }

  async action(
    name: "start" | "pause" | "reset" | "burst",
    value?: number,
  ): Promise<void> {
    if (name === "start") {
      this.settings.running = true;
      this.event("info", "Started", "Traffic generator is live");
      return;
    }
    if (name === "pause") {
      this.settings.running = false;
      this.event("warn", "Paused", "New messages and arrivals stopped");
      return;
    }
    if (name === "burst") {
      const count = Math.trunc(clamp(value ?? 3, 1, this.config.maxActiveUsers));
      for (let i = 0; i < count; i += 1) this.spawnUser(this.now());
      this.event("info", "Burst", `${count} users dropped into the queue`);
      return;
    }
    await this.reset();
  }

  async reset(): Promise<void> {
    this.settings.running = false;
    const users = [...this.users.values()];
    this.users.clear();
    this.spawnCredit = 0;
    this.latencies.length = 0;
    this.messages.length = 0;
    this.starts.length = 0;
    this.consecutiveBootFailures = 0;
    for (const user of users) {
      user.abortController?.abort();
    }
    await Promise.allSettled(users.map((user) => user.handle?.close()));
    this.event("warn", "Reset", "All simulated users were cleared");
  }

  async step(now = this.now()): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const elapsedMs =
        this.lastStepAt === 0 ? LOOP_INTERVAL_MS : Math.max(0, now - this.lastStepAt);
      this.lastStepAt = now;
      this.pruneSamples(now);
      this.closeExpiredUsers(now);
      if (this.settings.running) {
        this.planArrivals(now, elapsedMs);
        this.startQueuedUsers();
        this.sendDueMessages(now);
      }
    } finally {
      this.stepping = false;
    }
  }

  snapshot(now = this.now()) {
    const users = [...this.users.values()];
    const latencyValues = this.latencies.map((s) => s.value);
    const liveUsers = users.filter((u) => u.state === "live").length;
    const startingUsers = users.filter((u) => u.state === "starting").length;
    const queuedUsers = users.filter((u) => u.state === "queued").length;
    const closingUsers = users.filter((u) => u.state === "closing").length;
    const activeVms = liveUsers + startingUsers + closingUsers;

    return {
      backend: this.backend.kind,
      generatedAt: now,
      caps: {
        maxActiveUsers: this.config.maxActiveUsers,
        maxActiveVms: this.config.maxActiveVms,
        maxSpawnRatePerMinute: this.config.maxSpawnRatePerMinute,
        maxTempo: this.config.maxTempo,
      },
      settings: { ...this.settings },
      totals: {
        users: this.totalUsers,
        messages: this.totalMessages,
        errors: this.totalErrors,
        bootFailures: this.totalBootFailures,
      },
      gauges: {
        activeUsers: users.length,
        liveUsers,
        startingUsers,
        queuedUsers,
        activeVms,
        messagesPerMinute: this.messages.length,
        startsPerMinute: this.starts.length,
        p50LatencyMs: percentile(latencyValues, 0.5),
        p95LatencyMs: percentile(latencyValues, 0.95),
      },
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        profile: user.profile.label,
        profileKey: user.profile.name,
        color: user.profile.color,
        state: user.state,
        ageMs: now - user.createdAt,
        ttlMs: Math.max(0, user.expiresAt - now),
        messagesSent: user.messagesSent,
        messageBudget: user.messageBudget,
        nextMessageInMs: Math.max(0, user.nextMessageAt - now),
        lastLatencyMs: user.lastLatencyMs,
        lastSummary: user.lastSummary,
        hostPid: user.hostPid,
        inFlight: user.inFlight,
      })),
      events: [...this.events].reverse(),
    };
  }

  private planArrivals(now: number, elapsedMs: number): void {
    if (this.users.size >= this.settings.targetUsers) return;
    if (this.users.size >= this.config.maxActiveUsers) return;

    this.spawnCredit +=
      (this.settings.spawnRatePerMinute * elapsedMs) / SAMPLE_WINDOW_MS;

    while (
      this.spawnCredit >= 1 &&
      this.users.size < this.settings.targetUsers &&
      this.users.size < this.config.maxActiveUsers
    ) {
      this.spawnCredit -= 1;
      this.spawnUser(now);
    }

    if (
      this.spawnCredit > 0 &&
      this.rng.next() < this.spawnCredit &&
      this.users.size < this.settings.targetUsers &&
      this.users.size < this.config.maxActiveUsers
    ) {
      this.spawnCredit = 0;
      this.spawnUser(now);
    }
  }

  private spawnUser(now: number): void {
    if (this.users.size >= this.config.maxActiveUsers) return;
    const plan = createUserPlan(this.rng, now, this.config.maxUserLifetimeMs);
    const number = this.nextUserNumber;
    this.nextUserNumber += 1;
    const id = `u-${number.toString(36).padStart(4, "0")}`;
    const name = `${this.rng.pick(USER_NAMES)}-${number.toString().padStart(3, "0")}`;
    const user: SimUser = {
      id,
      name,
      profile: plan.profile,
      state: "queued",
      createdAt: now,
      expiresAt: plan.expiresAt,
      messageBudget: plan.messageBudget,
      messagesSent: 0,
      nextMessageAt: now,
      lastLatencyMs: null,
      lastSummary: "",
      hostPid: null,
      handle: null,
      inFlight: false,
      abortController: null,
    };
    this.users.set(user.id, user);
    this.totalUsers += 1;
    this.event("info", "Queued", `${user.name} chose ${user.profile.label}`);
  }

  private startQueuedUsers(): void {
    for (const user of this.users.values()) {
      if (this.activeVmSlots() >= this.settings.maxActiveVms) return;
      if (user.state !== "queued") continue;
      void this.startUser(user);
    }
  }

  private async startUser(user: SimUser): Promise<void> {
    if (user.state !== "queued") return;
    user.state = "starting";
    try {
      const handle = await this.backend.start({
        id: user.id,
        name: user.name,
        profileLabel: user.profile.label,
      });
      if (this.users.get(user.id) !== user || user.state !== "starting") {
        await handle.close();
        return;
      }
      const now = this.now();
      user.handle = handle;
      user.state = "live";
      user.nextMessageAt = now + nextDelayMs(this.rng, user.profile, this.settings.tempo);
      this.starts.push({ at: now, value: 1 });
      this.consecutiveBootFailures = 0;
      this.event("info", "VM live", `${user.name} got a slot`);
    } catch (err) {
      this.totalErrors += 1;
      this.totalBootFailures += 1;
      this.consecutiveBootFailures += 1;
      user.state = "error";
      this.event("error", "Boot failed", errorMessage(err));
      this.users.delete(user.id);
      if (this.consecutiveBootFailures >= this.config.bootFailurePauseThreshold) {
        this.settings.running = false;
        this.event(
          "error",
          "Auto-paused",
          `${this.consecutiveBootFailures} VM boots failed in a row`,
        );
      }
    }
  }

  private sendDueMessages(now: number): void {
    for (const user of this.users.values()) {
      if (user.state !== "live") continue;
      if (user.inFlight || !user.handle) continue;
      if (user.messagesSent >= user.messageBudget) {
        void this.closeUser(user, "budget spent");
        continue;
      }
      if (now >= user.expiresAt) {
        void this.closeUser(user, "time is up");
        continue;
      }
      if (now < user.nextMessageAt) continue;
      void this.sendMessage(user);
    }
  }

  private async sendMessage(user: SimUser): Promise<void> {
    if (!user.handle) return;
    user.inFlight = true;
    user.abortController = new AbortController();
    const text = this.composeMessage(user);
    try {
      const result = await user.handle.sendMessage(
        text,
        user.abortController.signal,
      );
      if (this.users.get(user.id) !== user) return;
      this.recordMessage(user, result);
    } catch (err) {
      if (this.users.get(user.id) !== user) return;
      this.totalErrors += 1;
      this.event("error", "Message failed", `${user.name}: ${errorMessage(err)}`);
      await this.closeUser(user, "message error");
    } finally {
      if (this.users.get(user.id) === user) {
        user.inFlight = false;
        user.abortController = null;
      }
    }
  }

  private recordMessage(user: SimUser, result: MessageResult): void {
    const now = this.now();
    user.messagesSent += 1;
    user.lastLatencyMs = result.latencyMs;
    user.lastSummary = result.summary;
    user.hostPid = result.hostPid;
    user.nextMessageAt = now + nextDelayMs(this.rng, user.profile, this.settings.tempo);
    this.totalMessages += 1;
    this.messages.push({ at: now, value: 1 });
    this.latencies.push({ at: now, value: result.latencyMs });
    if (user.messagesSent >= user.messageBudget || now >= user.expiresAt) {
      void this.closeUser(user, "done");
    }
  }

  private composeMessage(user: SimUser): string {
    const turn = user.messagesSent + 1;
    const prompts = [
      "open workspace",
      "check files",
      "run tiny task",
      "summarize state",
      "save scratch note",
      "inspect context",
    ];
    return JSON.stringify({
      user: user.name,
      profile: user.profile.name,
      turn,
      prompt: this.rng.pick(prompts),
      noRealLlm: true,
      at: new Date(this.now()).toISOString(),
    });
  }

  private async closeUser(user: SimUser, reason: string): Promise<void> {
    if (user.state === "closing") return;
    this.users.delete(user.id);
    user.state = "closing";
    user.abortController?.abort();
    try {
      await user.handle?.close();
      this.event("info", "Closed", `${user.name}: ${reason}`);
    } catch (err) {
      this.totalErrors += 1;
      this.event("error", "Close failed", `${user.name}: ${errorMessage(err)}`);
    }
  }

  private closeExpiredUsers(now: number): void {
    for (const user of this.users.values()) {
      if (now >= user.expiresAt && !user.inFlight) {
        void this.closeUser(user, "expired");
      }
    }
  }

  private activeVmSlots(): number {
    let count = 0;
    for (const user of this.users.values()) {
      if (
        user.state === "starting" ||
        user.state === "live" ||
        user.state === "closing"
      ) {
        count += 1;
      }
    }
    return count;
  }

  private pruneSamples(now: number): void {
    prune(this.latencies, now);
    prune(this.messages, now);
    prune(this.starts, now);
  }

  private event(
    level: SimulatorEvent["level"],
    title: string,
    detail: string,
  ): void {
    this.events.push({ at: this.now(), level, title, detail });
    while (this.events.length > EVENT_LIMIT) this.events.shift();
  }
}

function prune(samples: TimeSample[], now: number): void {
  while (samples.length > 0 && now - samples[0]!.at > SAMPLE_WINDOW_MS) {
    samples.shift();
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * p)]!;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
