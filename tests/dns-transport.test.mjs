import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { resolvePublic, resolvePublicDetailed, safeRequest } from "../server/security.mjs";
import { backendCheck } from "../server/providers.mjs";
import { getDnsConfig, backendCheckSources, loadConfig } from "../server/config.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(
  t,
  {
    mode = "auto",
    addresses = [{ address: "198.18.0.1", family: 4 }],
    lookupError,
    reply = dohReply,
  } = {},
) {
  const oldLookup = dns.lookup,
    oldRequest = https.request,
    oldMode = process.env.DNS_MODE;
  process.env.DNS_MODE = mode;
  const calls = [],
    lookups = [];
  dns.lookup = async (host) => {
    lookups.push(host);
    if (lookupError) throw Object.assign(new Error(lookupError), { code: lookupError });
    return addresses;
  };
  https.request = (url, options, callback) => {
    const call = { url: new URL(url), options, body: "" };
    calls.push(call);
    const req = new EventEmitter();
    req.write = (chunk) => {
      call.body += chunk;
    };
    req.destroy = (error) => {
      req.emit("error", error);
      req.emit("close");
    };
    req.end = () =>
      queueMicrotask(() => {
        let value;
        try {
          value = reply(call);
        } catch (error) {
          req.destroy(error);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = value.status ?? 200;
        response.headers = value.headers ?? {};
        callback(response);
        response.emit("data", Buffer.from(value.text ?? JSON.stringify(value.data)));
        response.emit("end");
        req.emit("close");
      });
    return req;
  };
  t.after(() => {
    dns.lookup = oldLookup;
    https.request = oldRequest;
    if (oldMode === undefined) delete process.env.DNS_MODE;
    else process.env.DNS_MODE = oldMode;
  });
  return { calls, lookups };
}
function dohReply(call, addresses) {
  assert.equal(call.url.origin, "https://1.1.1.1");
  assert.equal(call.url.pathname, "/dns-query");
  const type = Number(call.url.searchParams.get("type"));
  const name = call.url.searchParams.get("name");
  return {
    data: {
      Status: 0,
      Question: [{ name: name + ".", type }],
      Answer: (addresses ?? (type === 1 ? ["8.8.8.8"] : ["2606:4700:4700::1111"])).map((data) => ({
        name: name + ".",
        type,
        TTL: 60,
        data,
      })),
    },
  };
}

test("system and auto modes use public system results without contacting DoH", async (t) => {
  const f = fixture(t, { addresses: [{ address: "8.8.8.8", family: 4 }] });
  for (const mode of ["auto", "system"]) {
    process.env.DNS_MODE = mode;
    const result = await resolvePublicDetailed("EXAMPLE.COM");
    assert.deepEqual(result.addresses, [{ address: "8.8.8.8", family: 4 }]);
    assert.equal(result.source, "system");
    assert.equal(result.fallbackReason, null);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.lookups, ["example.com", "example.com"]);
});

test("auto fallback queries fixed DoH A and AAAA without re-resolving its literal endpoint", async (t) => {
  const f = fixture(t);
  const result = await resolvePublicDetailed("example.com");
  assert.equal(result.source, "doh");
  assert.equal(result.fallbackReason, "system-fake-ip");
  assert.equal(result.endpoint, "https://1.1.1.1/dns-query");
  assert.equal(result.addresses.length, 2);
  assert.deepEqual(f.lookups, ["example.com"]);
  assert.deepEqual(f.calls.map((x) => x.url.searchParams.get("type")).sort(), ["1", "28"]);
  for (const call of f.calls) {
    assert.equal(call.options.agent, false);
    assert.equal(call.options.headers.Accept, "application/dns-json");
    assert.equal(call.body, "");
    assert.equal(
      Object.keys(call.options.headers).some((x) => /key|authorization|cookie/i.test(x)),
      false,
    );
    call.options.lookup("unused", { all: true }, (error, rows) => {
      assert.equal(error, null);
      assert.deepEqual(rows, [{ address: "1.1.1.1", family: 4 }]);
    });
  }
});

test("system mode refuses Fake-IP without automatic public DNS calls", async (t) => {
  const f = fixture(t, { mode: "system" });
  await assert.rejects(resolvePublic("example.com"), /Fake-IP/);
  assert.equal(f.calls.length, 0);
});

test("ordinary private, loopback and mixed private/Fake-IP results do not escape to DoH", async (t) => {
  const rows = [{ address: "10.0.0.1", family: 4 }];
  const f = fixture(t, { addresses: rows });
  for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.0.1", "169.254.169.254"]) {
    rows[0].address = ip;
    await assert.rejects(resolvePublic("private.example.com"), /非公网/);
  }
  rows.push({ address: "198.18.0.1", family: 4 });
  await assert.rejects(resolvePublic("private.example.com"));
  assert.equal(f.calls.length, 0);
});

test("system NXDOMAIN/ENOTFOUND does not disclose the failed hostname to public DNS", async (t) => {
  const f = fixture(t, { lookupError: "ENOTFOUND" });
  await assert.rejects(resolvePublic("not-in-public-dns.example.com"), /ENOTFOUND/);
  assert.equal(f.calls.length, 0);
});

test("explicit DoH skips system resolution but private literals and local special names stay blocked", async (t) => {
  const f = fixture(t, { mode: "doh" });
  assert.equal((await resolvePublicDetailed("example.com")).source, "doh");
  assert.equal(f.lookups.length, 0);
  const before = f.calls.length;
  for (const host of [
    "localhost",
    "printer.local",
    "router.home.arpa",
    "hidden.onion",
    "127.1",
    "2130706433",
    "10.0.0.1",
    "::1",
  ])
    await assert.rejects(resolvePublic(host));
  assert.equal(f.calls.length, before);
  assert.deepEqual(await resolvePublic("1.1.1.1"), [{ address: "1.1.1.1", family: 4 }]);
  assert.equal(f.calls.length, before);
});

test("a private answer in either DoH family rejects the entire resolution", async (t) => {
  const f = fixture(t, {
    reply: (call) =>
      dohReply(call, call.url.searchParams.get("type") === "1" ? ["8.8.8.8"] : ["::1"]),
  });
  await assert.rejects(safeRequest("https://example.com/"), /非公网/);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((x) => x.url.hostname === "1.1.1.1"));
});

test("DoH accepts an absent AAAA answer when A is valid", async (t) => {
  fixture(t, {
    reply: (call) => dohReply(call, call.url.searchParams.get("type") === "1" ? ["8.8.8.8"] : []),
  });
  assert.deepEqual(await resolvePublic("example.com"), [{ address: "8.8.8.8", family: 4 }]);
});

test("DoH rejects redirects, truncated, failed, mismatched, empty and malformed answers", async (t) => {
  let variant;
  const f = fixture(t, { reply: (call) => variant(call) });
  const invalid = [
    () => ({ status: 302, headers: { location: "https://8.8.8.8/" }, text: "" }),
    () => ({ text: "{broken" }),
    (call) => ({ data: { ...dohReply(call).data, TC: true } }),
    (call) => ({ data: { ...dohReply(call).data, Status: 3 } }),
    (call) => ({
      data: { ...dohReply(call).data, Question: [{ name: "other.example.com.", type: 1 }] },
    }),
    (call) => dohReply(call, []),
    (call) => dohReply(call, [":::"]),
  ];
  for (const value of invalid) {
    variant = value;
    await assert.rejects(resolvePublic("example.com"));
  }
  assert.ok(f.calls.every((x) => x.url.origin === "https://1.1.1.1"));
});

test("HTTPS uses only validated DoH addresses and never forwards API credentials to the resolver", async (t) => {
  const f = fixture(t, {
    reply: (call) => (call.url.hostname === "1.1.1.1" ? dohReply(call) : { data: { ok: true } }),
  });
  const response = await safeRequest("https://example.com/api", {
    method: "POST",
    headers: { Authorization: "Bearer test-only-secret" },
    body: '{"key":"test-only-secret"}',
  });
  assert.equal(response.dns.source, "doh");
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 3);
  const request = f.calls[2];
  assert.equal(request.url.hostname, "example.com");
  assert.equal(request.options.headers.Authorization, "Bearer test-only-secret");
  request.options.lookup("rebound.example.com", { all: true }, (error, rows) => {
    assert.equal(error, null);
    assert.deepEqual(rows, [{ address: "8.8.8.8", family: 4 }]);
  });
  assert.ok(
    f.calls
      .slice(0, 2)
      .every(
        (x) =>
          !JSON.stringify(x.options.headers).includes("test-only-secret") &&
          !x.body.includes("test-only-secret"),
      ),
  );
});

test("fixed backend checks preserve per-source failures and resolution metadata", async (t) => {
  const f = fixture(t, {
    reply: (call) => {
      if (call.url.hostname === "1.1.1.1") return dohReply(call);
      if (call.url.hostname === "www.cloudflare.com") return { text: "ip=8.8.4.4\nloc=US\n" };
      if (call.url.hostname === "ipwho.is") return { status: 503, text: "temporarily unavailable" };
      if (call.url.hostname === "data.iana.org") return { data: { services: [] } };
      throw new Error("Unexpected request " + call.url.origin);
    },
  });
  const result = await backendCheck();
  assert.equal(result.results.length, 3);
  assert.deepEqual(
    result.results.map((x) => x.url),
    backendCheckSources.map((x) => x.url),
  );
  assert.deepEqual(
    result.results.map((x) => x.state),
    ["received", "unknown", "received"],
  );
  assert.match(result.results[1].error, /503/);
  assert.equal(result.results[1].httpStatus, 503);
  assert.ok(
    result.results.every(
      (x) =>
        x.dns.source === "doh" && x.dns.fallbackReason === "system-fake-ip" && x.durationMs >= 0,
    ),
  );
  assert.ok(
    f.calls.every(
      (x) => !Object.keys(x.options.headers).some((key) => /authorization|key/i.test(key)),
    ),
  );
});

test("DNS mode validation and endpoint platform metadata are explicit configuration contracts", (t) => {
  fixture(t);
  assert.equal(getDnsConfig().mode, "auto");
  process.env.DNS_MODE = "insecure";
  assert.throws(() => getDnsConfig(), /DNS_MODE/);
  process.env.DNS_MODE = "system";
  assert.equal(getDnsConfig().mode, "system");
  const dir = mkdtempSync(join(tmpdir(), "preflight-platform-test-"));
  const oldFile = process.env.CONFIG_FILE;
  try {
    process.env.CONFIG_FILE = join(dir, "config.json");
    const endpoint = { id: "custom", name: "Custom", url: "https://example.com/", platform: "gpt" };
    writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ connectionSources: [endpoint] }));
    assert.equal(loadConfig().connectionSources[0].platform, "gpt");
    writeFileSync(
      process.env.CONFIG_FILE,
      JSON.stringify({ connectionSources: [{ ...endpoint, platform: "anything" }] }),
    );
    assert.throws(() => loadConfig(), /平台标记/);
  } finally {
    if (oldFile === undefined) delete process.env.CONFIG_FILE;
    else process.env.CONFIG_FILE = oldFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
