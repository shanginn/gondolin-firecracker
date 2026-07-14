import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../src/build/trufflehog.ts";

test("resolveSupportedPlatform supports gondolin host platforms", () => {
  assert.equal(
    __test.resolveSupportedPlatform("darwin", "arm64"),
    "darwin-arm64",
  );
  assert.equal(__test.resolveSupportedPlatform("darwin", "x64"), "darwin-x64");
  assert.equal(
    __test.resolveSupportedPlatform("linux", "arm64"),
    "linux-arm64",
  );
  assert.equal(__test.resolveSupportedPlatform("linux", "x64"), "linux-x64");
});

test("resolveSupportedPlatform rejects unsupported platforms", () => {
  assert.throws(
    () => __test.resolveSupportedPlatform("win32", "x64"),
    /not available/,
  );
});

test("installedBinaryPath includes object dir and build id", () => {
  assert.equal(
    __test.installedBinaryPath("/tmp/gondolin-tools", "build-123"),
    path.join(
      "/tmp/gondolin-tools",
      "objects",
      "build-123",
      "bin",
      "trufflehog",
    ),
  );
});

test("parseBuiltinTrufflehogRegistry parses refs and builds", () => {
  const registry = __test.parseBuiltinTrufflehogRegistry(
    {
      schema: 1,
      refs: {
        "trufflehog:1.2.3": {
          "linux-x64": "build-1",
        },
      },
      builds: {
        "build-1": {
          version: "1.2.3",
          platform: "linux-x64",
          url: "https://example.com/trufflehog.tar.gz",
          sha256: "a".repeat(64),
          binarySha256: "b".repeat(64),
        },
      },
    },
    "https://example.com/registry.json",
  );

  assert.equal(registry.refs["trufflehog:1.2.3"]["linux-x64"], "build-1");
  assert.equal(registry.builds["build-1"].platform, "linux-x64");
});

test("parseBuiltinTrufflehogRegistry requires archive and executable hashes", () => {
  const makeRegistry = (build: Record<string, unknown>) => ({
    schema: 1,
    refs: { "trufflehog:1.2.3": { "linux-x64": "build-1" } },
    builds: {
      "build-1": {
        version: "1.2.3",
        platform: "linux-x64",
        url: "https://example.com/trufflehog.tar.gz",
        ...build,
      },
    },
  });

  assert.throws(
    () =>
      __test.parseBuiltinTrufflehogRegistry(
        makeRegistry({ binarySha256: "b".repeat(64) }),
        "https://example.com/registry.json",
      ),
    /sha256/,
  );
  assert.throws(
    () =>
      __test.parseBuiltinTrufflehogRegistry(
        makeRegistry({ sha256: "a".repeat(64) }),
        "https://example.com/registry.json",
      ),
    /binarySha256/,
  );
});

test("builtin TruffleHog registry pins the current verified helper", () => {
  const registryPath = path.resolve(
    import.meta.dirname,
    "../../builtin-trufflehog-registry.json",
  );
  const registry = __test.parseBuiltinTrufflehogRegistry(
    JSON.parse(fs.readFileSync(registryPath, "utf8")),
    new URL(`file://${registryPath}`).toString(),
  );
  const builds = registry.refs[__test.defaultRef];
  assert.ok(builds);
  assert.equal(__test.defaultRef, "trufflehog:3.95.9");
  assert.equal(Object.keys(builds).length, 4);
  for (const buildId of Object.values(builds)) {
    const build = registry.builds[buildId!];
    assert.equal(build.version, "3.95.9");
    assert.match(build.sha256, /^[0-9a-f]{64}$/);
    assert.match(build.binarySha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(registry, __test.compiledRegistry);
});

test("installed helper validation rejects corruption and symlinks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-tool-hash-"));
  const binaryPath = path.join(dir, "trufflehog");
  const linkedPath = path.join(dir, "linked-trufflehog");
  try {
    fs.writeFileSync(binaryPath, "verified-binary");
    const sha256 = createHash("sha256").update("verified-binary").digest("hex");
    assert.equal(__test.isValidInstalledBinary(binaryPath, sha256), true);

    fs.symlinkSync(binaryPath, linkedPath);
    assert.equal(__test.isValidInstalledBinary(linkedPath, sha256), false);

    fs.writeFileSync(binaryPath, "tampered-binary");
    assert.equal(__test.isValidInstalledBinary(binaryPath, sha256), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TruffleHog registry URL honors the environment override", () => {
  const previous = process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL;
  process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL =
    "https://example.com/trufflehog.json";
  try {
    assert.equal(
      __test.trufflehogRegistryUrl(),
      "https://example.com/trufflehog.json",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL;
    } else {
      process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL = previous;
    }
  }
});

test("TruffleHog uses the compiled registry by default", () => {
  const previous = process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL;
  delete process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL;
  try {
    assert.equal(__test.trufflehogRegistryUrl(), null);
  } finally {
    if (previous === undefined) {
      delete process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL;
    } else {
      process.env.GONDOLIN_TRUFFLEHOG_REGISTRY_URL = previous;
    }
  }
});
