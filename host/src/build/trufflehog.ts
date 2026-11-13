import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { extractTarGz } from "../alpine/tar.ts";
import { cacheBaseDir, computeFileHash, downloadToBuffer } from "./helpers.ts";

import { fetchCachedJsonRegistry, normalizeSha256 } from "../registry.ts";

const TRUFFLEHOG_REGISTRY_SCHEMA = 1 as const;
const DEFAULT_TRUFFLEHOG_REF = "trufflehog:3.95.9";

type SupportedPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64";

type TrufflehogRegistryBuild = {
  /** tool version */
  version: string;
  /** target platform */
  platform: SupportedPlatform;
  /** binary archive url */
  url: string;
  /** binary archive checksum */
  sha256: string;
  /** extracted executable checksum */
  binarySha256: string;
};

type BuiltinTrufflehogRegistry = {
  /** registry schema version */
  schema: typeof TRUFFLEHOG_REGISTRY_SCHEMA;
  /** named refs mapped by platform to build ids */
  refs: Record<string, Partial<Record<SupportedPlatform, string>>>;
  /** build-id keyed sources */
  builds: Record<string, TrufflehogRegistryBuild>;
};

const COMPILED_TRUFFLEHOG_REGISTRY: BuiltinTrufflehogRegistry = {
  schema: TRUFFLEHOG_REGISTRY_SCHEMA,
  refs: {
    "trufflehog:3.95.9": {
      "darwin-arm64": "trufflehog-3.95.9-darwin-arm64",
      "darwin-x64": "trufflehog-3.95.9-darwin-x64",
      "linux-arm64": "trufflehog-3.95.9-linux-arm64",
      "linux-x64": "trufflehog-3.95.9-linux-x64",
    },
  },
  builds: {
    "trufflehog-3.95.9-darwin-arm64": {
      version: "3.95.9",
      platform: "darwin-arm64",
      url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.95.9/trufflehog_3.95.9_darwin_arm64.tar.gz",
      sha256:
        "944c6ea3a2993a9f808d08107b40e03ba92bc75972876a1ee47d567bfd6fa1b5",
      binarySha256:
        "8c6110728eca539ac188a149d8a1e0510e5e59e4d3e3f1ce9daa41fa4961814f",
    },
    "trufflehog-3.95.9-darwin-x64": {
      version: "3.95.9",
      platform: "darwin-x64",
      url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.95.9/trufflehog_3.95.9_darwin_amd64.tar.gz",
      sha256:
        "4306a58d25b85aad7b5fb6f5732df77c50a9161db2746b56e196649072218691",
      binarySha256:
        "aa50735703b18bbe849349f3169b6c8a72871f5a7ab38593f1a70df7cd1b1c81",
    },
    "trufflehog-3.95.9-linux-arm64": {
      version: "3.95.9",
      platform: "linux-arm64",
      url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.95.9/trufflehog_3.95.9_linux_arm64.tar.gz",
      sha256:
        "9d9c2ec4ea36a089a9c5aaafe1969d176013ddf9f44d68e8cd75291aed8c83ed",
      binarySha256:
        "6ee7f027fdbe0a2a65df30634aa4244db689614058e4409cdc4b2f5763ef84f2",
    },
    "trufflehog-3.95.9-linux-x64": {
      version: "3.95.9",
      platform: "linux-x64",
      url: "https://github.com/trufflesecurity/trufflehog/releases/download/v3.95.9/trufflehog_3.95.9_linux_amd64.tar.gz",
      sha256:
        "f6d1106b85107d79527ed7a5b98b592beadd8b770dc3c9e8c1ad99e1b2cf127e",
      binarySha256:
        "0f81bfd017e0501c0b2517c9c9cc5c1d26c4d3e8a2dfc2ae495da8a7b03acc77",
    },
  },
};

export interface EnsureTrufflehogOptions {
  /** explicit cache/store directory */
  storeDir?: string;
  /** optional logger */
  log?: (msg: string) => void;
}

export interface TrufflehogStatus {
  /** helper ref */
  ref: string;
  /** helper version */
  version: string;
  /** resolved platform key */
  platform: SupportedPlatform;
  /** managed install path */
  managedPath: string;
  /** whether a managed binary already exists */
  installed: boolean;
  /** download url for this platform */
  downloadUrl: string;
  /** build id */
  buildId: string;
}

export interface TrufflehogIdentity {
  /** helper ref */
  ref: string;
  /** helper version */
  version: string;
}

export function getTrufflehogStoreDirectory(): string {
  return path.join(cacheBaseDir(), "gondolin", "tools", "trufflehog");
}

function trufflehogRegistryUrl(value?: string): string | null {
  const explicit =
    value?.trim() || process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL?.trim();
  if (explicit) return explicit;
  return null;
}

function objectDir(storeDir: string, buildId: string): string {
  return path.join(storeDir, "objects", buildId);
}

function installedBinaryPath(storeDir: string, buildId: string): string {
  return path.join(objectDir(storeDir, buildId), "bin", "trufflehog");
}

function normalizeSupportedPlatform(value: string): SupportedPlatform | null {
  if (value === "darwin-arm64") return value;
  if (value === "darwin-x64") return value;
  if (value === "linux-arm64") return value;
  if (value === "linux-x64") return value;
  return null;
}

function resolveSupportedPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): SupportedPlatform {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "amd64")) {
    return "darwin-x64";
  }
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && (arch === "x64" || arch === "amd64")) {
    return "linux-x64";
  }
  throw new Error(
    `trufflehog helper is not available for this platform: ${platform}/${arch}`,
  );
}

function parseRef(reference: string): string {
  const trimmed = reference.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed)
  ) {
    throw new Error(`invalid trufflehog ref: ${reference}`);
  }
  return trimmed;
}

function parseRegistryBuild(
  raw: unknown,
  where: string,
  baseUrl: URL,
): TrufflehogRegistryBuild {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`invalid ${where}: expected object`);
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.version !== "string" || !rec.version) {
    throw new Error(`invalid ${where}.version: expected string`);
  }
  if (typeof rec.platform !== "string") {
    throw new Error(`invalid ${where}.platform: expected string`);
  }
  const platform = normalizeSupportedPlatform(rec.platform);
  if (!platform) {
    throw new Error(`invalid ${where}.platform: ${String(rec.platform)}`);
  }
  if (typeof rec.url !== "string") {
    throw new Error(`invalid ${where}.url: expected string`);
  }

  let url: string;
  try {
    url = new URL(rec.url, baseUrl).toString();
  } catch {
    throw new Error(`invalid ${where}.url: ${rec.url}`);
  }

  const build: TrufflehogRegistryBuild = {
    version: rec.version,
    platform,
    url,
    sha256: normalizeSha256(rec.sha256, `${where}.sha256`),
    binarySha256: normalizeSha256(rec.binarySha256, `${where}.binarySha256`),
  };

  return build;
}

function parseBuiltinTrufflehogRegistry(
  raw: unknown,
  sourceUrl: string,
): BuiltinTrufflehogRegistry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid builtin trufflehog registry: expected object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== TRUFFLEHOG_REGISTRY_SCHEMA) {
    throw new Error(
      `invalid builtin trufflehog registry schema: expected ${TRUFFLEHOG_REGISTRY_SCHEMA}`,
    );
  }
  const baseUrl = new URL(sourceUrl);

  if (
    !rec.builds ||
    typeof rec.builds !== "object" ||
    Array.isArray(rec.builds)
  ) {
    throw new Error(
      "invalid builtin trufflehog registry: builds must be an object",
    );
  }
  const builds: Record<string, TrufflehogRegistryBuild> = {};
  for (const [buildId, value] of Object.entries(
    rec.builds as Record<string, unknown>,
  )) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(buildId)) {
      throw new Error(`invalid builtin trufflehog build id: ${buildId}`);
    }
    builds[buildId] = parseRegistryBuild(
      value,
      `builds['${buildId}']`,
      baseUrl,
    );
  }

  if (!rec.refs || typeof rec.refs !== "object" || Array.isArray(rec.refs)) {
    throw new Error(
      "invalid builtin trufflehog registry: refs must be an object",
    );
  }
  const refs: Record<string, Partial<Record<SupportedPlatform, string>>> = {};
  for (const [reference, value] of Object.entries(
    rec.refs as Record<string, unknown>,
  )) {
    const canonical = parseRef(reference);
    if (canonical !== reference) {
      throw new Error(
        `invalid builtin trufflehog registry ref key: ${reference}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid registry ref '${reference}': expected object`);
    }
    const mapped: Partial<Record<SupportedPlatform, string>> = {};
    for (const [platformKey, buildIdValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const platform = normalizeSupportedPlatform(platformKey);
      if (!platform) {
        throw new Error(
          `invalid registry ref '${reference}' platform key: ${platformKey}`,
        );
      }
      if (typeof buildIdValue !== "string") {
        throw new Error(
          `invalid refs['${reference}']['${platformKey}']: expected build id string`,
        );
      }
      const build = builds[buildIdValue];
      if (!build) {
        throw new Error(
          `invalid refs['${reference}']['${platformKey}']: unknown build id ${buildIdValue}`,
        );
      }
      if (build.platform !== platform) {
        throw new Error(
          `invalid refs['${reference}']['${platformKey}']: platform mismatch for build ${buildIdValue}`,
        );
      }
      mapped[platform] = buildIdValue;
    }
    refs[canonical] = mapped;
  }

  return { schema: TRUFFLEHOG_REGISTRY_SCHEMA, refs, builds };
}

async function fetchBuiltinTrufflehogRegistry(options: {
  registryUrl?: string;
  storeDir?: string;
}): Promise<BuiltinTrufflehogRegistry> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const url = trufflehogRegistryUrl(options.registryUrl);
  if (!url) return COMPILED_TRUFFLEHOG_REGISTRY;
  return await fetchCachedJsonRegistry({
    url,
    storeDir,
    cacheFileName: "builtin-trufflehog-registry-cache.json",
    userAgent: "gondolin-trufflehog-registry",
    parse: parseBuiltinTrufflehogRegistry,
    label: "builtin trufflehog registry",
  });
}

async function resolveManagedBuild(
  storeDir: string,
  platform: SupportedPlatform,
): Promise<{ ref: string; buildId: string; build: TrufflehogRegistryBuild }> {
  const registry = await fetchBuiltinTrufflehogRegistry({ storeDir });
  const ref = parseRef(DEFAULT_TRUFFLEHOG_REF);
  const entries = registry.refs[ref];
  if (!entries) {
    throw new Error(`trufflehog ref not found in builtin registry: ${ref}`);
  }
  const buildId = entries[platform];
  if (!buildId) {
    throw new Error(
      `trufflehog ref '${ref}' has no registry source for ${platform}`,
    );
  }
  const build = registry.builds[buildId];
  if (!build) {
    throw new Error(
      `trufflehog ref '${ref}' points to unknown registry build id: ${buildId}`,
    );
  }
  return { ref, buildId, build };
}

function findBinary(rootDir: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "trufflehog") {
        return fullPath;
      }
    }
  }
  return null;
}

function isValidInstalledBinary(targetPath: string, sha256: string): boolean {
  try {
    if (!fs.lstatSync(targetPath).isFile()) return false;
    return computeFileHash(targetPath) === sha256;
  } catch {
    return false;
  }
}

async function installManagedBinary(
  storeDir: string,
  buildId: string,
  build: TrufflehogRegistryBuild,
  log?: (msg: string) => void,
): Promise<string> {
  const targetPath = installedBinaryPath(storeDir, buildId);
  const installDir = path.dirname(targetPath);
  if (isValidInstalledBinary(targetPath, build.binarySha256)) {
    return targetPath;
  }
  fs.rmSync(installDir, { recursive: true, force: true });

  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gondolin-trufflehog-"),
  );
  const archivePath = path.join(tmpRoot, "trufflehog.tar.gz");
  const extractDir = path.join(tmpRoot, "extract");

  try {
    log?.(`Downloading trufflehog ${build.version} for ${build.platform}`);
    fs.writeFileSync(
      archivePath,
      await downloadToBuffer(
        build.url,
        build.sha256,
        "gondolin-trufflehog-fetch",
      ),
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarGz(archivePath, extractDir);

    const binary = findBinary(extractDir);
    if (!binary) {
      throw new Error(
        "downloaded trufflehog archive did not contain a trufflehog binary",
      );
    }
    if (computeFileHash(binary) !== build.binarySha256) {
      throw new Error("extracted trufflehog binary checksum mismatch");
    }

    fs.mkdirSync(path.dirname(installDir), { recursive: true });
    if (!fs.existsSync(targetPath)) {
      const tmpInstallDir = `${installDir}.tmp-${randomUUID().slice(0, 8)}`;
      try {
        fs.mkdirSync(tmpInstallDir, { recursive: true });
        fs.copyFileSync(binary, path.join(tmpInstallDir, "trufflehog"));
        fs.chmodSync(path.join(tmpInstallDir, "trufflehog"), 0o755);
        fs.renameSync(tmpInstallDir, installDir);
      } catch (error) {
        fs.rmSync(tmpInstallDir, { recursive: true, force: true });
        if (!fs.existsSync(targetPath)) throw error;
      }
    }

    if (!isValidInstalledBinary(targetPath, build.binarySha256)) {
      fs.rmSync(installDir, { recursive: true, force: true });
      throw new Error("installed trufflehog binary checksum mismatch");
    }
    fs.chmodSync(targetPath, 0o755);
    return targetPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function ensureTrufflehogBinary(
  options: EnsureTrufflehogOptions = {},
): Promise<string> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { buildId, build } = await resolveManagedBuild(storeDir, platform);
  return await installManagedBinary(storeDir, buildId, build, options.log);
}

export async function getTrufflehogIdentity(
  options: Pick<EnsureTrufflehogOptions, "storeDir"> = {},
): Promise<TrufflehogIdentity> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { ref, build } = await resolveManagedBuild(storeDir, platform);
  return { ref, version: build.version };
}

export async function getTrufflehogStatus(
  options: Omit<EnsureTrufflehogOptions, "log"> = {},
): Promise<TrufflehogStatus> {
  const storeDir = options.storeDir ?? getTrufflehogStoreDirectory();
  const platform = resolveSupportedPlatform();
  const { ref, buildId, build } = await resolveManagedBuild(storeDir, platform);
  const managedPath = installedBinaryPath(storeDir, buildId);
  return {
    ref,
    version: build.version,
    platform,
    managedPath,
    installed: isValidInstalledBinary(managedPath, build.binarySha256),
    downloadUrl: build.url,
    buildId,
  };
}

export const __test = {
  defaultRef: DEFAULT_TRUFFLEHOG_REF,
  compiledRegistry: COMPILED_TRUFFLEHOG_REGISTRY,
  resolveSupportedPlatform,
  installedBinaryPath,
  isValidInstalledBinary,
  parseBuiltinTrufflehogRegistry,
  trufflehogRegistryUrl,
};
