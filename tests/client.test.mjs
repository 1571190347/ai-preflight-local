import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chosenEndpoints,
  platformEndpoints,
  platformCountry,
  saveSnapshot,
  readSnapshots,
  validBrowserIp,
  browserBasics,
  exitCheck,
  linkCheck,
  buildQuickReport,
  buildAiReadableReport,
} from "../.test-build/client.js";
test("browser IPv6 validation rejects malformed or incomplete addresses", () => {
  for (const x of ["::1", "2606:4700:4700::1111", "1:2:3:4:5:6:7:8", "8.8.8.8"])
    assert.equal(validBrowserIp(x), true, x);
  for (const x of [":::", "1:2:3", "fffff::1", "1:2:3:4:5:6:7:8:9", "256.1.1.1"])
    assert.equal(validBrowserIp(x), false, x);
});
test("denied browser storage still completes all local checks with zero external requests", async (t) => {
  const keys = ["window", "location", "document", "localStorage", "fetch"];
  const old = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  t.after(() =>
    keys.forEach((k, i) =>
      old[i] ? Object.defineProperty(globalThis, k, old[i]) : delete globalThis[k],
    ),
  );
  globalThis.window = { isSecureContext: true };
  globalThis.location = { protocol: "http:" };
  globalThis.document = {
    get cookie() {
      throw Error("denied");
    },
    set cookie(_) {
      throw Error("denied");
    },
  };
  globalThis.localStorage = {
    setItem() {
      throw Error("denied");
    },
    removeItem() {
      throw Error("denied");
    },
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ service: "ai-preflight" }));
  };
  const checks = await browserBasics();
  assert.equal(checks.length, 4);
  assert.equal(checks[1].state, "unknown");
  assert.equal(checks[2].state, "attention");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("/probe.json?"));
});
test("cross-origin failures stay unknown, and opaque responses do not imply account access", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => {
    throw Error("CORS");
  };
  assert.equal(
    (
      await exitCheck({
        id: "claude",
        name: "Claude",
        url: "https://claude.ai/cdn-cgi/trace",
        format: "trace",
      })
    ).state,
    "unknown",
  );
  const options = [];
  globalThis.fetch = async (_, opt) => {
    options.push(opt);
    return { type: "opaque", status: 0 };
  };
  const result = await linkCheck({
    id: "ai",
    name: "AI",
    url: "https://example.com/favicon.ico",
  });
  assert.equal(result.successes, 3);
  assert.ok(result.responses.every((x) => x === "不透明响应"));
  assert.ok(options.every((x) => x.credentials === "omit" && x.referrerPolicy === "no-referrer"));
});

test("new session saves retain prior history without requiring a manual history load", () => {
  const values = new Map([
    ["history", JSON.stringify([{ id: "old", at: "2026-09-07", data: { ip: "8.8.8.8" } }])],
    ["unrelated", "keep"],
  ]);
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
  };
  const saved = saveSnapshot(storage, "history", { ip: "1.1.1.1" });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].id, "old");
  assert.ok(!values.get("history").includes("8.8.8.8"));
  assert.ok(!values.get("history").includes("1.1.1.1"));
  assert.equal(values.get("unrelated"), "keep");
  assert.equal(readSnapshots(storage, "history").length, 2);
});
test("unreadable history is preserved instead of silently overwritten", () => {
  let writes = 0;
  assert.throws(() =>
    saveSnapshot({ getItem: () => "{broken", setItem: () => writes++ }, "history", {}),
  );
  assert.equal(writes, 0);
});

test("custom IDs remain selectable and platform selection is based on destination or explicit mapping", () => {
  const endpoints = [
    { id: "custom-claude", name: "Claude", url: "https://claude.ai/cdn-cgi/trace" },
    { id: "custom-gpt", name: "GPT", url: "https://chatgpt.com/cdn-cgi/trace" },
    { id: "proxy-gpt", name: "Own observation", url: "https://edge.example.com", platform: "gpt" },
    { id: "common", name: "Common", url: "https://api.ipify.org" },
  ];
  assert.equal(chosenEndpoints(endpoints, ["custom-gpt"]).length, 1);
  assert.throws(() => chosenEndpoints(endpoints, []), /至少选择/);
  assert.deepEqual(
    platformEndpoints(endpoints, "claude", true).map((x) => x.id),
    ["custom-claude", "common"],
  );
  assert.deepEqual(
    platformEndpoints(endpoints, "gpt").map((x) => x.id),
    ["custom-gpt", "proxy-gpt"],
  );
});
test("platform region never inherits unrelated Cloudflare or another AI platform observation", () => {
  const rows = [
    { name: "Cloudflare", source: "https://www.cloudflare.com/cdn-cgi/trace", country: "US" },
    { name: "Claude", source: "https://claude.ai/cdn-cgi/trace", country: "JP" },
  ];
  assert.equal(platformCountry(rows, "gpt"), null);
  assert.deepEqual(platformCountry(rows, "claude"), { country: "JP", source: "Claude" });
});

test("quick report surfaces explicit provider risks without presenting them as a platform score", () => {
  const report = buildQuickReport({
    currentIp: "8.8.8.8",
    exits: [{ id: "ipv4", state: "received", ip: "8.8.8.8", country: "US" }],
    profiles: [
      {
        state: "received",
        source: "ipapi.is",
        ip: "8.8.8.8",
        country: "United States",
        asn: 15169,
        organization: "Example",
        type: "hosting",
        flags: { is_proxy: true, is_vpn: false, is_tor: false },
      },
    ],
    links: [{ platform: "gpt", state: "received", successes: 3 }],
  });
  assert.equal(report.level, "risk");
  assert.equal(report.facts.ip, "8.8.8.8");
  assert.ok(report.findings.some((x) => x.id.startsWith("flag-is_proxy") && x.level === "risk"));
  assert.match(report.description, /不是 Claude 或 OpenAI/);
});

test("quick report distinguishes incomplete risk data from a clean result", () => {
  const unknown = buildQuickReport({
    currentIp: "1.1.1.1",
    profiles: [{ state: "received", source: "ipwho.is", ip: "1.1.1.1", flags: {} }],
    links: [{ platform: "claude", state: "received", successes: 3 }],
  });
  assert.equal(unknown.level, "unknown");
  assert.ok(unknown.findings.some((x) => x.id === "risk-data-missing"));
  const clear = buildQuickReport({
    profiles: [
      {
        state: "received",
        source: "ipapi.is",
        flags: { is_proxy: false, is_vpn: false, is_tor: false, is_abuser: false },
      },
    ],
    links: [{ platform: "gpt", state: "received", successes: 3 }],
  });
  assert.equal(clear.level, "clear");
  assert.ok(clear.findings.some((x) => x.id === "no-provider-flags"));
});

test("quick report calls out split routing and failed AI connectivity as attention items", () => {
  const report = buildQuickReport({
    exits: [
      { state: "received", country: "US" },
      { state: "received", country: "JP" },
    ],
    profiles: [
      {
        state: "received",
        source: "ipapi.is",
        flags: { is_proxy: false, is_vpn: false },
      },
    ],
    links: [{ platform: "claude", state: "unknown", successes: 0 }],
  });
  assert.equal(report.level, "attention");
  assert.ok(report.findings.some((x) => x.id === "split-country"));
  assert.ok(report.findings.some((x) => x.id === "claude-connection" && x.level === "attention"));
});

test("AI-readable report is structured, evidence-bound, and masks the public IP", () => {
  const report = buildQuickReport({
    currentIp: "8.8.8.8",
    profiles: [
      {
        state: "received",
        source: "ipapi.is",
        country: "United States",
        organization: "Example Network",
        flags: { is_proxy: true },
      },
    ],
  });
  const text = buildAiReadableReport(report);
  assert.match(text, /请 AI 完成的任务/);
  assert.match(text, /区分事实、推测/);
  assert.match(text, /\[risk\] 代理被数据源标记/);
  assert.match(text, /\[已隐藏\]/);
  assert.doesNotMatch(text, /8\.8\.8\.8/);
});
