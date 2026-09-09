import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, getDnsConfig, backendCheckSources } from "./config.mjs";
import { checkRequest, jsonRequest, safeRequest } from "./security.mjs";
import {
  ipProfile,
  serviceStatus,
  rdap,
  whois,
  tlds,
  news,
  localNetwork,
  serverExit,
  backendCheck,
} from "./providers.mjs";
import { localPing, startGlobalPing, globalPingResult, ownPing } from "./ping.mjs";
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT 须为 1024–65535");
const bind = process.env.BIND_ADDRESS || "127.0.0.1";
if (!["127.0.0.1", "::1", "0.0.0.0"].includes(bind)) throw new Error("不支持的监听地址");
const config = loadConfig();
const dnsTransport = getDnsConfig();
let dnsCollectorOrigin = null;
if (process.env.DNS_COLLECTOR_URL) {
  try {
    const u = new URL(process.env.DNS_COLLECTOR_URL);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.port && u.port !== "443")
    )
      throw new Error();
    dnsCollectorOrigin = u.origin;
  } catch {
    throw new Error("DNS_COLLECTOR_URL 须为无凭据的标准 HTTPS 地址");
  }
}
const apiToken = randomBytes(24).toString("hex");
const dist = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const sessions = new Map();
let requestTimes = [];
let expensiveTimes = [];
function equal(a, b) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  let text = JSON.stringify(value);
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key) && secret && secret.length >= 4)
      text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
  }
  res.end(text);
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function pick(list, id) {
  const v = list.find((x) => x.id === id);
  if (!v) throw new Error("请选择已配置的数据源");
  return v;
}
function dnsEndpoint() {
  const value = process.env.DNS_COLLECTOR_URL;
  if (!value || !process.env.DNS_COLLECTOR_TOKEN)
    throw new Error("需要配置自建 DNS 采集端地址与令牌，详见 DNS 部署文档");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("DNS 采集端需使用 HTTPS");
  return value.replace(/\/$/, "");
}
function dnsHeaders() {
  return {
    Authorization: "Bearer " + process.env.DNS_COLLECTOR_TOKEN,
    "Content-Type": "application/json",
  };
}
async function action(path, b) {
  if (b.consent !== true) throw new Error("未确认本次外部请求");
  switch (path) {
    case "/api/backend-check":
      return backendCheck();
    case "/api/exit":
      return serverExit(pick(config.exitSources, b.id));
    case "/api/ip-profile":
      return ipProfile(b.ip, b.providers);
    case "/api/status":
      return serviceStatus(pick(config.statusSources, b.id));
    case "/api/rdap":
      return rdap(b.query);
    case "/api/whois":
      return whois(b.query);
    case "/api/tlds":
      return tlds();
    case "/api/news":
      return news(pick(config.newsFeeds, b.id));
    case "/api/system-dns":
      return localNetwork(b.query);
    case "/api/ping/start": {
      expensiveTimes = expensiveTimes.filter((t) => Date.now() - t < 60000);
      if (expensiveTimes.length >= 3) throw new Error("每分钟最多启动 3 次 Ping 测量，请稍后再试");
      expensiveTimes.push(Date.now());
      if (b.mode === "global") return startGlobalPing(b.target, b.limit);
      if (b.mode === "own") return ownPing(b.target, config.pingNodes);
      if (b.mode === "local")
        return {
          status: "finished",
          source: "本机",
          results: [await localPing(b.target)],
        };
      throw new Error("测量模式无效");
    }
    case "/api/ping/result":
      return globalPingResult(b.id);
    case "/api/dns/start": {
      if (b.count !== 3 && b.count !== 10) throw new Error("DNS 测试仅支持 3 或 10 个探针");
      const d = await jsonRequest(dnsEndpoint() + "/sessions", {
        method: "POST",
        headers: dnsHeaders(),
        body: JSON.stringify({ count: b.count }),
      });
      if (
        typeof d.id !== "string" ||
        !/^[a-zA-Z0-9_-]{10,100}$/.test(d.id) ||
        !Array.isArray(d.hostnames) ||
        d.hostnames.length !== b.count ||
        d.hostnames.some(
          (h) =>
            typeof h !== "string" ||
            h.length > 253 ||
            !/^[a-zA-Z0-9.-]+$/.test(h) ||
            !h.includes(".") ||
            h.includes(".."),
        )
      )
        throw new Error("DNS 采集端返回的数据无效");
      for (const [id, at] of sessions) if (Date.now() - at > 180000) sessions.delete(id);
      if (sessions.size >= 20) throw new Error("本地 DNS 会话过多");
      sessions.set(d.id, Date.now());
      return d;
    }
    case "/api/dns/result":
    case "/api/dns/delete": {
      if (
        typeof b.id !== "string" ||
        !sessions.has(b.id) ||
        Date.now() - sessions.get(b.id) > 180000
      )
        throw new Error("DNS 会话已过期或不属于本机");
      const endpoint = dnsEndpoint() + "/sessions/" + encodeURIComponent(b.id);
      if (path.endsWith("/delete")) {
        const removed = await safeRequest(endpoint, {
          method: "DELETE",
          headers: dnsHeaders(),
        });
        if (removed.status !== 404 && (removed.status < 200 || removed.status >= 300))
          throw new Error("DNS 采集端未确认删除");
        sessions.delete(b.id);
        return { deleted: true };
      }
      return jsonRequest(endpoint, { headers: dnsHeaders() });
    }
    default:
      throw new Error("未知操作");
  }
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
const server = http.createServer(async (req, res) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!checkRequest(req, port, process.env.DEV_ORIGIN || ""))
    return json(res, 403, { ok: false, error: "请求来源不受信任" });
  let path;
  try {
    path = new URL(req.url, "http://localhost").pathname;
  } catch {
    return json(res, 400, { ok: false, error: "无效路径" });
  }
  if (path === "/api/config" && req.method === "GET")
    return json(res, 200, {
      ok: true,
      data: {
        ...config,
        pingNodes: config.pingNodes.map(({ id, name, url }) => ({
          id,
          name,
          url,
        })),
        apiToken,
        version: "0.3.0",
        dnsTransport,
        backendCheckSources,
        configured: {
          ipapi: !!process.env.IPAPI_KEY,
          abuse: !!process.env.ABUSEIPDB_KEY,
          globalping: !!process.env.GLOBALPING_TOKEN,
          dns: !!process.env.DNS_COLLECTOR_URL && !!process.env.DNS_COLLECTOR_TOKEN,
        },
        dnsCollector: dnsCollectorOrigin,
      },
    });
  if (path === "/api/health" && req.method === "GET")
    return json(res, 200, {
      ok: true,
      data: {
        local: true,
        version: "0.3.0",
        instanceId: process.env.PREFLIGHT_INSTANCE_ID || null,
      },
    });
  if (path.startsWith("/api/")) {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "仅支持 POST" });
    if (!equal(req.headers["x-preflight-token"], apiToken))
      return json(res, 403, {
        ok: false,
        error: "会话令牌无效，请刷新本地页面",
      });
    requestTimes = requestTimes.filter((t) => Date.now() - t < 60000);
    if (requestTimes.length >= 120)
      return json(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" });
    requestTimes.push(Date.now());
    try {
      const b = await body(req);
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("请求格式错误");
      const data = await action(path, b);
      return json(res, 200, { ok: true, data });
    } catch (e) {
      const message = e instanceof Error ? e.message : "请求失败";
      return json(res, 400, {
        ok: false,
        error: message.replace(/(?:key|token)=[^&\s]+/gi, "key=[redacted]").slice(0, 300),
      });
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD")
    return json(res, 405, { ok: false, error: "方法不支持" });
  try {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new Error("无效路径");
    }
    let file = resolve(dist, "." + decoded);
    if (file !== dist && !file.startsWith(dist + sep))
      return json(res, 403, { ok: false, error: "路径不可访问" });
    if ((await stat(file).catch(() => null))?.isDirectory()) file = resolve(file, "index.html");
    if (!(await stat(file).catch(() => null))) {
      if (extname(decoded)) return json(res, 404, { ok: false, error: "文件不存在" });
      file = resolve(dist, "index.html");
    }
    const content = await readFile(file);
    res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
    res.setHeader(
      "Cache-Control",
      file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    return json(res, 404, {
      ok: false,
      error: "请先执行 pnpm build，再执行 pnpm start",
    });
  }
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(port, bind, () => console.log(`AI 体检站本地服务：http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
