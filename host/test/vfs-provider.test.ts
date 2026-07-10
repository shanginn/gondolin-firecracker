import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node/index.ts";
import { SandboxVfsProvider } from "../src/vfs/provider.ts";

const { errno: ERRNO } = os.constants;

test("SandboxVfsProvider hooks wrap handle operations", async () => {
  const provider = new MemoryProvider();
  const events: string[] = [];

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => events.push(`before:${ctx.op}`),
    after: (ctx) => events.push(`after:${ctx.op}`),
  });

  const handle = await vfs.open("/file.txt", "w+");
  await handle.writeFile("hello");
  await handle.close();

  assert.deepEqual(events, [
    "before:open",
    "after:open",
    "before:writeFile",
    "after:writeFile",
    "before:release",
    "after:release",
  ]);
});

test("SandboxVfsProvider awaits asynchronous hooks in order", async () => {
  const provider = new MemoryProvider();
  const events: string[] = [];
  const vfs = new SandboxVfsProvider(provider, {
    before: async (ctx) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push(`before:${ctx.op}`);
    },
    after: async (ctx) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push(`after:${ctx.op}`);
    },
  });

  const handle = await vfs.open("/file.txt", "w+");
  await handle.write(Buffer.from("x"), 0, 1, 0);
  await handle.close();

  assert.deepEqual(events, [
    "before:open",
    "after:open",
    "before:write",
    "after:write",
    "before:release",
    "after:release",
  ]);
});

test("SandboxVfsProvider observes hooks added after construction", async () => {
  const provider = new MemoryProvider();
  const hooks: {
    before?: (ctx: { op: string }) => void;
  } = {};
  const vfs = new SandboxVfsProvider(provider, hooks);
  const existingHandle = await vfs.open("/file.txt", "w+");
  await existingHandle.write(Buffer.from("x"), 0, 1, 0);

  const events: string[] = [];
  hooks.before = (ctx) => {
    events.push(ctx.op);
  };

  // Handle wrapping is selected at open time, so an already-open raw handle
  // keeps its existing behavior while provider calls and future handles see hooks.
  await existingHandle.read(Buffer.alloc(1), 0, 1, 0);
  await existingHandle.close();
  await vfs.lstat("/file.txt");
  const handle = await vfs.open("/file.txt", "r");
  await handle.read(Buffer.alloc(1), 0, 1, 0);
  await handle.close();

  assert.deepEqual(events, ["lstat", "open", "read", "release"]);
});

test("SandboxVfsProvider link delegates and emits hooks", async () => {
  const events: string[] = [];
  let linked: { oldPath: string; newPath: string } | null = null;

  const provider = Object.assign(new MemoryProvider(), {
    link: async (oldPath: string, newPath: string) => {
      linked = { oldPath, newPath };
    },
  });

  const vfs = new SandboxVfsProvider(provider, {
    before: (ctx) => events.push(`before:${ctx.op}`),
    after: (ctx) => events.push(`after:${ctx.op}`),
  });

  await vfs.link("/a", "/b");
  assert.deepEqual(linked, { oldPath: "/a", newPath: "/b" });
  assert.deepEqual(events, ["before:link", "after:link"]);
});

test("SandboxVfsProvider link returns ENOSYS without backend support", async () => {
  const backend = new Proxy(new MemoryProvider() as any, {
    get(target, prop, receiver) {
      if (prop === "link" || prop === "linkSync") {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const vfs = new SandboxVfsProvider(backend);

  await assert.rejects(
    () => vfs.link("/a", "/b"),
    (err: unknown) => {
      const error = err as NodeJS.ErrnoException;
      return error.code === "ENOSYS" || error.errno === ERRNO.ENOSYS;
    },
  );
});

test("SandboxVfsProvider sync operations reject async hooks", () => {
  const provider = new MemoryProvider();
  const vfs = new SandboxVfsProvider(provider, {
    before: async () => {
      // async hook should not be used in sync API
    },
  });

  assert.throws(
    () => vfs.openSync("/file.txt", "w"),
    /async hook used in sync operation/,
  );
});
