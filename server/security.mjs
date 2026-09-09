import { isIP, BlockList } from "node:net";
import dns from "node:dns/promises";
import https from "node:https";
import { domainToASCII } from "node:url";
import { getDnsConfig } from "./config.mjs";
const blocked4 = new BlockList(),
  blocked6 = new BlockList();
for (const [ip, mask] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked4.addSubnet(ip, mask, "ipv4");
for (const [ip, mask] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["fec0::", 10],
  ["2001:2::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
])
  blocked6.addSubnet(ip, mask, "ipv6");
export function isPublicIp(ip) {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  const family = isIP(ip);
  return (
    !!family && !(family === 4 ? blocked4 : blocked6).check(ip, family === 4 ? "ipv4" : "ipv6")
  );
}
export function publicIp(value) {
  if (typeof value !== "string" || !isPublicIp(value))
    throw new Error("请输入有效的公网 IPv4 或 IPv6 地址");
  return value;
}
export function target(value, { allowAsn = false } = {}) {
  if (typeof value !== "string" || value.length > 253) throw new Error("查询目标格式无效");
  const v = value.trim();
  if (allowAsn && /^AS\d{1,10}$/i.test(v)) {
    const n = Number(v.slice(2));
    if (n < 1 || n > 4294967295) throw new Error("ASN 超出范围");
    return { kind: "autnum", value: String(n) };
  }
  if (isIP(v)) return { kind: "ip", value: publicIp(v) };
  if (/[\s/:?#@\\\[\]%]/.test(v)) throw new Error("目标不能包含 URL、路径或凭据");
  const host = domainToASCII(v).toLowerCase();
  if (isIP(host)) return { kind: "ip", value: publicIp(host) };
  if (
    !host.includes(".") ||
    host.length > 253 ||
    host
      .split(".")
      .some((p) => !p || p.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)) ||
    /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) ||
    /(^|\.)home\.arpa$/.test(host)
  )
    throw new Error("请输入公网域名、IP 或 AS 号；不能包含路径或端口");
  return { kind: "domain", value: host };
}
async function systemLookup(host) {
  let timer;
  return Promise.race([
    dns.lookup(host, { all: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DNS 解析超时")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
const isFakeIp = (ip) => isIP(ip) === 4 && /^198\.(18|19)\./.test(ip);
function validatedAddresses(addresses) {
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.length > 128 ||
    addresses.some((a) => !a || !isPublicIp(a.address) || isIP(a.address) !== a.family)
  )
    throw new Error("DNS 未返回完整有效的公网地址，已拒绝请求");
  return [
    ...new Map(
      addresses.map((a) => [a.address, { address: a.address, family: a.family }]),
    ).values(),
  ];
}

// This transport receives only validated, pinned addresses. It does no DNS resolution
// and does not inherit a global proxy agent that could resolve the hostname elsewhere.
async function pinnedRequest(
  u,
  addresses,
  { method = "GET", headers = {}, body, timeout = 10000, maxBytes = 2_000_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      agent: false,
      headers: {
        "User-Agent": "AI-Preflight-Local/0.3",
        "Accept-Encoding": "identity",
        ...headers,
      },
      lookup: (_host, options, callback) => {
        const selected =
          addresses.find((a) => !options.family || a.family === options.family) || addresses[0];
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
    };
    const req = https.request(u, opts, (res) => {
      let length = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxBytes) {
          req.destroy(new Error("响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("响应提前中断")));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    const timer = setTimeout(() => req.destroy(new Error("请求超时")), timeout);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dohLookup(host, endpoint) {
  const answers = await Promise.all(
    [1, 28].map(async (type) => {
      const u = new URL(endpoint);
      u.searchParams.set("name", host);
      u.searchParams.set("type", String(type));
      const response = await pinnedRequest(u, [{ address: "1.1.1.1", family: 4 }], {
        headers: { Accept: "application/dns-json" },
        timeout: 6000,
        maxBytes: 65536,
      });
      // Never follow a DoH redirect, including one to another public resolver.
      if (response.status !== 200) throw new Error("Cloudflare DoH 返回 HTTP " + response.status);
      let data;
      try {
        data = JSON.parse(response.text);
      } catch {
        throw new Error("Cloudflare DoH 未返回有效 JSON");
      }
      if (data?.Status !== 0 || data.TC === true)
        throw new Error(
          "Cloudflare DoH 未返回完整成功结果（DNS 状态 " + String(data?.Status).slice(0, 20) + "）",
        );
      if (
        !Array.isArray(data.Question) ||
        !data.Question.some(
          (q) =>
            typeof q.name === "string" &&
            q.name.replace(/\.$/, "").toLowerCase() === host &&
            q.type === type,
        )
      )
        throw new Error("Cloudflare DoH 查询与响应不匹配");
      const rows = data.Answer ?? [];
      if (!Array.isArray(rows) || rows.length > 64) throw new Error("Cloudflare DoH 地址列表无效");
      return rows
        .filter((row) => row?.type === 1 || row?.type === 28)
        .map((row) => {
          const family = row.type === 1 ? 4 : 6;
          if (!isPublicIp(row.data) || isIP(row.data) !== family)
            throw new Error("Cloudflare DoH 返回非公网或无效地址，已拒绝请求");
          return { address: row.data, family };
        });
    }),
  );
  return validatedAddresses(answers.flat());
}

export async function resolvePublicDetailed(host) {
  const config = getDnsConfig();
  const q = target(host);
  const info = {
    mode: config.mode,
    source: q.kind === "ip" ? "literal" : "system",
    fallbackReason: null,
    endpoint: null,
  };
  try {
    if (q.kind === "ip")
      return { ...info, addresses: [{ address: q.value, family: isIP(q.value) }] };
    if (config.mode !== "doh") {
      const addresses = await systemLookup(q.value);
      const nonPublic = addresses.filter((a) => !isPublicIp(a.address));
      if (!nonPublic.length) return { ...info, addresses: validatedAddresses(addresses) };
      // Do not leak ordinary split-DNS/intranet names to a public resolver. Only
      // the conventional Fake-IP pool is eligible for automatic resolution retry.
      if (config.mode !== "auto" || !nonPublic.every((a) => isFakeIp(a.address)))
        throw new Error(
          nonPublic.some((a) => isFakeIp(a.address))
            ? "系统 DNS 返回 Fake-IP（198.18.0.0/15），已拒绝请求；可配置 DNS_MODE=auto 后重试"
            : "系统 DNS 返回非公网地址，已拒绝请求；不会自动改用公共 DNS",
        );
      info.fallbackReason = "system-fake-ip";
    }
    info.source = "doh";
    info.endpoint = config.endpoint;
    return { ...info, addresses: await dohLookup(q.value, config.endpoint) };
  } catch (error) {
    error.dns = info;
    throw error;
  }
}
export async function resolvePublic(host) {
  return (await resolvePublicDetailed(host)).addresses;
}
export async function safeRequest(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeout = 10000,
    maxBytes = 2_000_000,
    redirects = 3,
    sensitive = false,
  } = {},
) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443"))
    throw new Error("仅支持标准 HTTPS 公网请求");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const resolution = await resolvePublicDetailed(host);
  let result;
  try {
    result = await pinnedRequest(u, resolution.addresses, {
      method,
      headers,
      body,
      timeout,
      maxBytes,
    });
  } catch (error) {
    error.dns = resolution;
    throw error;
  }

  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    if (redirects <= 0) throw new Error("重定向次数过多");
    const next = new URL(result.headers.location, u);
    if (
      next.origin !== u.origin &&
      (sensitive ||
        body !== undefined ||
        [...u.searchParams.keys()].some((k) => /key|token|secret|auth/i.test(k)) ||
        Object.keys(headers).some((k) => /authorization|key|cookie|token/i.test(k)))
    )
      throw new Error("带密钥的请求不能跨站重定向");
    return safeRequest(next, {
      method,
      headers,
      body,
      timeout,
      maxBytes,
      sensitive,
      redirects: redirects - 1,
    });
  }
  return { ...result, url: u.toString(), dns: resolution };
}
export async function jsonRequest(url, options) {
  const r = await safeRequest(url, options);
  if (r.status < 200 || r.status >= 300) throw new Error(`数据源返回 HTTP ${r.status}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error("数据源没有返回有效 JSON");
  }
}
export function checkRequest(req, port, devOrigin = "") {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  // Vite proxies requests using its original Host header.
  if (devOrigin) hosts.add(new URL(devOrigin).host);
  if (!hosts.has(req.headers.host)) return false;
  const origins = new Set([...hosts].map((h) => "http://" + h));
  if (req.headers.origin && !origins.has(req.headers.origin)) return false;
  if (
    req.method === "POST" &&
    (!req.headers.origin ||
      !String(req.headers["content-type"] || "").startsWith("application/json"))
  )
    return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}
