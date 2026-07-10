import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeOutputFrame,
  encodeOutputFrame,
} from "../src/sandbox/control-protocol.ts";

test("control protocol output frame encodes header and payload", () => {
  const payload = Buffer.from("hello");
  const frame = encodeOutputFrame(0x12345678, "stdout", payload);

  assert.equal(frame.length, 5 + payload.length);
  assert.equal(frame.readUInt8(0), 1);
  assert.equal(frame.readUInt32BE(1), 0x12345678);
  assert.deepEqual(frame.subarray(5), payload);
  assert.deepEqual(decodeOutputFrame(frame), {
    id: 0x12345678,
    stream: "stdout",
    data: payload,
  });
});

test("control protocol output frame owns its payload bytes", () => {
  const payload = Buffer.from("stable");
  const frame = encodeOutputFrame(0xffffffff, "stderr", payload);

  payload.fill(0);

  const decoded = decodeOutputFrame(frame);
  assert.equal(decoded.id, 0xffffffff);
  assert.equal(decoded.stream, "stderr");
  assert.equal(decoded.data.toString(), "stable");
});

test("control protocol output frame validates request ids", () => {
  for (const id of [-1, 1.5, Number.NaN, 0x1_0000_0000]) {
    assert.throws(
      () => encodeOutputFrame(id, "stdout", Buffer.alloc(0)),
      /id must be a uint32/,
    );
  }
});
