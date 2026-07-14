import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

import {
  ensureTrufflehogBinary,
  getTrufflehogIdentity,
  type TrufflehogIdentity,
} from "./build/trufflehog.ts";

const DETECTOR_TIMEOUT_MS = 15_000;
const TRUFFLEHOG_MATCH_EXIT_CODE = 183;

type ReviewedSecretDetector = {
  /** managed helper ref reviewed with this detector */
  ref: string;
  /** managed helper version reviewed with this detector */
  version: string;
  /** TruffleHog detector numeric id */
  detectorId: number;
  /** TruffleHog detector display name */
  detectorName: string;
  /** whole-value secret shape */
  valuePattern: RegExp;
  /** reviewed substitution destinations */
  hosts: readonly string[];
};

const REVIEWED_SECRET_DETECTORS: readonly ReviewedSecretDetector[] = [
  {
    ref: "trufflehog:3.95.9",
    version: "3.95.9",
    detectorId: 8,
    detectorName: "Github",
    valuePattern: /^(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{36,255}$/,
    hosts: ["api.github.com"],
  },
];

type SpawnProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "ignore", "ignore"];
  },
) => ChildProcess;

type RunDetectorOptions = {
  /** managed TruffleHog binary path */
  binaryPath: string;
  /** secret value sent through child stdin */
  secretValue: string;
  /** reviewed detector numeric id */
  detectorId: number;
  /** parent-enforced timeout in `ms` */
  timeoutMs?: number;
  /** injectable process launcher for tests */
  spawnProcess?: SpawnProcess;
};

type SuggestionDependencies = {
  getIdentity: () => Promise<TrufflehogIdentity>;
  ensureBinary: () => Promise<string>;
  runDetector: (options: RunDetectorOptions) => Promise<boolean>;
};

export type SecretHostSuggestion = {
  /** suggested host name */
  host: string;
  /** reviewed detector evidence identifier */
  file: string;
  /** evidence line number or `0` for reviewed metadata */
  line: number;
  /** non-secret evidence summary */
  snippet: string;
  /** evidence hit count for this host */
  count: number;
};

export type SuggestSecretHostsOptions = {
  /** secret value to search for */
  secretValue: string;
};

function isWholeValueMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match?.[0] === value;
}

function matchingReviewedDetectors(value: string): ReviewedSecretDetector[] {
  return REVIEWED_SECRET_DETECTORS.filter((detector) =>
    isWholeValueMatch(detector.valuePattern, value),
  );
}

function minimalDetectorEnv(): NodeJS.ProcessEnv {
  return {
    HOME: "",
    LANG: "C",
    LC_ALL: "C",
    PATH: "",
    TMPDIR: os.tmpdir(),
  };
}

async function runTrufflehogDetector(
  options: RunDetectorOptions,
): Promise<boolean> {
  const spawnProcess: SpawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions) as ChildProcess);
  const args = [
    "stdin",
    "--no-update",
    "--no-verification",
    "--results=unverified",
    `--include-detectors=${options.detectorId}`,
    "--max-decode-depth=1",
    "--concurrency=1",
    "--log-level=-1",
    "--fail",
    "--fail-on-scan-errors",
  ];
  const child = spawnProcess(options.binaryPath, args, {
    cwd: os.tmpdir(),
    env: minimalDetectorEnv(),
    stdio: ["pipe", "ignore", "ignore"],
  });

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    const finish = (error: Error | null, matched = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(matched);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DETECTOR_TIMEOUT_MS);

    child.once("error", () => {
      finish(new Error("trufflehog secret detector failed to start"));
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error("trufflehog secret detector timed out"));
      } else if (signal !== null) {
        finish(new Error("trufflehog secret detector terminated unexpectedly"));
      } else if (code === TRUFFLEHOG_MATCH_EXIT_CODE) {
        finish(null, true);
      } else if (code === 0) {
        finish(null, false);
      } else {
        finish(new Error("trufflehog secret detector failed"));
      }
    });

    if (!child.stdin) {
      child.kill("SIGKILL");
      finish(new Error("trufflehog secret detector stdin is unavailable"));
      return;
    }
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        child.kill("SIGKILL");
        finish(new Error("trufflehog secret detector input failed"));
      }
    });
    child.stdin.end(`${options.secretValue}\n`);
  });
}

function mergeSuggestions(
  suggestions: SecretHostSuggestion[],
): SecretHostSuggestion[] {
  const merged = new Map<string, SecretHostSuggestion>();

  for (const suggestion of suggestions) {
    const existing = merged.get(suggestion.host);
    if (!existing) {
      merged.set(suggestion.host, suggestion);
      continue;
    }
    existing.count += suggestion.count;
  }

  return [...merged.values()].sort(
    (a, b) => b.count - a.count || a.host.localeCompare(b.host),
  );
}

async function suggestHostsForSecretWithDependencies(
  options: SuggestSecretHostsOptions,
  dependencies: SuggestionDependencies,
): Promise<SecretHostSuggestion[]> {
  if (!options.secretValue) return [];

  const candidates = matchingReviewedDetectors(options.secretValue);
  if (candidates.length === 0) return [];

  const identity = await dependencies.getIdentity();
  const reviewed = candidates.filter(
    (detector) =>
      detector.ref === identity.ref && detector.version === identity.version,
  );
  if (reviewed.length === 0) return [];

  const binaryPath = await dependencies.ensureBinary();
  const suggestions: SecretHostSuggestion[] = [];
  for (const detector of reviewed) {
    const matched = await dependencies.runDetector({
      binaryPath,
      secretValue: options.secretValue,
      detectorId: detector.detectorId,
    });
    if (!matched) continue;

    for (const host of detector.hosts) {
      suggestions.push({
        host,
        file: `reviewed/trufflehog-${detector.version}/detector-${detector.detectorId}`,
        line: 0,
        snippet: `${detector.detectorName} cloud endpoint`,
        count: 1,
      });
    }
  }

  return mergeSuggestions(suggestions);
}

export async function suggestHostsForSecret(
  options: SuggestSecretHostsOptions,
): Promise<SecretHostSuggestion[]> {
  return await suggestHostsForSecretWithDependencies(options, {
    getIdentity: getTrufflehogIdentity,
    ensureBinary: ensureTrufflehogBinary,
    runDetector: runTrufflehogDetector,
  });
}

export const __test = {
  reviewedSecretDetectors: REVIEWED_SECRET_DETECTORS,
  isWholeValueMatch,
  matchingReviewedDetectors,
  minimalDetectorEnv,
  runTrufflehogDetector,
  mergeSuggestions,
  suggestHostsForSecretWithDependencies,
};
