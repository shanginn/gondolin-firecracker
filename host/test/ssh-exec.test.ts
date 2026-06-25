import assert from "node:assert/strict";
import test from "node:test";

import { getInfoFromSshExecRequest } from "../src/ssh/exec.ts";

const base = {
  hostname: "github.com",
  port: 22,
  guestUsername: "git",
  src: { ip: "192.168.127.3", port: 50000 },
};

test("getInfoFromSshExecRequest parses git exec commands", () => {
  assert.deepEqual(
    getInfoFromSshExecRequest({
      ...base,
      command: "git-upload-pack 'my-org/my-repo.git'",
    }),
    { service: "git-upload-pack", repo: "my-org/my-repo.git" },
  );

  assert.deepEqual(
    getInfoFromSshExecRequest({
      ...base,
      command: "git-receive-pack '/my-org/my-repo.git/'",
    }),
    { service: "git-receive-pack", repo: "my-org/my-repo.git" },
  );
});

test("getInfoFromSshExecRequest fails closed", () => {
  for (const command of [
    "echo hello",
    "git-upload-pack 'my-org/my-repo.git' && echo pwned",
    'git-upload-pack "$(echo my-org/my-repo.git)"',
    "/usr/lib/git-core/$(id)/git-upload-pack 'my-org/my-repo.git'",
  ]) {
    assert.equal(getInfoFromSshExecRequest({ ...base, command }), null);
  }
});
