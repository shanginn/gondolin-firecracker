import type { Rng } from "./rng.ts";

export type BehaviorProfileName =
  | "one-shot"
  | "quick-burst"
  | "long-lounge"
  | "minute-beat"
  | "tab-hop"
  | "hyperdrive";

export type BehaviorProfile = {
  /** Stable profile key */
  name: BehaviorProfileName;
  /** Dashboard label */
  label: string;
  /** Dashboard accent color */
  color: string;
  /** Relative selection weight */
  weight: number;
  /** Minimum session lifetime in `ms` */
  minLifetimeMs: number;
  /** Maximum session lifetime in `ms` */
  maxLifetimeMs: number;
  /** Minimum message budget */
  minMessages: number;
  /** Maximum message budget */
  maxMessages: number;
  /** Minimum message delay in `ms` */
  minDelayMs: number;
  /** Maximum message delay in `ms` */
  maxDelayMs: number;
  /** Chance that the next delay stretches longer */
  idleChance: number;
  /** Maximum idle stretch multiplier */
  idleMultiplier: number;
};

export type UserPlan = {
  /** Assigned behavior profile */
  profile: BehaviorProfile;
  /** Session expiration time in Unix `ms` */
  expiresAt: number;
  /** Planned message count */
  messageBudget: number;
};

export const BEHAVIOR_PROFILES: readonly BehaviorProfile[] = [
  {
    name: "one-shot",
    label: "One Hit",
    color: "#ff4d6d",
    weight: 16,
    minLifetimeMs: 8_000,
    maxLifetimeMs: 35_000,
    minMessages: 1,
    maxMessages: 1,
    minDelayMs: 500,
    maxDelayMs: 2_000,
    idleChance: 0,
    idleMultiplier: 1,
  },
  {
    name: "quick-burst",
    label: "Burst Run",
    color: "#ffb703",
    weight: 24,
    minLifetimeMs: 20_000,
    maxLifetimeMs: 90_000,
    minMessages: 3,
    maxMessages: 10,
    minDelayMs: 700,
    maxDelayMs: 5_000,
    idleChance: 0.08,
    idleMultiplier: 4,
  },
  {
    name: "long-lounge",
    label: "Long Lounge",
    color: "#2ec4b6",
    weight: 18,
    minLifetimeMs: 4 * 60_000,
    maxLifetimeMs: 25 * 60_000,
    minMessages: 6,
    maxMessages: 80,
    minDelayMs: 12_000,
    maxDelayMs: 75_000,
    idleChance: 0.18,
    idleMultiplier: 6,
  },
  {
    name: "minute-beat",
    label: "Minute Beat",
    color: "#4cc9f0",
    weight: 16,
    minLifetimeMs: 3 * 60_000,
    maxLifetimeMs: 18 * 60_000,
    minMessages: 3,
    maxMessages: 40,
    minDelayMs: 45_000,
    maxDelayMs: 75_000,
    idleChance: 0.05,
    idleMultiplier: 3,
  },
  {
    name: "tab-hop",
    label: "Tab Hop",
    color: "#a78bfa",
    weight: 14,
    minLifetimeMs: 90_000,
    maxLifetimeMs: 12 * 60_000,
    minMessages: 2,
    maxMessages: 28,
    minDelayMs: 2_000,
    maxDelayMs: 18_000,
    idleChance: 0.35,
    idleMultiplier: 10,
  },
  {
    name: "hyperdrive",
    label: "Hyperdrive",
    color: "#f15bb5",
    weight: 8,
    minLifetimeMs: 25_000,
    maxLifetimeMs: 3 * 60_000,
    minMessages: 10,
    maxMessages: 80,
    minDelayMs: 250,
    maxDelayMs: 1_800,
    idleChance: 0.03,
    idleMultiplier: 3,
  },
];

export function pickProfile(rng: Rng): BehaviorProfile {
  const total = BEHAVIOR_PROFILES.reduce((sum, p) => sum + p.weight, 0);
  let roll = rng.next() * total;
  for (const profile of BEHAVIOR_PROFILES) {
    roll -= profile.weight;
    if (roll <= 0) return profile;
  }
  return BEHAVIOR_PROFILES[BEHAVIOR_PROFILES.length - 1]!;
}

export function createUserPlan(
  rng: Rng,
  now: number,
  maxLifetimeMs: number,
): UserPlan {
  const profile = pickProfile(rng);
  const lifetimeMs = Math.min(
    maxLifetimeMs,
    rng.integer(profile.minLifetimeMs, profile.maxLifetimeMs),
  );
  return {
    profile,
    expiresAt: now + Math.max(1_000, lifetimeMs),
    messageBudget: rng.integer(profile.minMessages, profile.maxMessages),
  };
}

export function nextDelayMs(
  rng: Rng,
  profile: BehaviorProfile,
  tempo: number,
): number {
  const base = rng.integer(profile.minDelayMs, profile.maxDelayMs);
  const stretched =
    rng.next() < profile.idleChance
      ? base * rng.integer(2, profile.idleMultiplier)
      : base;
  return Math.max(100, Math.round(stretched / Math.max(0.1, tempo)));
}
