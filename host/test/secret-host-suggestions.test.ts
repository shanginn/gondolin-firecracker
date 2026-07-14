import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../src/secret-host-suggestions.ts";

function githubToken(prefix = "ghp", length = 36): string {
  return `${prefix}_${"A".repeat(length)}`;
}

function writeFakeTrufflehog(dir: string, exitCode: number): string {
  const scriptPath = path.join(dir, `trufflehog-${exitCode}.sh`);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "IFS= read -r secret",
      'printf "%s" "$secret"',
      'printf "%s" "$secret" >&2',
      `exit ${exitCode}`,
    ].join("\n"),
    { mode: 0o700 },
  );
  return scriptPath;
}

test("reviewed detector accepts only whole GitHub token shapes", () => {
  for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr", "github_pat"]) {
    const matches = __test.matchingReviewedDetectors(githubToken(prefix));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].detectorId, 8);
    assert.deepEqual(matches[0].hosts, ["api.github.com"]);
  }

  for (const value of [
    `prefix-${githubToken()}`,
    `${githubToken()}-suffix`,
    githubToken("ghp", 35),
    githubToken("ghp", 256),
    `${githubToken()}\n`,
    githubToken("unknown"),
  ]) {
    assert.deepEqual(__test.matchingReviewedDetectors(value), []);
  }
});

test("reviewed mapping returns only api.github.com and binds helper identity", async () => {
  const secretValue = githubToken();
  let ensured = 0;
  let detectorInput = "";
  const dependencies = {
    getIdentity: async () => ({
      ref: "trufflehog:3.95.9",
      version: "3.95.9",
    }),
    ensureBinary: async () => {
      ensured += 1;
      return "/managed/trufflehog";
    },
    runDetector: async (options: any) => {
      detectorInput = options.secretValue;
      assert.equal(options.detectorId, 8);
      assert.equal(options.binaryPath, "/managed/trufflehog");
      return true;
    },
  };

  const suggestions = await __test.suggestHostsForSecretWithDependencies(
    { secretValue },
    dependencies,
  );
  assert.equal(ensured, 1);
  assert.equal(detectorInput, secretValue);
  assert.deepEqual(
    suggestions.map((suggestion: any) => suggestion.host),
    ["api.github.com"],
  );
  assert.ok(
    suggestions.every(
      (suggestion: any) =>
        !suggestion.snippet.includes(secretValue) &&
        !suggestion.file.includes(secretValue),
    ),
  );

  let mismatchedEnsureCalls = 0;
  const mismatched = await __test.suggestHostsForSecretWithDependencies(
    { secretValue },
    {
      ...dependencies,
      getIdentity: async () => ({
        ref: "trufflehog:3.95.10",
        version: "3.95.10",
      }),
      ensureBinary: async () => {
        mismatchedEnsureCalls += 1;
        return "/should/not/run";
      },
    },
  );
  assert.deepEqual(mismatched, []);
  assert.equal(mismatchedEnsureCalls, 0);
});

test("detector runner maps exit codes without exposing secret output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-detector-test-"));
  const secretValue = githubToken();
  try {
    assert.equal(
      await __test.runTrufflehogDetector({
        binaryPath: writeFakeTrufflehog(dir, 183),
        secretValue,
        detectorId: 8,
      }),
      true,
    );
    assert.equal(
      await __test.runTrufflehogDetector({
        binaryPath: writeFakeTrufflehog(dir, 0),
        secretValue,
        detectorId: 8,
      }),
      false,
    );

    await assert.rejects(
      __test.runTrufflehogDetector({
        binaryPath: writeFakeTrufflehog(dir, 1),
        secretValue,
        detectorId: 8,
      }),
      (error: Error) => {
        assert.equal(error.message, "trufflehog secret detector failed");
        assert.ok(!error.message.includes(secretValue));
        return true;
      },
    );

    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    await __test.runTrufflehogDetector({
      binaryPath: writeFakeTrufflehog(dir, 0),
      secretValue,
      detectorId: 8,
      spawnProcess: (command: string, args: string[], options: any) => {
        capturedArgs = [command, ...args];
        capturedEnv = options.env;
        return spawn(command, args, options);
      },
    });
    assert.ok(capturedArgs.every((arg) => !arg.includes(secretValue)));
    assert.ok(
      Object.values(capturedEnv).every(
        (value) => !String(value).includes(secretValue),
      ),
    );
    assert.deepEqual(Object.keys(capturedEnv).sort(), [
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detector runner kills scans that exceed the parent timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-detector-test-"));
  const scriptPath = path.join(dir, "trufflehog-timeout.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 5\n", { mode: 0o700 });
  try {
    await assert.rejects(
      __test.runTrufflehogDetector({
        binaryPath: scriptPath,
        secretValue: githubToken(),
        detectorId: 8,
        timeoutMs: 25,
      }),
      /timed out/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeSuggestions deduplicates hosts and counts evidence", () => {
  const merged = __test.mergeSuggestions([
    {
      host: "api.github.com",
      file: "a.ts",
      line: 1,
      snippet: "one",
      count: 1,
    },
    {
      host: "api.github.com",
      file: "b.ts",
      line: 2,
      snippet: "two",
      count: 1,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].host, "api.github.com");
  assert.equal(merged[0].count, 2);
});
