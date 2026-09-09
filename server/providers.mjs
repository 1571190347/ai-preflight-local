import {
  jsonRequest,
  safeRequest,
  publicIp,
  target,
  resolvePublic,
  isPublicIp,
} from "./security.mjs";
import { isIP, createConnection } from "node:net";
import dns from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { backendCheckSources, getDnsConfig } from "./config.mjs";
export function normalizeProfile(id, data) {
  if (id === "ipapi") {
    if (data.error) throw new Error("ipapi.is 未返回有效结果；检查密钥或额度");
    const flags = {};
    for (const name of [
      "is_datacenter",
      "is_vpn",
      "is_proxy",
      "is_tor",
      "is_crawler",
      "is_abuser",
      "is_mobile",
      "is_bogon",
    ])
      flags[name] = typeof data[name] === "boolean" ? data[name] : null;
    return {
      source: "ipapi.is",
      ip: data.ip,
      country: data.location?.country ?? data.country,
      region: data.location?.state ?? data.region,
      city: data.location?.city ?? data.city,
      latitude: data.location?.latitude ?? data.lat,
      longitude: data.location?.longitude ?? data.lon,
      timezone: data.location?.timezone ?? data.timezone,
      asn: data.asn && typeof data.asn === "object" ? data.asn.asn : data.asn,
      organization:
        data.company && typeof data.company === "object" ? data.company.name : data.company,
      type: data.company?.type ?? data.asn?.type ?? null,
      flags,
      sourceRisk: data.company?.abuser_score ?? null,
      note: "风险字段缺失表示未提供数据，可能需要配置 API key；false 仅表示此数据源未标记。不是 Claude / OpenAI 评分。",
      raw: data,
    };
  }
  if (id === "ipwho") {
    if (data.success === false) throw new Error("ipwho.is 未返回有效结果");
    return {
      source: "ipwho.is",
      ip: data.ip,
      country: data.country,
      region: data.region,
      city: data.city,
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone?.id,
      asn: data.connection?.asn,
      organization: data.connection?.isp,
      type: null,
      flags: {},
      note: "地理与 ASN 信息，不推断住宅、原生或平台信任分。",
      raw: data,
    };
  }
  if (id === "abuse")
    return {
      source: "AbuseIPDB",
      ip: data.data?.ipAddress,
      sourceRisk: data.data?.abuseConfidenceScore ?? null,
      totalReports: data.data?.totalReports ?? null,
      lastReportedAt: data.data?.lastReportedAt ?? null,
      flags: { is_tor: data.data?.isTor ?? null },
      note: "AbuseIPDB 举报置信分（0–100）；不是账号封禁概率。",
      raw: data.data,
    };
  if (id === "shodan")
    return {
      source: "Shodan InternetDB",
      ip: data.ip,
      ports: data.ports ?? [],
      vulnerabilities: data.vulns ?? [],
      hostnames: data.hostnames ?? [],
      tags: data.tags ?? [],
      note: "第三方历史被动观测；无记录不等于无开放端口。漏洞基于服务元信息推断，未主动扫描。非商业使用按提供方条款。",
      raw: data,
    };
  throw new Error("未知数据源");
}
export async function ipProfile(ip, providers) {
  publicIp(ip);
  if (
    !Array.isArray(providers) ||
    !providers.length ||
    providers.length > 4 ||
    providers.some((p) => !["ipapi", "ipwho", "abuse", "shodan"].includes(p))
  )
    throw new Error("请选择有效 IP 数据源");
  return Promise.all(
    [...new Set(providers)].map(async (id) => {
      try {
        let data;
        if (id === "ipapi")
          data = await jsonRequest("https://api.ipapi.is/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            sensitive: !!process.env.IPAPI_KEY,
            body: JSON.stringify({
              q: ip,
              ...(process.env.IPAPI_KEY ? { key: process.env.IPAPI_KEY } : {}),
            }),
          });
        if (id === "ipwho") data = await jsonRequest("https://ipwho.is/" + encodeURIComponent(ip));
        if (id === "abuse") {
          if (!process.env.ABUSEIPDB_KEY)
            return {
              source: "AbuseIPDB",
              state: "unconfigured",
              message: "需要在本机 .env 中配置 ABUSEIPDB_KEY",
            };
          data = await jsonRequest(
            "https://api.abuseipdb.com/api/v2/check?ipAddress=" +
              encodeURIComponent(ip) +
              "&maxAgeInDays=90",
            {
              headers: {
                Key: process.env.ABUSEIPDB_KEY,
                Accept: "application/json",
              },
            },
          );
        }
        if (id === "shodan") {
          if (isIP(ip) !== 4)
            return {
              source: "Shodan InternetDB",
              state: "unknown",
              message: "此适配器仅查询 IPv4",
            };
          const r = await safeRequest("https://internetdb.shodan.io/" + ip);
          if (r.status === 404)
            return {
              source: "Shodan InternetDB",
              state: "unknown",
              message: "没有收录记录，不能推断端口关闭或无漏洞",
            };
          if (r.status !== 200) throw new Error("数据源返回 HTTP " + r.status);
          data = JSON.parse(r.text);
        }
        return {
          state: "received",
          ...normalizeProfile(id, data),
          fetchedAt: new Date().toISOString(),
        };
      } catch (e) {
        return { source: id, state: "unknown", message: e.message };
      }
    }),
  );
}
export function normalizeStatus(source, data) {
  const indicator = data?.status?.indicator;
  if (!["none", "minor", "major", "critical", "maintenance"].includes(indicator))
    throw new Error("该状态页暂不支持当前 JSON 格式，请手动查看");
  return {
    id: source.id,
    name: source.name,
    category: source.category,
    url: source.url,
    state: indicator === "none" ? "received" : "attention",
    indicator,
    description: data.status.description ?? "",
    incidents: Array.isArray(data.incidents)
      ? data.incidents.slice(0, 5).map((x) => ({
          name: x.name,
          status: x.status,
          updatedAt: x.updated_at,
          url: x.shortlink ?? source.url,
          body: x.incident_updates?.[0]?.body ?? "",
        }))
      : [],
    fetchedAt: new Date().toISOString(),
  };
}
export async function serviceStatus(source) {
  try {
    return normalizeStatus(
      source,
      await jsonRequest(source.url.replace(/\/$/, "") + "/api/v2/summary.json", { timeout: 8000 }),
    );
  } catch (e) {
    return {
      id: source.id,
      name: source.name,
      category: source.category,
      url: source.url,
      state: "unknown",
      message: e.message,
    };
  }
}
export function parseFeed(xml, source) {
  const unescape = (s) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const tag = (s, n) => {
    const m = s.match(new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">", "i"));
    return m ? unescape(m[1]).trim() : "";
  };
  const blocks = [];
  const lower = xml.toLowerCase();
  let cursor = 0;
  while (blocks.length < 60) {
    const item = lower.indexOf("<item", cursor),
      entry = lower.indexOf("<entry", cursor);
    const start = item < 0 ? entry : entry < 0 ? item : Math.min(item, entry);
    if (start < 0) break;
    const kind = start === item ? "item" : "entry";
    const at = start + kind.length + 1;
    if (!/[\s>]/.test(lower[at] || "")) {
      cursor = at;
      continue;
    }
    const open = lower.indexOf(">", at);
    if (open < 0) break;
    const close = lower.indexOf("</" + kind + ">", open + 1);
    if (close < 0) break;
    blocks.push(["", kind, xml.slice(open + 1, close)]);
    cursor = close + kind.length + 3;
  }
  if (!blocks.length) throw new Error("未发现 RSS / Atom 条目");
  return blocks.slice(0, 60).flatMap(([, kind, text]) => {
    let link = tag(text, "link");
    if (kind === "entry") link = text.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? link;
    try {
      const u = new URL(unescape(link));
      if (u.protocol !== "https:" && u.protocol !== "http:") return [];
    } catch {
      return [];
    }
    return [
      {
        title: tag(text, "title")
          .replace(/<[^>]+>/g, "")
          .slice(0, 300),
        url: unescape(link),
        date: tag(text, "pubDate") || tag(text, "published") || tag(text, "updated"),
        source: source.name,
        sourceId: source.id,
      },
    ];
  });
}
export async function news(source) {
  const r = await safeRequest(source.url, { maxBytes: 3_000_000 });
  if (r.status !== 200) throw new Error("订阅源返回 HTTP " + r.status);
  return parseFeed(r.text, source);
}
const bootstrapCache = new Map();
async function bootstrap(kind) {
  const old = bootstrapCache.get(kind);
  if (old && Date.now() - old.at < 86400000) return old.data;
  const data = await jsonRequest("https://data.iana.org/rdap/" + kind + ".json");
  if (!Array.isArray(data.services)) throw new Error("IANA 引导表格式无效");
  bootstrapCache.set(kind, { at: Date.now(), data });
  return data;
}
export async function tlds() {
  const data = await bootstrap("dns");
  return data.services.flatMap((x) => x[0]).sort();
}
function ipNumber(ip) {
  if (isIP(ip) === 4) return ip.split(".").reduce((a, v) => (a << 8n) + BigInt(v), 0n);
  let s = ip;
  if (s.includes(".")) throw new Error("不支持 IPv4 映射格式");
  const parts = s.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const words =
    parts.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return words.reduce((a, v) => (a << 16n) + BigInt("0x" + (v || "0")), 0n);
}
export function inCidr(ip, cidr) {
  const [base, prefixString] = cidr.split("/");
  if (isIP(ip) !== isIP(base)) return false;
  const bits = isIP(ip) === 4 ? 32 : 128;
  const prefix = Number(prefixString);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const shift = BigInt(bits - prefix);
  return ipNumber(ip) >> shift === ipNumber(base) >> shift;
}
export async function rdap(query) {
  const q = target(query, { allowAsn: true });
  const kind =
    q.kind === "domain"
      ? "dns"
      : q.kind === "autnum"
        ? "asn"
        : isIP(q.value) === 4
          ? "ipv4"
          : "ipv6";
  const data = await bootstrap(kind);
  let service;
  if (q.kind === "domain") {
    const suffix = q.value.split(".").at(-1);
    service = data.services.find((x) => x[0].includes(suffix));
  } else if (q.kind === "autnum") {
    service = data.services.find((x) =>
      x[0].some((range) => {
        const [low, high] = range.split("-").map(Number);
        return +q.value >= low && +q.value <= (high ?? low);
      }),
    );
  } else service = data.services.find((x) => x[0].some((cidr) => inCidr(q.value, cidr)));
  if (!service) throw new Error("IANA 未提供该对象的 RDAP 服务，可切换 WHOIS");
  const base = service[1].find((s) => s.startsWith("https://"));
  if (!base) throw new Error("该注册局没有可用 HTTPS RDAP 入口");
  const url = base.replace(/\/$/, "") + "/" + q.kind + "/" + encodeURIComponent(q.value);
  const raw = await jsonRequest(url);
  return {
    protocol: "RDAP",
    source: url,
    query: q.value,
    handle: raw.handle,
    name: raw.ldhName ?? raw.name,
    status: raw.status ?? [],
    events: raw.events ?? [],
    nameservers: (raw.nameservers ?? []).map((n) => n.ldhName),
    entities: (raw.entities ?? []).map((e) => ({
      handle: e.handle,
      roles: e.roles,
    })),
    raw,
  };
}
async function whoisText(host, query) {
  const addresses = await resolvePublic(host);
  const chosen = addresses[0];
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = createConnection({
      host: chosen.address,
      family: chosen.family,
      port: 43,
    });
    const timer = setTimeout(() => socket.destroy(new Error("WHOIS 请求超时")), 8000);
    socket.on("connect", () => socket.write(query + "\r\n"));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 200000) socket.destroy(new Error("WHOIS 响应过大"));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("WHOIS 连接提前关闭"));
    });
    socket.on("end", () => resolve(data));
  });
}
export async function whois(query) {
  const q = target(query, { allowAsn: true });
  const object = q.kind === "autnum" ? "AS" + q.value : q.value;
  const first = await whoisText("whois.iana.org", object);
  const referred = first.match(/^(?:refer|whois):\s*([a-z0-9.-]+)\s*$/im)?.[1];
  if (!referred)
    return {
      protocol: "WHOIS",
      source: "whois.iana.org:43",
      query: object,
      raw: first,
    };
  target(referred);
  const raw = await whoisText(referred, object);
  return { protocol: "WHOIS", source: referred + ":43", query: object, raw };
}
export async function localNetwork(query) {
  const q = target(query);
  let timer;
  const answers = await Promise.race([
    dns.lookup(q.value, { all: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("系统 DNS 解析超时")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  return {
    observer: "运行本地服务的计算机",
    configuredResolvers: dns.getServers(),
    answers,
    interfaces: Object.entries(networkInterfaces()).flatMap(([name, rows]) =>
      (rows ?? []).map((x) => ({
        name,
        address: x.address,
        family: x.family,
        internal: x.internal,
      })),
    ),
    note: "系统配置的解析器不等于浏览器实际使用的递归解析器。浏览器 DoH、代理和系统 DNS 可能不同；此结果不能作为 DNS 泄露结论。",
  };
}

export async function serverExit(source) {
  try {
    const response = await safeRequest(source.url);
    if (response.status !== 200) throw new Error("HTTP " + response.status);
    const fields =
      source.format === "trace"
        ? Object.fromEntries(
            response.text
              .split("\n")
              .filter((x) => x.includes("="))
              .map((x) => {
                const i = x.indexOf("=");
                return [x.slice(0, i), x.slice(i + 1).trim()];
              }),
          )
        : JSON.parse(response.text);
    if (!isIP(fields.ip)) throw new Error("未返回有效 IP");
    return {
      id: source.id,
      name: source.name,
      ip: fields.ip,
      country: fields.loc ?? fields.country_code ?? null,
      state: "received",
      source: source.url,
      observer: "本机 Node 服务",
      dns: response.dns,
      trace: source.format === "trace" ? fields : undefined,
    };
  } catch (e) {
    return {
      id: source.id,
      name: source.name,
      ip: null,
      state: "unknown",
      source: source.url,
      observer: "本机 Node 服务",
      error: e.message,
      dns: e.dns ?? null,
      note: "本机服务访问失败，不能据此推断浏览器的路径或账号状态。",
    };
  }
}

export async function backendCheck() {
  const results = await Promise.all(
    backendCheckSources.map(async (source) => {
      const start = performance.now();
      let response;
      try {
        response = await safeRequest(source.url, { timeout: 8000, maxBytes: 1_000_000 });
        if (response.status !== 200) throw new Error("数据源返回 HTTP " + response.status);
        if (source.id === "cloudflare") {
          const ip = response.text.match(/^ip=(.+)$/m)?.[1]?.trim();
          if (!isIP(ip ?? "")) throw new Error("HTTPS 已响应，但不是预期的 Cloudflare trace");
        } else {
          let data;
          try {
            data = JSON.parse(response.text);
          } catch {
            throw new Error("HTTPS 已响应，但未返回预期 JSON");
          }
          if (source.id === "ipwho" && (data?.ip !== "1.1.1.1" || data.success === false))
            throw new Error("IP 数据源未返回预期示例结果");
          if (source.id === "iana" && !Array.isArray(data?.services))
            throw new Error("IANA 未返回预期 RDAP 引导表");
        }
        return {
          ...source,
          state: "received",
          httpStatus: response.status,
          durationMs: Math.round(performance.now() - start),
          dns: response.dns,
          message: "已通过 HTTPS 收到预期格式；不代表所有数据源或 AI 账号可用。",
        };
      } catch (error) {
        return {
          ...source,
          state: "unknown",
          httpStatus: response?.status ?? null,
          durationMs: Math.round(performance.now() - start),
          dns: response?.dns ?? error.dns ?? null,
          error: error.message,
          message: "本机后端未完成此项；请按具体错误检查 DNS 或网络路径。",
        };
      }
    }),
  );
  return {
    observer: "本机 Node 服务",
    checkedAt: new Date().toISOString(),
    dnsTransport: getDnsConfig(),
    results,
    note: "只检查列出的三个固定示例端点；不使用 API 密钥。ipwho.is 查询的是固定示例 IP 1.1.1.1。浏览器与本机服务可能使用不同路径；DoH 回退只改变本次后端解析。",
  };
}
