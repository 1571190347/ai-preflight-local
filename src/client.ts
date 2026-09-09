import { redact } from "./browser-tools.js";
export type Endpoint = {
  id: string;
  name: string;
  url: string;
  format?: string;
  note?: string;
  category?: string;
  platform?: "claude" | "gpt" | "shared";
};
export type Config = {
  apiToken: string;
  version: string;
  exitSources: Endpoint[];
  connectionSources: Endpoint[];
  statusSources: Endpoint[];
  newsFeeds: Endpoint[];
  pingNodes: Endpoint[];
  stunServers: string[];
  configured: Record<string, boolean>;
  dnsCollector: string | null;
  dnsTransport?: { mode: string; provider: string; endpoint: string; note: string };
  backendCheckSources?: Endpoint[];
};
export async function api(
  config: Config,
  path: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Preflight-Token": config.apiToken,
    },
    credentials: "same-origin",
    body: JSON.stringify({ ...input, consent: true }),
    signal,
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || "本地服务请求失败");
  return body.data;
}
async function direct(url: string, signal: AbortSignal | undefined, mode: RequestMode = "cors") {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) ctl.abort();
  const timer = setTimeout(abort, 6000);
  try {
    const response = await fetch(url, {
      mode,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: ctl.signal,
    });
    const text = mode === "no-cors" ? "" : await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export function validBrowserIp(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return s.split(".").every((n) => +n <= 255);
  if (!/^[a-f0-9:]+$/i.test(s) || !s.includes(":") || s.includes(":::")) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const words = halves.flatMap((h) => (h ? h.split(":") : []));
  return (
    words.every((w) => /^[a-f0-9]{1,4}$/i.test(w)) &&
    (halves.length === 2 ? words.length < 8 : words.length === 8)
  );
}
export async function exitCheck(endpoint: Endpoint, signal?: AbortSignal) {
  try {
    const { response, text } = await direct(endpoint.url, signal);
    if (!response.ok) throw new Error("HTTP " + response.status);
    let ip: unknown, country: string | undefined;
    if (endpoint.format === "trace") {
      const fields = Object.fromEntries(
        text.split("\n").map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1).trim()];
        }),
      );
      ip = fields.ip;
      country = fields.loc;
    } else {
      const body = JSON.parse(text);
      ip = body.ip;
      country = body.country_code;
    }
    if (!validBrowserIp(ip)) throw new Error("未返回可识别的 IP");
    return {
      id: endpoint.id,
      name: endpoint.name,
      ip,
      country: country || null,
      state: "received",
      source: endpoint.url,
      observer: "浏览器直测",
      platform: endpointPlatform(endpoint),
      note: endpoint.note ?? "",
    };
  } catch (e) {
    if (signal?.aborted) throw new Error("已停止");
    return {
      id: endpoint.id,
      name: endpoint.name,
      ip: null,
      state: "unknown",
      source: endpoint.url,
      observer: "浏览器直测",
      platform: endpointPlatform(endpoint),
      note: "超时、跨站读取限制或端点变化均可能导致无法读取。不是封禁或泄露结论。",
      error: e instanceof Error ? e.message : "读取失败",
    };
  }
}
export async function linkCheck(endpoint: Endpoint, signal?: AbortSignal) {
  const timings: number[] = [];
  const responses: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (signal?.aborted) throw new Error("已停止");
    const start = performance.now();
    try {
      const u = new URL(endpoint.url);
      u.searchParams.set("_preflight", Date.now() + "-" + i);
      const { response } = await direct(u.toString(), signal, "no-cors");
      timings.push(performance.now() - start);
      responses.push(response.type === "opaque" ? "不透明响应" : `HTTP ${response.status}`);
    } catch {
      responses.push("无法确认");
    }
  }
  timings.sort((a, b) => a - b);
  return {
    id: endpoint.id,
    name: endpoint.name,
    source: endpoint.url,
    state: timings.length ? "received" : "unknown",
    successes: timings.length,
    median: timings.length ? Math.round(timings[Math.floor(timings.length / 2)]) : null,
    responses,
    note: "浏览器 HTTP 轻量请求计时；不透明响应无法读取 HTTP 状态，不能证明登录、API 权限或应用可用。不是 ICMP Ping。",
  };
}
export async function browserBasics() {
  const data: Array<{ name: string; state: string; detail: string }> = [];
  const k = "preflight_tmp_" + Date.now() + Math.random().toString(36).slice(2);
  data.push({
    name: "安全上下文",
    state: window.isSecureContext ? "received" : "attention",
    detail: `${location.protocol} · ${window.isSecureContext ? "安全上下文" : "非安全上下文"}；localhost 的 HTTP 可属于安全上下文。`,
  });
  try {
    document.cookie = `${k}=1;SameSite=Strict;path=/`;
    data.push({
      name: "本站 Cookie",
      state: document.cookie.split(";").some((x) => x.trim() === k + "=1")
        ? "received"
        : "attention",
      detail: "临时读写测试；不覆盖目标平台或第三方 Cookie 权限。",
    });
  } catch {
    data.push({
      name: "本站 Cookie",
      state: "unknown",
      detail: "无法访问 Cookie",
    });
  } finally {
    try {
      document.cookie = `${k}=;Max-Age=0;path=/`;
    } catch {
      /* Cookie blocked */
    }
  }
  try {
    localStorage.setItem(k, "ok");
    const success = localStorage.getItem(k) === "ok";
    data.push({
      name: "本地存储",
      state: success ? "received" : "attention",
      detail: success ? "临时值已读回并清除。" : "无法读回临时值。",
    });
  } catch {
    data.push({
      name: "本地存储",
      state: "attention",
      detail: "可能受浏览器策略或存储空间限制。",
    });
  } finally {
    try {
      localStorage.removeItem(k);
    } catch {
      /* unavailable */
    }
  }
  const start = performance.now();
  try {
    const r = await fetch("/probe.json?" + Date.now(), {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const b = await r.json();
    if (b.service !== "ai-preflight") throw new Error();
    data.push({
      name: "本地页面连接",
      state: "received",
      detail: `${Math.round(performance.now() - start)} ms；仅本机页面往返耗时。`,
    });
  } catch {
    data.push({
      name: "本地页面连接",
      state: "unknown",
      detail: "本地探针未返回预期数据。",
    });
  }
  return data;
}
export async function batch<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 4) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已停止"));
    const end = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const t = setTimeout(end, ms);
    const abort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", abort);
      reject(new Error("已停止"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
export function downloadText(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type Snapshot = { id: string; at: string; data: unknown };
export function readSnapshots(storage: Pick<Storage, "getItem">, key: string): Snapshot[] {
  const rows = JSON.parse(storage.getItem(key) || "[]");
  if (!Array.isArray(rows)) throw new Error("历史格式错误");
  return rows
    .filter((x) => x && typeof x.id === "string" && typeof x.at === "string")
    .slice(0, 50)
    .map((x) => ({ id: x.id, at: x.at, data: redact(x.data) }));
}
export function saveSnapshot(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  data: unknown,
): Snapshot[] {
  const previous = readSnapshots(storage, key);
  const next = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      data: redact(data),
    },
    ...previous,
  ].slice(0, 50);
  storage.setItem(key, JSON.stringify(next));
  return next;
}

export function endpointPlatform(endpoint: Endpoint): "claude" | "gpt" | "shared" {
  if (endpoint.platform) return endpoint.platform;
  const host = new URL(endpoint.url).hostname.toLowerCase();
  if (/(^|\.)(claude\.ai|anthropic\.com)$/.test(host)) return "claude";
  if (/(^|\.)(chatgpt\.com|openai\.com)$/.test(host)) return "gpt";
  return "shared";
}
export function chosenEndpoints(endpoints: Endpoint[], ids: string[]): Endpoint[] {
  const selected = endpoints.filter((x) => ids.includes(x.id));
  if (!selected.length) throw new Error("请至少选择一个已配置的数据源");
  return selected;
}
export function platformEndpoints(
  endpoints: Endpoint[],
  platform: "claude" | "gpt",
  includeShared = false,
): Endpoint[] {
  return endpoints.filter(
    (x) => endpointPlatform(x) === platform || (includeShared && endpointPlatform(x) === "shared"),
  );
}
export function platformCountry(
  rows: Array<{
    source: string;
    country?: string;
    name: string;
    platform?: "claude" | "gpt" | "shared";
  }>,
  platform: "claude" | "gpt",
) {
  const observation = rows.find(
    (x) =>
      x.country &&
      endpointPlatform({ id: "", name: x.name, url: x.source, platform: x.platform }) === platform,
  );
  return observation ? { country: observation.country, source: observation.name } : null;
}
