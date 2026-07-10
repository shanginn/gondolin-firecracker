import { createErrnoError } from "./errors.ts";
import type {
  VirtualProvider,
  VirtualFileHandle,
  VfsStatfs,
} from "./node/index.ts";
import { delegateStatfsOrEnosys } from "./statfs.ts";
import { ERRNO, VirtualProviderClass } from "./utils.ts";

export type VfsHookContext = {
  /** operation name */
  op: string;
  /** primary path */
  path?: string;
  /** source path for rename/link */
  oldPath?: string;
  /** destination path for rename/link */
  newPath?: string;
  /** open flags */
  flags?: string | number;
  /** file mode bits */
  mode?: number;
  /** file handle id */
  fh?: number;
  /** file offset in `bytes` */
  offset?: number;
  /** length in `bytes` */
  length?: number;
  /** size in `bytes` */
  size?: number;
  /** payload bytes */
  data?: Buffer;
  /** operation result */
  result?: unknown;
};

export type VfsHooks = {
  /** hook called before the operation */
  before?: (context: VfsHookContext) => void | Promise<void>;
  /** hook called after the operation */
  after?: (context: VfsHookContext) => void | Promise<void>;
};

class HookedHandle implements VirtualFileHandle {
  private readonly inner: VirtualFileHandle;
  private readonly hooks: VfsHooks;
  private readonly handlePath: string;

  constructor(inner: VirtualFileHandle, hooks: VfsHooks, handlePath: string) {
    this.inner = inner;
    this.hooks = hooks;
    this.handlePath = handlePath;
  }

  get path() {
    // Always report the path that was used to open the handle.
    //
    // Many backend providers expose a handle-local `path` property that is
    // relative to the provider's mount root (e.g. "/listeners" for a mount
    // at "/etc/gondolin").  VFS hooks, however, operate on the *guest-visible*
    // paths that flow through the mounted provider (e.g. "/etc/gondolin/listeners").
    //
    // Using the backend handle's `path` here breaks path-based hooks like the
    // /etc/gondolin/listeners reload logic.
    return this.handlePath;
  }

  get flags() {
    return this.inner.flags;
  }

  get mode() {
    return this.inner.mode;
  }

  get position() {
    return this.inner.position;
  }

  get closed() {
    return this.inner.closed;
  }

  async read(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    const before = this.runBefore({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    if (isPromiseLike(before)) await before;
    const result = await this.inner.read(buffer, offset, length, position);
    const after = this.runAfter({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
      result,
    });
    if (isPromiseLike(after)) await after;
    return result;
  }

  readSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    this.runBeforeSync({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const bytesRead = this.inner.readSync(buffer, offset, length, position);
    this.runAfterSync({
      op: "read",
      path: this.path,
      offset: position ?? undefined,
      length,
      result: bytesRead,
    });
    return bytesRead;
  }

  async write(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    const before = this.runBefore({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    if (isPromiseLike(before)) await before;
    const result = await this.inner.write(buffer, offset, length, position);
    const after = this.runAfter({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
      result,
    });
    if (isPromiseLike(after)) await after;
    return result;
  }

  writeSync(
    buffer: Buffer,
    offset: number,
    length: number,
    position?: number | null,
  ) {
    this.runBeforeSync({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
    });
    const bytesWritten = this.inner.writeSync(buffer, offset, length, position);
    this.runAfterSync({
      op: "write",
      path: this.path,
      offset: position ?? undefined,
      length,
      result: bytesWritten,
    });
    return bytesWritten;
  }

  async readFile(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    const before = this.runBefore({ op: "readFile", path: this.path });
    if (isPromiseLike(before)) await before;
    const result = await this.inner.readFile(options);
    const after = this.runAfter({ op: "readFile", path: this.path, result });
    if (isPromiseLike(after)) await after;
    return result;
  }

  readFileSync(options?: { encoding?: BufferEncoding } | BufferEncoding) {
    this.runBeforeSync({ op: "readFile", path: this.path });
    const result = this.inner.readFileSync(options);
    this.runAfterSync({ op: "readFile", path: this.path, result });
    return result;
  }

  async writeFile(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ) {
    const before = this.runBefore({
      op: "writeFile",
      path: this.path,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
    if (isPromiseLike(before)) await before;
    await this.inner.writeFile(data, options);
    const after = this.runAfter({ op: "writeFile", path: this.path });
    if (isPromiseLike(after)) await after;
  }

  writeFileSync(
    data: Buffer | string,
    options?: { encoding?: BufferEncoding },
  ) {
    this.runBeforeSync({
      op: "writeFile",
      path: this.path,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
    this.inner.writeFileSync(data, options);
    this.runAfterSync({ op: "writeFile", path: this.path });
  }

  async stat(options?: object) {
    const before = this.runBefore({ op: "stat", path: this.path });
    if (isPromiseLike(before)) await before;
    const result = await this.inner.stat(options);
    const after = this.runAfter({ op: "stat", path: this.path, result });
    if (isPromiseLike(after)) await after;
    return result;
  }

  statSync(options?: object) {
    this.runBeforeSync({ op: "stat", path: this.path });
    const result = this.inner.statSync(options);
    this.runAfterSync({ op: "stat", path: this.path, result });
    return result;
  }

  async truncate(len?: number) {
    const before = this.runBefore({
      op: "truncate",
      path: this.path,
      size: len,
    });
    if (isPromiseLike(before)) await before;
    await this.inner.truncate(len);
    const after = this.runAfter({
      op: "truncate",
      path: this.path,
      size: len,
    });
    if (isPromiseLike(after)) await after;
  }

  truncateSync(len?: number) {
    this.runBeforeSync({ op: "truncate", path: this.path, size: len });
    this.inner.truncateSync(len);
    this.runAfterSync({ op: "truncate", path: this.path, size: len });
  }

  async close() {
    const before = this.runBefore({ op: "release", path: this.path });
    if (isPromiseLike(before)) await before;
    await this.inner.close();
    const after = this.runAfter({ op: "release", path: this.path });
    if (isPromiseLike(after)) await after;
  }

  closeSync() {
    this.runBeforeSync({ op: "release", path: this.path });
    this.inner.closeSync();
    this.runAfterSync({ op: "release", path: this.path });
  }

  private runBefore(context: VfsHookContext) {
    return this.hooks.before?.(context);
  }

  private runAfter(context: VfsHookContext) {
    return this.hooks.after?.(context);
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}

export class SandboxVfsProvider
  extends VirtualProviderClass
  implements VirtualProvider
{
  private readonly backend: VirtualProvider;
  private readonly hooks: VfsHooks;

  constructor(backend: VirtualProvider, hooks: VfsHooks = {}) {
    super();
    this.backend = backend;
    this.hooks = hooks;
  }

  private get hasHooks() {
    return Boolean(this.hooks.before || this.hooks.after);
  }

  get readonly() {
    return this.backend.readonly;
  }

  get supportsSymlinks() {
    return this.backend.supportsSymlinks;
  }

  get supportsWatch() {
    return this.backend.supportsWatch;
  }

  open(path: string, flags: string, mode?: number) {
    if (this.hasHooks) {
      return this.openWithHooks(path, flags, mode);
    }
    try {
      return this.backend.open(path, flags, mode);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async openWithHooks(path: string, flags: string, mode?: number) {
    const before = this.runBefore({ op: "open", path, flags, mode });
    if (isPromiseLike(before)) await before;
    const handle = this.wrapHandle(
      path,
      await this.backend.open(path, flags, mode),
    );
    const after = this.runAfter({
      op: "open",
      path,
      flags,
      mode,
      result: handle,
    });
    if (isPromiseLike(after)) await after;
    return handle;
  }

  openSync(path: string, flags: string, mode?: number) {
    if (!this.hasHooks) {
      return this.backend.openSync(path, flags, mode);
    }
    this.runBeforeSync({ op: "open", path, flags, mode });
    const handle = this.wrapHandle(
      path,
      this.backend.openSync(path, flags, mode),
    );
    this.runAfterSync({ op: "open", path, flags, mode, result: handle });
    return handle;
  }

  stat(path: string, options?: object) {
    if (this.hasHooks) {
      return this.statWithHooks(path, options);
    }
    try {
      return this.backend.stat(path, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async statWithHooks(path: string, options?: object) {
    const before = this.runBefore({ op: "stat", path });
    if (isPromiseLike(before)) await before;
    const stats = await this.backend.stat(path, options);
    const after = this.runAfter({ op: "stat", path, result: stats });
    if (isPromiseLike(after)) await after;
    return stats;
  }

  statSync(path: string, options?: object) {
    if (!this.hasHooks) {
      return this.backend.statSync(path, options);
    }
    this.runBeforeSync({ op: "stat", path });
    const stats = this.backend.statSync(path, options);
    this.runAfterSync({ op: "stat", path, result: stats });
    return stats;
  }

  lstat(path: string, options?: object) {
    if (this.hasHooks) {
      return this.lstatWithHooks(path, options);
    }
    try {
      return this.backend.lstat(path, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async lstatWithHooks(path: string, options?: object) {
    const before = this.runBefore({ op: "lstat", path });
    if (isPromiseLike(before)) await before;
    const stats = await this.backend.lstat(path, options);
    const after = this.runAfter({ op: "lstat", path, result: stats });
    if (isPromiseLike(after)) await after;
    return stats;
  }

  lstatSync(path: string, options?: object) {
    if (!this.hasHooks) {
      return this.backend.lstatSync(path, options);
    }
    this.runBeforeSync({ op: "lstat", path });
    const stats = this.backend.lstatSync(path, options);
    this.runAfterSync({ op: "lstat", path, result: stats });
    return stats;
  }

  readdir(path: string, options?: object) {
    if (this.hasHooks) {
      return this.readdirWithHooks(path, options);
    }
    try {
      return this.backend.readdir(path, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async readdirWithHooks(path: string, options?: object) {
    const before = this.runBefore({ op: "readdir", path });
    if (isPromiseLike(before)) await before;
    const entries = await this.backend.readdir(path, options);
    const after = this.runAfter({ op: "readdir", path, result: entries });
    if (isPromiseLike(after)) await after;
    return entries;
  }

  readdirSync(path: string, options?: object) {
    if (!this.hasHooks) {
      return this.backend.readdirSync(path, options);
    }
    this.runBeforeSync({ op: "readdir", path });
    const entries = this.backend.readdirSync(path, options);
    this.runAfterSync({ op: "readdir", path, result: entries });
    return entries;
  }

  async mkdir(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    if (!this.hasHooks) {
      return this.backend.mkdir(path, options);
    }
    const before = this.runBefore({
      op: "mkdir",
      path,
      mode: (options as { mode?: number })?.mode,
    });
    if (isPromiseLike(before)) await before;
    const result = await this.backend.mkdir(path, options);
    const after = this.runAfter({ op: "mkdir", path, result });
    if (isPromiseLike(after)) await after;
    return result;
  }

  mkdirSync(path: string, options?: object) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "mkdir", path);
    }
    if (!this.hasHooks) {
      return this.backend.mkdirSync(path, options);
    }
    this.runBeforeSync({
      op: "mkdir",
      path,
      mode: (options as { mode?: number })?.mode,
    });
    const result = this.backend.mkdirSync(path, options);
    this.runAfterSync({ op: "mkdir", path, result });
    return result;
  }

  async rmdir(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    if (!this.hasHooks) {
      return this.backend.rmdir(path);
    }
    const before = this.runBefore({ op: "rmdir", path });
    if (isPromiseLike(before)) await before;
    await this.backend.rmdir(path);
    const after = this.runAfter({ op: "rmdir", path });
    if (isPromiseLike(after)) await after;
  }

  rmdirSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rmdir", path);
    }
    if (!this.hasHooks) {
      return this.backend.rmdirSync(path);
    }
    this.runBeforeSync({ op: "rmdir", path });
    this.backend.rmdirSync(path);
    this.runAfterSync({ op: "rmdir", path });
  }

  async unlink(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    if (!this.hasHooks) {
      return this.backend.unlink(path);
    }
    const before = this.runBefore({ op: "unlink", path });
    if (isPromiseLike(before)) await before;
    await this.backend.unlink(path);
    const after = this.runAfter({ op: "unlink", path });
    if (isPromiseLike(after)) await after;
  }

  unlinkSync(path: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "unlink", path);
    }
    if (!this.hasHooks) {
      return this.backend.unlinkSync(path);
    }
    this.runBeforeSync({ op: "unlink", path });
    this.backend.unlinkSync(path);
    this.runAfterSync({ op: "unlink", path });
  }

  async rename(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    if (!this.hasHooks) {
      return this.backend.rename(oldPath, newPath);
    }
    const before = this.runBefore({ op: "rename", oldPath, newPath });
    if (isPromiseLike(before)) await before;
    await this.backend.rename(oldPath, newPath);
    const after = this.runAfter({ op: "rename", oldPath, newPath });
    if (isPromiseLike(after)) await after;
  }

  renameSync(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "rename", oldPath);
    }
    if (!this.hasHooks) {
      return this.backend.renameSync(oldPath, newPath);
    }
    this.runBeforeSync({ op: "rename", oldPath, newPath });
    this.backend.renameSync(oldPath, newPath);
    this.runAfterSync({ op: "rename", oldPath, newPath });
  }

  async link(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "link", newPath);
    }
    if (!this.hasHooks && this.backend.link) {
      return this.backend.link(oldPath, newPath);
    }
    const before = this.runBefore({ op: "link", oldPath, newPath });
    if (isPromiseLike(before)) await before;
    if (this.backend.link) {
      await this.backend.link(oldPath, newPath);
      const after = this.runAfter({ op: "link", oldPath, newPath });
      if (isPromiseLike(after)) await after;
      return;
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", oldPath);
  }

  linkSync(oldPath: string, newPath: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "link", newPath);
    }
    if (!this.hasHooks && this.backend.linkSync) {
      return this.backend.linkSync(oldPath, newPath);
    }
    this.runBeforeSync({ op: "link", oldPath, newPath });
    if (this.backend.linkSync) {
      this.backend.linkSync(oldPath, newPath);
      this.runAfterSync({ op: "link", oldPath, newPath });
      return;
    }
    throw createErrnoError(ERRNO.ENOSYS, "link", oldPath);
  }

  async readlink(path: string, options?: object) {
    if (this.backend.readlink) {
      return this.backend.readlink(path, options);
    }
    return super.readlink(path, options);
  }

  readlinkSync(path: string, options?: object) {
    if (this.backend.readlinkSync) {
      return this.backend.readlinkSync(path, options);
    }
    return super.readlinkSync(path, options);
  }

  async symlink(target: string, path: string, type?: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    if (this.backend.symlink) {
      return this.backend.symlink(target, path, type);
    }
    return super.symlink(target, path, type);
  }

  symlinkSync(target: string, path: string, type?: string) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "symlink", path);
    }
    if (this.backend.symlinkSync) {
      return this.backend.symlinkSync(target, path, type);
    }
    return super.symlinkSync(target, path, type);
  }

  async realpath(path: string, options?: object) {
    if (this.backend.realpath) {
      return this.backend.realpath(path, options);
    }
    return super.realpath(path, options);
  }

  realpathSync(path: string, options?: object) {
    if (this.backend.realpathSync) {
      return this.backend.realpathSync(path, options);
    }
    return super.realpathSync(path, options);
  }

  async access(path: string, mode?: number) {
    if (this.backend.access) {
      return this.backend.access(path, mode);
    }
    return super.access(path, mode);
  }

  accessSync(path: string, mode?: number) {
    if (this.backend.accessSync) {
      return this.backend.accessSync(path, mode);
    }
    return super.accessSync(path, mode);
  }

  watch(path: string, options?: object) {
    return this.backend.watch?.(path, options) ?? super.watch(path, options);
  }

  watchAsync(path: string, options?: object) {
    return (
      this.backend.watchAsync?.(path, options) ??
      super.watchAsync(path, options)
    );
  }

  watchFile(
    path: string,
    options?: object,
    listener?: (...args: unknown[]) => void,
  ) {
    return (
      this.backend.watchFile?.(path, options, listener) ??
      super.watchFile(path, options)
    );
  }

  unwatchFile(path: string, listener?: (...args: unknown[]) => void) {
    if (this.backend.unwatchFile) {
      this.backend.unwatchFile(path, listener);
      return;
    }
    super.unwatchFile(path, listener);
  }

  async truncate(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    if (!this.hasHooks) {
      return this.truncateBackend(path, length);
    }
    const before = this.runBefore({ op: "truncate", path, size: length });
    if (isPromiseLike(before)) await before;
    await this.truncateBackend(path, length);
    const after = this.runAfter({ op: "truncate", path, size: length });
    if (isPromiseLike(after)) await after;
  }

  truncateSync(path: string, length: number) {
    if (this.readonly) {
      throw createErrnoError(ERRNO.EROFS, "truncate", path);
    }
    if (!this.hasHooks) {
      this.truncateBackendSync(path, length);
      return;
    }
    this.runBeforeSync({ op: "truncate", path, size: length });
    this.truncateBackendSync(path, length);
    this.runAfterSync({ op: "truncate", path, size: length });
  }

  async statfs(path: string): Promise<VfsStatfs> {
    if (!this.hasHooks) {
      return delegateStatfsOrEnosys(this.backend, path);
    }
    const before = this.runBefore({ op: "statfs", path });
    if (isPromiseLike(before)) await before;
    const result = await delegateStatfsOrEnosys(this.backend, path);
    const after = this.runAfter({ op: "statfs", path, result });
    if (isPromiseLike(after)) await after;
    return result;
  }

  async close() {
    const backend = this.backend as { close?: () => Promise<void> | void };
    if (backend.close) {
      await backend.close();
    }
  }

  private wrapHandle(path: string, handle: VirtualFileHandle) {
    // Handle wrapping snapshots hook presence at open time; later hook changes
    // apply to provider operations and handles opened after the change.
    if (!this.hasHooks) {
      return handle;
    }
    return new HookedHandle(handle, this.hooks, path);
  }

  private async truncateBackend(path: string, length: number) {
    const backendWithTruncate = this.backend as unknown as {
      truncate?: (entryPath: string, length: number) => Promise<void>;
    };
    if (typeof backendWithTruncate.truncate === "function") {
      await backendWithTruncate.truncate(path, length);
      return;
    }
    const handle = await this.backend.open(path, "r+");
    try {
      await handle.truncate(length);
    } finally {
      await handle.close();
    }
  }

  private truncateBackendSync(path: string, length: number) {
    const backendWithTruncate = this.backend as unknown as {
      truncateSync?: (entryPath: string, length: number) => void;
    };
    if (typeof backendWithTruncate.truncateSync === "function") {
      backendWithTruncate.truncateSync(path, length);
      return;
    }
    const handle = this.backend.openSync(path, "r+");
    try {
      handle.truncateSync(length);
    } finally {
      handle.closeSync();
    }
  }

  private runBefore(context: VfsHookContext) {
    return this.hooks.before?.(context);
  }

  private runAfter(context: VfsHookContext) {
    return this.hooks.after?.(context);
  }

  private runBeforeSync(context: VfsHookContext) {
    if (this.hooks.before) {
      const result = this.hooks.before(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }

  private runAfterSync(context: VfsHookContext) {
    if (this.hooks.after) {
      const result = this.hooks.after(context);
      if (result && typeof (result as Promise<void>).then === "function") {
        throw new Error("async hook used in sync operation");
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as any)?.then === "function";
}

/** @internal */
export function composeVfsHooks(a?: VfsHooks, b?: VfsHooks): VfsHooks {
  if (!a || (!a.before && !a.after)) return b ?? {};
  if (!b || (!b.before && !b.after)) return a;

  return {
    before: (ctx) => {
      const ra = a.before?.(ctx);
      if (isPromiseLike(ra)) {
        return Promise.resolve(ra).then(() => b.before?.(ctx));
      }
      return b.before?.(ctx);
    },
    after: (ctx) => {
      const ra = a.after?.(ctx);
      if (isPromiseLike(ra)) {
        return Promise.resolve(ra).then(() => b.after?.(ctx));
      }
      return b.after?.(ctx);
    },
  };
}

/** @internal */
export function wrapProvider(
  provider: VirtualProvider,
  hooks: VfsHooks,
): SandboxVfsProvider {
  if (provider instanceof SandboxVfsProvider) return provider;
  return new SandboxVfsProvider(provider, hooks);
}
