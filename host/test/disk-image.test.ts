import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTempRawCopy } from "../src/disk/image.ts";

test("disk image: temporary COW copy remains independent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-disk-test-"));
  const source = path.join(dir, "source.raw");
  const original = Buffer.alloc(1024 * 1024, 0x5a);
  fs.writeFileSync(source, original);

  let copy: string | null = null;
  try {
    copy = createTempRawCopy(source);
    assert.equal(fs.statSync(copy).size, original.length);
    assert.deepEqual(fs.readFileSync(copy), original);

    const fd = fs.openSync(copy, "r+");
    try {
      fs.writeSync(fd, Buffer.from([0xa5]), 0, 1, 0);
    } finally {
      fs.closeSync(fd);
    }

    assert.equal(fs.readFileSync(source)[0], 0x5a);
    assert.equal(fs.readFileSync(copy)[0], 0xa5);
  } finally {
    if (copy) fs.rmSync(copy, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
