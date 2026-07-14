import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../bin/gondolin.ts";

function makeCommonOptions(overrides: Record<string, unknown> = {}) {
  return {
    mounts: [],
    memoryMounts: [],
    allowedHosts: [],
    secrets: [],
    dnsTrustedServers: [],
    tcpHostMappings: {},
    sshAllowedHosts: [],
    sshCredentials: [],
    sshAgent: undefined,
    sshKnownHostsFiles: [],
    ...overrides,
  };
}

test("buildVmOptions keeps implicit open egress for host secrets without --allow-host", async () => {
  const vmOptions = await __test.buildVmOptions(
    makeCommonOptions({
      secrets: [
        {
          name: "API_KEY",
          hosts: ["example.com"],
          value: "secret-value",
        },
      ],
    }) as any,
  );

  assert.ok(vmOptions.httpHooks);
  assert.deepEqual(vmOptions.env, {
    API_KEY: vmOptions.env.API_KEY,
  });
  assert.match(vmOptions.env.API_KEY, /^[0-9a-f]{48}\.api_key$/);
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "unrelated.example",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );
});

test("parseHostSecret supports host discovery mode from env", () => {
  process.env.API_KEY = "secret-value";
  try {
    assert.deepEqual(__test.parseHostSecret("API_KEY"), {
      name: "API_KEY",
      value: "secret-value",
      hosts: [],
    });
  } finally {
    delete process.env.API_KEY;
  }
});

test("parseHostSecret supports host discovery mode with inline value", () => {
  assert.deepEqual(__test.parseHostSecret("API_KEY=secret-value"), {
    name: "API_KEY",
    value: "secret-value",
    hosts: [],
  });
});

test("parseHostSecret rejects unsafe names without echoing inline values", () => {
  const secretValue = "do-not-print-this-secret";
  assert.throws(
    () => __test.parseHostSecret(`BAD-NAME=${secretValue}`),
    (error: Error) => {
      assert.match(error.message, /environment name/);
      assert.ok(!error.message.includes(secretValue));
      return true;
    },
  );
  assert.throws(
    () => __test.parseHostSecret(`API_KEY@=${secretValue}`),
    (error: Error) => {
      assert.match(error.message, /no hosts/);
      assert.ok(!error.message.includes(secretValue));
      return true;
    },
  );
});

test("secret host discovery requires a TTY before scanning", () => {
  assert.doesNotThrow(() =>
    __test.assertInteractiveSecretHostDiscovery("API_KEY", true, true),
  );
  assert.throws(
    () => __test.assertInteractiveSecretHostDiscovery("API_KEY", false, true),
    /interactive TTY/,
  );
  assert.throws(
    () => __test.assertInteractiveSecretHostDiscovery("API_KEY", true, false),
    /interactive TTY/,
  );
});

test("suggested secret hosts require explicit numbered selection", () => {
  const suggestions = [
    { host: "api.github.com" },
    { host: "uploads.github.com" },
  ];

  assert.deepEqual(__test.selectSuggestedSecretHosts("", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("y", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("yes", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("a", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("all", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("0", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("1,x", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("3", suggestions), []);
  assert.deepEqual(__test.selectSuggestedSecretHosts("2, 1", suggestions), [
    "uploads.github.com",
    "api.github.com",
  ]);
  assert.deepEqual(__test.selectSuggestedSecretHosts("2,1,2", suggestions), [
    "uploads.github.com",
    "api.github.com",
  ]);
});

test("buildVmOptions still honors explicit global allowlists", async () => {
  const vmOptions = await __test.buildVmOptions(
    makeCommonOptions({
      allowedHosts: ["api.example.com"],
      secrets: [
        {
          name: "API_KEY",
          hosts: ["example.com"],
          value: "secret-value",
        },
      ],
    }) as any,
  );

  assert.ok(vmOptions.httpHooks);
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "api.example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    true,
  );
  assert.equal(
    await vmOptions.httpHooks.isIpAllowed({
      hostname: "example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
    false,
  );
});
