import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePing } from "../server/ping.mjs";
test("Ping recognizes Unix, English Windows and Chinese Windows without swapping average and max", () => {
  for (const output of [
    "rtt min/avg/max/mdev = 10.1/20.2/30.3/1.0 ms",
    "Minimum = 10.1ms, Maximum = 30.3ms, Average = 20.2ms",
    "最短 = 10.1ms，最长 = 30.3ms，平均 = 20.2ms",
  ]) {
    const result = parsePing(output);
    assert.equal(result.min, 10.1);
    assert.equal(result.avg, 20.2);
    assert.equal(result.max, 30.3);
    assert.equal(result.state, "received");
  }
});
test("lost packets or empty output remain unknown and preserve loss evidence", () => {
  assert.equal(parsePing("").state, "unknown");
  const result = parsePing("已发送 = 3，已接收 = 0，丢失 = 3 (100% 丢失)");
  assert.equal(result.state, "unknown");
  assert.equal(result.loss, 100);
  assert.equal(result.avg, null);
});
