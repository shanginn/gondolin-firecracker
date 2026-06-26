import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { getHostNodeArchCached } from "../host/arch.ts";
import {
  debugFlagsToArray,
  parseDebugEnv,
  resolveDebugFlags,
  type DebugConfig,
  type DebugFlag,
} from "../debug.ts";
import {
  ensureGuestAssets,
  loadAssetManifest,
  loadGuestAssets,
  resolveGuestAssetsSync,
  type GuestAssets,
} from "../assets.ts";
import { ensureImageSelector, resolveImageSelector } from "../images.ts";
import type { HttpFetch } from "../http/contracts.ts";
import {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
  type DnsOptions,
  type HttpHooks,
} from "../net/backend.ts";
import type { SshOptions } from "../net/ssh.ts";
import type { TcpOptions } from "../net/tcp.ts";
import { assertRawDiskImage } from "../disk/image.ts";
import type { VirtualProvider } from "../vfs/node/index.ts";

/**
 * Path or selector for guest image assets
 *
 * Can be either:
 * - A string path to a directory containing the assets (vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4)
 * - A string image selector (ref like `name:tag` or a build id)
 * - An object with explicit paths to each asset file
 */
export type ImagePath = string | GuestAssets;

/** vm backend implementation */
export type SandboxVmm = "firecracker";

const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUED_STDIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_EXECS = 64;
const DEFAULT_FIRECRACKER_MEMORY = "84M";
const DEFAULT_FIRECRACKER_CPUS = 1;

/**
 * sandbox server options
 *
 * imagePath can be either:
 * - a directory containing the guest assets (kernel/initrd/rootfs)
 * - an object with explicit asset paths
 */
export type SandboxServerOptions = {
  /** firecracker binary path */
  firecrackerPath?: string;
  /** firecracker API socket path */
  firecrackerApiSocketPath?: string;
  /** firecracker vsock base Unix socket path */
  firecrackerVsockPath?: string;
  /** firecracker guest vsock CID */
  firecrackerGuestCid?: number;
  /** guest asset directory or explicit asset paths */
  imagePath?: ImagePath;
  /** vm memory size (e.g. "1G") */
  memory?: string;
  /** vm cpu count */
  cpus?: number;
  /** vsock control socket path */
  virtioSocketPath?: string;
  /** vsock vfs socket path */
  virtioFsSocketPath?: string;
  /** vsock ssh socket path */
  virtioSshSocketPath?: string;

  /** vsock ingress socket path */
  virtioIngressSocketPath?: string;
  /** host TAP interface name */
  netTapName?: string;
  /** guest mac address */
  netMac?: string;
  /** whether to enable networking */
  netEnabled?: boolean;
  /** whether to allow WebSocket upgrades for guest egress */
  allowWebSockets?: boolean;
  /**
   * Root disk image path (attached as `/dev/vda`)
   *
   * If omitted, uses the base rootfs image from the guest assets.
   */
  rootDiskPath?: string;

  /** root disk image format */
  rootDiskFormat?: "raw";

  /** readonly mode for the root disk */
  rootDiskReadOnly?: boolean;

  /**
   * Delete the root disk image on VM close
   *
   * This is a host-side lifecycle hint. It is currently only honored by the
   * higher-level {@link VM} wrapper.
   */
  rootDiskDeleteOnClose?: boolean;

  /**
   * Debug configuration
   *
   * - `true`: enable all debug components
   * - `false`: disable all debug components
   * - `string[]`: enable selected components (e.g. `["net", "exec"]`)
   *
   * If omitted, defaults to `GONDOLIN_DEBUG`.
   */
  debug?: DebugConfig;
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart?: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes?: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes?: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes?: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs?: number;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;
  /** dns configuration */
  dns?: DnsOptions;
  /** ssh egress configuration */
  ssh?: SshOptions;
  /** explicit host-mapped tcp egress configuration */
  tcp?: TcpOptions;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes?: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes?: number;
  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider?: VirtualProvider;
};

export type ResolvedSandboxServerOptions = {
  /** vm backend implementation */
  vmm: SandboxVmm;
  /** firecracker binary path */
  firecrackerPath: string;
  /** firecracker API socket path */
  firecrackerApiSocketPath: string;
  /** firecracker vsock base Unix socket path */
  firecrackerVsockPath: string;
  /** firecracker guest vsock CID */
  firecrackerGuestCid: number;
  /** kernel image path */
  kernelPath: string;
  /** initrd/initramfs image path */
  initrdPath: string;
  /** rootfs image path */
  rootfsPath: string;

  /** root disk image path (attached as `/dev/vda`) */
  rootDiskPath: string;
  /** root disk image format */
  rootDiskFormat: "raw";
  /** readonly mode for the root disk */
  rootDiskReadOnly: boolean;

  /** vm memory size (e.g. "84M") */
  memory: string;
  /** vm cpu count */
  cpus: number;
  /** vsock control socket path */
  virtioSocketPath: string;
  /** vsock vfs socket path */
  virtioFsSocketPath: string;
  /** vsock ssh socket path */
  virtioSshSocketPath: string;

  /** vsock ingress socket path */
  virtioIngressSocketPath: string;
  /** host TAP interface name */
  netTapName: string;
  /** guest mac address */
  netMac: string;
  /** whether networking is enabled */
  netEnabled: boolean;
  /** whether to allow WebSocket upgrades for guest egress */
  allowWebSockets: boolean;
  /** enabled debug components */
  debug: DebugFlag[];
  /** guest console mode */
  console?: "stdio" | "none";
  /** whether to restart the vm automatically on exit */
  autoRestart: boolean;
  /** kernel cmdline append string */
  append?: string;

  /** max stdin buffered per process in `bytes` */
  maxStdinBytes: number;
  /** max stdin buffered for a single queued (not yet active) exec in `bytes` */
  maxQueuedStdinBytes: number;
  /** max total stdin buffered across all queued (not yet active) execs in `bytes` */
  maxTotalQueuedStdinBytes: number;
  /** max total exec pressure (running + queued-to-start) */
  maxQueuedExecs: number;
  /** http fetch implementation for asset downloads */
  fetch?: HttpFetch;
  /** http interception hooks */
  httpHooks?: HttpHooks;
  /** dns configuration */
  dns?: DnsOptions;
  /** ssh egress configuration */
  ssh?: SshOptions;
  /** explicit host-mapped tcp egress configuration */
  tcp?: TcpOptions;
  /** max intercepted http request body size in `bytes` */
  maxHttpBodyBytes: number;
  /** max buffered upstream http response body size in `bytes` */
  maxHttpResponseBodyBytes: number;
  /** mitm ca directory path */
  mitmCertDir?: string;
  /** vfs provider to expose under the fuse mount */
  vfsProvider: VirtualProvider | null;
};

export type GuestFileReadOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** preferred chunk size in `bytes` */
  chunkSize?: number;
  /** abort signal for the read request */
  signal?: AbortSignal;
  /** stream highWaterMark in `bytes` */
  highWaterMark?: number;
};

export type GuestFileWriteOptions = {
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the write request */
  signal?: AbortSignal;
};

export type GuestFileDeleteOptions = {
  /** ignore missing paths */
  force?: boolean;
  /** recursive delete for directories */
  recursive?: boolean;
  /** working directory for relative paths */
  cwd?: string;
  /** abort signal for the delete request */
  signal?: AbortSignal;
};

type ResolvedImagePath = {
  /** resolved guest asset paths */
  assets: GuestAssets;
  /** resolved image directory when available */
  imageDir: string | null;
  /** whether caller supplied explicit asset object */
  explicitAssetObject: boolean;
};

/**
 * Resolve imagePath selector to guest assets and optional image directory.
 */
function resolveImagePath(imagePath: ImagePath): ResolvedImagePath {
  if (typeof imagePath === "string") {
    const resolved = resolveImageSelector(imagePath);
    return {
      assets: loadGuestAssets(resolved.assetDir),
      imageDir: resolved.assetDir,
      explicitAssetObject: false,
    };
  }

  return {
    assets: imagePath,
    imageDir: null,
    explicitAssetObject: true,
  };
}

function normalizeArch(
  value: string | null | undefined,
): "arm64" | "x64" | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "arm64" || lower === "aarch64") return "arm64";
  if (lower === "x64" || lower === "x86_64" || lower === "amd64") return "x64";
  return null;
}

function parseMemoryToMiB(value: string, backend: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)([kKmMgGtT]?)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid vm memory value for ${backend} backend: ${JSON.stringify(value)}`,
    );
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();

  let bytes = amount;
  if (unit === "K") bytes *= 1024;
  else if (unit === "M" || unit === "") bytes *= 1024 * 1024;
  else if (unit === "G") bytes *= 1024 * 1024 * 1024;
  else if (unit === "T") bytes *= 1024 * 1024 * 1024 * 1024;

  const mib = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
  if (!Number.isSafeInteger(mib) || mib > 0xffffffff) {
    throw new Error(`vm memory is too large for ${backend} backend: ${value}`);
  }

  return mib;
}

function validateCpuCount(value: number, backend: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error(`invalid vm cpu count for ${backend} backend: ${value}`);
  }
}

function resolveDefaultFirecrackerPath(): string {
  return process.env.GONDOLIN_FIRECRACKER?.trim() || "firecracker";
}

function resolveRuntimeDir(): string {
  const envDir = process.env.GONDOLIN_RUNTIME_DIR?.trim();
  if (envDir) return path.resolve(envDir);

  // macOS has tighter unix socket path limits in the default temp dir and we
  // already standardize on /tmp elsewhere.
  return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

const LINUX_UNIX_SOCKET_PATH_MAX_BYTES = 107;

function validateLinuxUnixSocketPath(
  socketPath: string,
  fieldName: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") return;

  const bytes = Buffer.byteLength(socketPath);
  if (bytes <= LINUX_UNIX_SOCKET_PATH_MAX_BYTES) return;

  throw new Error(
    `${fieldName} is too long for a Linux Unix socket path ` +
      `(${bytes} bytes, max ${LINUX_UNIX_SOCKET_PATH_MAX_BYTES}). ` +
      "Set GONDOLIN_RUNTIME_DIR to a short writable directory such as /run/gondolin, " +
      "or provide explicit Firecracker socket paths.",
  );
}

function validateFirecrackerSocketPaths(
  apiSocketPath: string,
  vsockPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  validateLinuxUnixSocketPath(
    apiSocketPath,
    "sandbox.firecrackerApiSocketPath",
    platform,
  );
  validateLinuxUnixSocketPath(
    vsockPath,
    "sandbox.firecrackerVsockPath",
    platform,
  );
  for (const port of [1024, 1025, 1026, 1027]) {
    validateLinuxUnixSocketPath(
      `${vsockPath}_${port}`,
      `sandbox.firecrackerVsockPath channel ${port}`,
      platform,
    );
  }
}

function validateTapName(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(value)) {
    throw new Error(
      `invalid sandbox.netTapName: ${JSON.stringify(value)} (expected 1-15 chars: A-Z a-z 0-9 _ . -)`,
    );
  }
  return value;
}

type FirecrackerKernelOverride = {
  /** replacement kernel image path */
  kernelPath: string;
  /** replacement initrd path */
  initrdPath: string;
};

function resolveManifestAssetPath(
  imageDir: string,
  relPath: string,
  fieldName: string,
): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(
      `${fieldName} must be relative to image dir, got ${relPath}`,
    );
  }

  const resolved = path.resolve(imageDir, relPath);
  const relative = path.relative(imageDir, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${fieldName} must stay within image dir, got ${relPath}`);
  }

  return resolved;
}

function resolveFirecrackerKernelOverride(
  imageManifest: ReturnType<typeof loadAssetManifest>,
  imageDir: string | null,
): FirecrackerKernelOverride | null {
  const assets = imageManifest?.assets as
    | {
        firecrackerKernel?: string;
        firecrackerInitrd?: string | null;
      }
    | undefined;
  if (!imageDir || !assets?.firecrackerKernel) {
    return null;
  }

  const kernelPath = resolveManifestAssetPath(
    imageDir,
    assets.firecrackerKernel,
    "manifest.assets.firecrackerKernel",
  );

  if (!fs.existsSync(kernelPath)) {
    throw new Error(
      `manifest.assets.firecrackerKernel points to missing file: ${assets.firecrackerKernel}`,
    );
  }

  const fallbackInitramfs = imageManifest?.assets?.initramfs;
  let initrdPath: string;
  if (assets.firecrackerInitrd === null) {
    // ponytail: sentinel path; FirecrackerController skips missing initrd files.
    initrdPath = path.join(imageDir, ".gondolin-no-firecracker-initrd");
  } else if (assets.firecrackerInitrd) {
    initrdPath = resolveManifestAssetPath(
      imageDir,
      assets.firecrackerInitrd,
      "manifest.assets.firecrackerInitrd",
    );
    if (!fs.existsSync(initrdPath)) {
      throw new Error(
        `manifest.assets.firecrackerInitrd points to missing file: ${assets.firecrackerInitrd}`,
      );
    }
  } else if (fallbackInitramfs) {
    initrdPath = resolveManifestAssetPath(
      imageDir,
      fallbackInitramfs,
      "manifest.assets.initramfs",
    );
  } else {
    return null;
  }

  return {
    kernelPath,
    initrdPath,
  };
}

function findCommonAssetDir(assets: Partial<GuestAssets>): string | null {
  const kernelDir = assets.kernelPath ? path.dirname(assets.kernelPath) : null;
  const initrdDir = assets.initrdPath ? path.dirname(assets.initrdPath) : null;
  const rootfsDir = assets.rootfsPath ? path.dirname(assets.rootfsPath) : null;

  if (!kernelDir || !initrdDir || !rootfsDir) return null;
  if (kernelDir !== initrdDir || kernelDir !== rootfsDir) return null;
  return kernelDir;
}

function isPathWithinOrEqual(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function findSharedAssetAncestor(assets: Partial<GuestAssets>): string | null {
  const assetPaths = [assets.kernelPath, assets.initrdPath, assets.rootfsPath];
  if (assetPaths.some((value) => !value)) {
    return null;
  }

  let candidate = path.dirname(path.resolve(assetPaths[0]!));

  for (const rawPath of assetPaths.slice(1)) {
    const current = path.dirname(path.resolve(rawPath!));

    while (!isPathWithinOrEqual(candidate, current)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }
  }

  return candidate;
}

function manifestMatchesAssets(
  manifestDir: string,
  assets: Partial<GuestAssets>,
): boolean {
  if (!assets.kernelPath || !assets.initrdPath || !assets.rootfsPath) {
    return false;
  }

  const manifest = loadAssetManifest(manifestDir);
  if (!manifest) {
    return false;
  }

  const assetFiles = manifest.assets ?? {
    kernel: "vmlinuz-virt",
    initramfs: "initramfs.cpio.lz4",
    rootfs: "rootfs.ext4",
  };

  try {
    const kernelPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.kernel,
      "manifest.assets.kernel",
    );
    const initrdPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.initramfs,
      "manifest.assets.initramfs",
    );
    const rootfsPath = resolveManifestAssetPath(
      manifestDir,
      assetFiles.rootfs,
      "manifest.assets.rootfs",
    );

    return (
      path.resolve(kernelPath) === path.resolve(assets.kernelPath) &&
      path.resolve(initrdPath) === path.resolve(assets.initrdPath) &&
      path.resolve(rootfsPath) === path.resolve(assets.rootfsPath)
    );
  } catch {
    return false;
  }
}

function resolveImageDirFromAssets(
  assets: Partial<GuestAssets>,
): string | null {
  const sharedAncestor = findSharedAssetAncestor(assets);
  if (sharedAncestor) {
    let dir = sharedAncestor;
    for (;;) {
      if (manifestMatchesAssets(dir, assets)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  const commonDir = findCommonAssetDir(assets);
  if (commonDir && manifestMatchesAssets(commonDir, assets)) {
    return commonDir;
  }

  return null;
}

function detectGuestArchFromManifest(assets: Partial<GuestAssets>): {
  arch: "arm64" | "x64";
  manifestPath: string;
} | null {
  const dir = resolveImageDirFromAssets(assets);
  if (!dir) return null;

  const manifest = loadAssetManifest(dir);
  const arch = normalizeArch(manifest?.config?.arch);
  if (!manifest || !arch) return null;

  return { arch, manifestPath: path.join(dir, "manifest.json") };
}

/**
 * Resolve server options synchronously.
 *
 * This version uses local development paths if available. For production use,
 * prefer `resolveSandboxServerOptionsAsync` which will download assets if needed.
 *
 * @param options User-provided options
 * @param assets Optional pre-resolved guest assets (from ensureGuestAssets)
 */
type ResolveSandboxServerOptionsDeps = {
  /** test-only host platform override */
  platform?: NodeJS.Platform;
};

export function resolveSandboxServerOptions(
  options: SandboxServerOptions = {},
  assets?: GuestAssets,
  deps: ResolveSandboxServerOptionsDeps = {},
): ResolvedSandboxServerOptions {
  if (Object.hasOwn(options as object, "rootDiskSnapshot")) {
    throw new Error(
      "sandbox.rootDiskSnapshot has been removed; use VM rootfs.mode='cow' for a throwaway raw root disk copy",
    );
  }
  const platform = deps.platform ?? process.platform;

  // Resolve image paths: explicit imagePath > assets parameter > local dev paths
  let resolvedAssets: Partial<GuestAssets>;
  let explicitImageObject = false;
  let imageDir: string | null = null;

  if (options.imagePath !== undefined) {
    const resolvedImagePath = resolveImagePath(options.imagePath);
    resolvedAssets = resolvedImagePath.assets;
    explicitImageObject = resolvedImagePath.explicitAssetObject;
    imageDir = resolvedImagePath.imageDir;
  } else if (assets) {
    resolvedAssets = assets;
  } else {
    resolvedAssets = resolveGuestAssetsSync() ?? {};
  }

  if (!imageDir) {
    imageDir = resolveImageDirFromAssets(resolvedAssets);
  }

  const baseKernelPath = resolvedAssets.kernelPath;
  const baseInitrdPath = resolvedAssets.initrdPath;
  const rootfsPath = resolvedAssets.rootfsPath;

  const tmpDir = resolveRuntimeDir();
  const defaultFirecrackerApiSocket = path.resolve(
    tmpDir,
    `gondolin-firecracker-api-${randomUUID().slice(0, 8)}.sock`,
  );
  const defaultFirecrackerVsock = path.resolve(
    tmpDir,
    `gondolin-firecracker-vsock-${randomUUID().slice(0, 8)}.sock`,
  );
  const hostArch = getHostNodeArchCached();
  const envDebugFlags = parseDebugEnv();
  const resolvedDebugFlags = resolveDebugFlags(options.debug, envDebugFlags);
  const debug = debugFlagsToArray(resolvedDebugFlags);

  const vmm: SandboxVmm = "firecracker";
  const memory = options.memory ?? DEFAULT_FIRECRACKER_MEMORY;
  const cpus = options.cpus ?? DEFAULT_FIRECRACKER_CPUS;
  const firecrackerPath =
    options.firecrackerPath ?? resolveDefaultFirecrackerPath();
  const firecrackerApiSocketPath =
    options.firecrackerApiSocketPath ?? defaultFirecrackerApiSocket;
  const firecrackerVsockPath =
    options.firecrackerVsockPath ?? defaultFirecrackerVsock;
  const firecrackerGuestCid = options.firecrackerGuestCid ?? 3;
  const netEnabled = options.netEnabled ?? false;
  const netTapName = validateTapName(
    options.netTapName ?? `gtap${randomUUID().replace(/-/g, "").slice(0, 8)}`,
  );
  const netMac = options.netMac ?? "02:00:00:00:00:01";

  const supportedKeys = new Set([
    "firecrackerPath",
    "firecrackerApiSocketPath",
    "firecrackerVsockPath",
    "firecrackerGuestCid",
    "imagePath",
    "memory",
    "cpus",
    "rootDiskPath",
    "rootDiskFormat",
    "rootDiskReadOnly",
    "rootDiskDeleteOnClose",
    "netEnabled",
    "netTapName",
    "netMac",
    "allowWebSockets",
    "debug",
    "console",
    "autoRestart",
    "append",
    "maxStdinBytes",
    "maxQueuedStdinBytes",
    "maxTotalQueuedStdinBytes",
    "maxQueuedExecs",
    "fetch",
    "httpHooks",
    "dns",
    "ssh",
    "tcp",
    "maxHttpBodyBytes",
    "maxHttpResponseBodyBytes",
    "mitmCertDir",
    "vfsProvider",
  ]);
  const unsupported = Object.keys(options)
    .filter((key) => !supportedKeys.has(key))
    .map((key) => `sandbox.${key}`);

  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Firecracker option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`,
    );
  }

  if (platform !== "linux") {
    throw new Error(
      "Firecracker backend requires Linux/KVM and is not supported on this host platform.",
    );
  }

  if (!Number.isInteger(firecrackerGuestCid) || firecrackerGuestCid < 3) {
    throw new Error(
      `invalid sandbox.firecrackerGuestCid: ${String(firecrackerGuestCid)} (expected integer >= 3)`,
    );
  }

  validateFirecrackerSocketPaths(
    firecrackerApiSocketPath,
    firecrackerVsockPath,
    platform,
  );
  parseMemoryToMiB(memory, "Firecracker");
  validateCpuCount(cpus, "Firecracker");

  const imageManifest = imageDir ? loadAssetManifest(imageDir) : null;

  let kernelPath = baseKernelPath;
  let initrdPath = baseInitrdPath;
  let firecrackerKernelOverride: FirecrackerKernelOverride | null = null;

  if (!explicitImageObject) {
    firecrackerKernelOverride = resolveFirecrackerKernelOverride(
      imageManifest,
      imageDir,
    );
    if (firecrackerKernelOverride) {
      kernelPath = firecrackerKernelOverride.kernelPath;
      initrdPath = firecrackerKernelOverride.initrdPath;
    }
  }

  if (!kernelPath || !initrdPath || !rootfsPath) {
    throw new Error(
      "Guest assets not found. Either:\n" +
        "  1. Run from the gondolin repository with built guest images\n" +
        "  2. Use SandboxServer.create() to auto-download assets\n" +
        "  3. Provide imagePath option (asset directory, image selector, or explicit paths)\n" +
        "  4. Set GONDOLIN_GUEST_DIR to a directory containing the assets",
    );
  }

  // Fail fast if we can detect that the guest image doesn't match the selected backend target.
  // Without this, the VM often just "hangs" until some higher-level timeout.
  const guestFromManifest = detectGuestArchFromManifest({
    kernelPath: baseKernelPath,
    initrdPath: baseInitrdPath,
    rootfsPath,
  });

  if (guestFromManifest) {
    const host = normalizeArch(hostArch);
    if (host && guestFromManifest.arch !== host) {
      throw new Error(
        "Guest image architecture mismatch for Firecracker backend.\n" +
          `  guest assets: ${guestFromManifest.arch} (from ${guestFromManifest.manifestPath})\n` +
          `  host arch:    ${host}\n\n` +
          "Fix: select a guest image that matches the Firecracker host architecture.",
      );
    }
  }

  if (!explicitImageObject && !firecrackerKernelOverride) {
    throw new Error(
      "Selected image does not provide Firecracker boot assets.\n" +
        "Expected manifest assets `firecrackerKernel` (and optional `firecrackerInitrd`).\n" +
        "Fix: use an image built with `gondolin build` or choose a published image that includes Firecracker assets.",
    );
  }

  const rootDiskPath = options.rootDiskPath ?? rootfsPath;
  const rootDiskFormat = options.rootDiskFormat ?? "raw";
  const rootDiskReadOnly = options.rootDiskReadOnly ?? false;
  assertRawDiskImage(rootDiskPath);

  const maxStdinBytes = options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES;
  const maxQueuedStdinBytes = Math.max(
    options.maxQueuedStdinBytes ?? DEFAULT_MAX_QUEUED_STDIN_BYTES,
    maxStdinBytes,
  );
  const maxTotalQueuedStdinBytes = Math.max(
    options.maxTotalQueuedStdinBytes ?? DEFAULT_MAX_TOTAL_QUEUED_STDIN_BYTES,
    maxQueuedStdinBytes,
  );

  return {
    vmm,
    firecrackerPath,
    firecrackerApiSocketPath,
    firecrackerVsockPath,
    firecrackerGuestCid,
    kernelPath,
    initrdPath,
    rootfsPath,
    rootDiskPath,
    rootDiskFormat,
    rootDiskReadOnly,
    memory,
    cpus,
    virtioSocketPath: `${firecrackerVsockPath}_1024`,
    virtioFsSocketPath: `${firecrackerVsockPath}_1025`,
    virtioSshSocketPath: `${firecrackerVsockPath}_1026`,
    virtioIngressSocketPath: `${firecrackerVsockPath}_1027`,
    netTapName,
    netMac,
    netEnabled,
    allowWebSockets: options.allowWebSockets ?? true,
    debug,
    console: options.console,
    autoRestart: options.autoRestart ?? false,
    append: options.append,
    maxStdinBytes,
    maxQueuedStdinBytes,
    maxTotalQueuedStdinBytes,
    maxQueuedExecs: options.maxQueuedExecs ?? DEFAULT_MAX_QUEUED_EXECS,
    fetch: options.fetch,
    httpHooks: options.httpHooks,
    dns: options.dns,
    ssh: options.ssh,
    tcp: options.tcp,
    maxHttpBodyBytes: options.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
    maxHttpResponseBodyBytes:
      options.maxHttpResponseBodyBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BODY_BYTES,
    mitmCertDir: options.mitmCertDir,
    vfsProvider: options.vfsProvider ?? null,
  };
}

/**
 * Resolve server options asynchronously, downloading guest assets if needed.
 *
 * This is the recommended way to get resolved options for production use.
 */
export async function resolveSandboxServerOptionsAsync(
  options: SandboxServerOptions = {},
): Promise<ResolvedSandboxServerOptions> {
  // Explicit object imagePath is already fully resolved.
  if (options.imagePath && typeof options.imagePath === "object") {
    return resolveSandboxServerOptions(options);
  }

  // String image selectors may require pulling from the builtin registry.
  if (typeof options.imagePath === "string") {
    const resolvedImage = await ensureImageSelector(options.imagePath);
    return resolveSandboxServerOptions({
      ...options,
      imagePath: resolvedImage.assetDir,
    });
  }

  const assets = await ensureGuestAssets();
  return resolveSandboxServerOptions(options, assets);
}

export const __test = {
  resolveRuntimeDir,
  validateLinuxUnixSocketPath,
  validateTapName,
};
