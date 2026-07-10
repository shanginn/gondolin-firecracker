import assert from "node:assert/strict";
import test from "node:test";

import { NetworkStack } from "../src/net/network-stack.ts";

function createStack() {
  return new NetworkStack({
    callbacks: {
      onUdpSend: () => {},
      onTcpConnect: () => {},
      onTcpSend: () => {},
      onTcpClose: () => {},
      onTcpPause: () => {},
      onTcpResume: () => {},
    },
  });
}

function frame(payload: Buffer) {
  const framed = Buffer.alloc(4 + payload.length);
  framed.writeUInt32BE(payload.length, 0);
  payload.copy(framed, 4);
  return framed;
}

test("network framing consumes coalesced frames without changing payloads", () => {
  const stack = createStack();
  const received: Buffer[] = [];
  stack.receive = (packet) => received.push(Buffer.from(packet));

  stack.writeToNetwork(
    Buffer.concat([frame(Buffer.from("first")), frame(Buffer.from("second"))]),
  );

  assert.deepEqual(
    received.map((packet) => packet.toString()),
    ["first", "second"],
  );
});

test("network framing owns an incomplete trailing frame", () => {
  const stack = createStack();
  const received: Buffer[] = [];
  stack.receive = (packet) => received.push(Buffer.from(packet));
  const encoded = frame(Buffer.from("split-frame"));
  const first = Buffer.from(encoded.subarray(0, 7));

  stack.writeToNetwork(first);
  first.fill(0);
  stack.writeToNetwork(encoded.subarray(7));

  assert.equal(received.length, 1);
  assert.equal(received[0].toString(), "split-frame");
});

test("network send builds the framed ethernet packet in one buffer", () => {
  const stack = createStack();
  const payload = Buffer.alloc(20);
  payload[0] = 0x45;
  payload[9] = 17;

  stack.send(payload, 0x0800);
  const ethernet = stack.readFrameFromNetwork();

  assert.ok(ethernet);
  assert.deepEqual(ethernet.subarray(0, 6), stack.vmMac);
  assert.deepEqual(ethernet.subarray(6, 12), stack.gatewayMac);
  assert.equal(ethernet.readUInt16BE(12), 0x0800);
  assert.deepEqual(ethernet.subarray(14), payload);
});

test("network broadcast send keeps the broadcast destination", () => {
  const stack = createStack();
  const payload = Buffer.from("arp");

  (stack as any).sendBroadcast(payload, 0x0806);
  const ethernet = stack.readFrameFromNetwork();

  assert.ok(ethernet);
  assert.deepEqual(ethernet.subarray(0, 6), Buffer.alloc(6, 0xff));
  assert.deepEqual(ethernet.subarray(6, 12), stack.gatewayMac);
  assert.equal(ethernet.readUInt16BE(12), 0x0806);
  assert.deepEqual(ethernet.subarray(14), payload);
});
