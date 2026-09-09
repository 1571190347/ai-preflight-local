import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export const backendCheckSources = [
  { id: "cloudflare", name: "Cloudflare HTTPS", url: "https://www.cloudflare.com/cdn-cgi/trace" },
  { id: "ipwho", name: "ipwho.is IP 数据源", url: "https://ipwho.is/1.1.1.1" },
  { id: "iana", name: "IANA RDAP 引导", url: "https://data.iana.org/rdap/dns.json" },
];
export function getDnsConfig() {
  const mode = process.env.DNS_MODE || "auto";
  if (!["auto", "system", "doh"].includes(mode))
    throw new Error("DNS_MODE 须为 auto、system 或 doh");
  return {
    mode,
    provider: "Cloudflare 1.1.1.1",
    endpoint: "https://1.1.1.1/dns-query",
    fallbackRule: "仅系统 DNS 返回 198.18.0.0/15 Fake-IP 时回退；普通内网地址和解析失败不回退",
    note: "仅主动运行后端检测时使用。DoH 会收到查询域名和本机服务的网络出口；不修改系统或浏览器 DNS。system 模式关闭 DoH；doh 模式直接查询公开 DoH。",
  };
}
export const exitSources = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    format: "trace",
    note: "到 Cloudflare 的 HTTP 出口",
  },
  {
    id: "ipv4",
    name: "IPv4 · ipify",
    url: "https://api.ipify.org?format=json",
    format: "ipify",
    note: "仅 IPv4",
  },
  {
    id: "ipv6",
    name: "IPv6 · ipify",
    url: "https://api6.ipify.org?format=json",
    format: "ipify",
    note: "仅 IPv6；失败不代表泄露",
  },
  {
    id: "claude",
    name: "Claude 边缘入口",
    url: "https://claude.ai/cdn-cgi/trace",
    format: "trace",
    note: "入口 trace；不等于应用内部风控",
  },
  {
    id: "chatgpt",
    name: "ChatGPT 边缘入口",
    url: "https://chatgpt.com/cdn-cgi/trace",
    format: "trace",
    note: "入口 trace；可能不允许跨站读取",
  },
];
export const connectionSources = [
  ["claude", "Claude", "https://claude.ai/favicon.ico"],
  ["anthropic", "Anthropic", "https://www.anthropic.com/favicon.ico"],
  ["chatgpt", "ChatGPT", "https://chatgpt.com/favicon.ico"],
  ["openai-api", "OpenAI API", "https://api.openai.com/v1/models"],
  ["google", "Google", "https://www.google.com/favicon.ico"],
  ["youtube", "YouTube", "https://www.youtube.com/favicon.ico"],
  ["github", "GitHub", "https://github.com/favicon.ico"],
  ["cloudflare", "Cloudflare", "https://www.cloudflare.com/favicon.ico"],
  ["wikipedia", "Wikipedia", "https://www.wikipedia.org/favicon.ico"],
  ["bing", "Bing", "https://www.bing.com/favicon.ico"],
  ["baidu", "百度", "https://www.baidu.com/favicon.ico"],
  ["bilibili", "哔哩哔哩", "https://www.bilibili.com/favicon.ico"],
  ["qq", "腾讯", "https://www.qq.com/favicon.ico"],
  ["taobao", "淘宝", "https://www.taobao.com/favicon.ico"],
].map(([id, name, url]) => ({ id, name, url }));
export const statusSources = [
  ["claude", "Claude", "AI", "https://status.claude.com"],
  ["openai", "OpenAI / ChatGPT", "AI", "https://status.openai.com"],
  ["cursor", "Cursor", "AI", "https://status.cursor.com"],
  ["elevenlabs", "ElevenLabs", "AI", "https://status.elevenlabs.io"],
  ["xai", "xAI", "AI", "https://status.x.ai"],
  ["groq", "Groq", "AI", "https://groqstatus.com"],
  ["perplexity", "Perplexity", "AI", "https://status.perplexity.ai"],
  ["replicate", "Replicate", "AI", "https://status.replicate.com"],
  ["cloudflare", "Cloudflare", "云服务", "https://www.cloudflarestatus.com"],
  ["digitalocean", "DigitalOcean", "云服务", "https://status.digitalocean.com"],
  ["fly", "Fly.io", "云服务", "https://status.flyio.net"],
  ["netlify", "Netlify", "云服务", "https://www.netlifystatus.com"],
  ["vercel", "Vercel", "云服务", "https://www.vercel-status.com"],
  ["supabase", "Supabase", "云服务", "https://status.supabase.com"],
  ["atlassian", "Jira", "开发", "https://jira-software.status.atlassian.com"],
  ["clerk", "Clerk", "开发", "https://status.clerk.com"],
  ["figma", "Figma", "开发", "https://status.figma.com"],
  ["github", "GitHub", "开发", "https://www.githubstatus.com"],
  ["notion", "Notion", "开发", "https://status.notion.so"],
  ["postman", "Postman", "开发", "https://status.postman.com"],
  ["python", "Python / PyPI", "开发", "https://status.python.org"],
  ["sentry", "Sentry", "开发", "https://status.sentry.io"],
  ["stripe", "Stripe", "开发", "https://status.stripe.com"],
  ["npm", "npm", "开发", "https://status.npmjs.org"],
  ["sendgrid", "SendGrid", "开发", "https://status.sendgrid.com"],
  ["twilio", "Twilio", "开发", "https://status.twilio.com"],
  ["discord", "Discord", "社区", "https://discordstatus.com"],
  ["pinterest", "Pinterest", "社区", "https://www.pintereststatus.com"],
  ["reddit", "Reddit", "社区", "https://www.redditstatus.com"],
  ["twitch", "Twitch", "社区", "https://status.twitch.com"],
  ["zoom", "Zoom", "社区", "https://status.zoom.us"],
].map(([id, name, category, url]) => ({ id, name, category, url }));
export const defaultConfig = {
  exitSources,
  connectionSources,
  statusSources,
  stunServers: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
  newsFeeds: [
    {
      id: "openai",
      name: "OpenAI News",
      url: "https://openai.com/news/rss.xml",
    },
  ],
  pingNodes: [],
};
export function loadConfig() {
  let custom = {};
  try {
    custom = JSON.parse(
      readFileSync(resolve(process.env.CONFIG_FILE || "config.local.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("config.local.json 不是有效的 JSON");
  }
  if (!custom || typeof custom !== "object" || Array.isArray(custom))
    throw new Error("配置须为 JSON 对象");
  const result = { ...defaultConfig };
  for (const key of Object.keys(defaultConfig)) {
    if (key in custom) {
      if (!Array.isArray(custom[key]) || custom[key].length > 64)
        throw new Error("配置列表无效：" + key);
      result[key] = custom[key];
    }
  }
  for (const kind of [
    "exitSources",
    "connectionSources",
    "statusSources",
    "newsFeeds",
    "pingNodes",
  ]) {
    const seen = new Set();
    result[kind] = result[kind].map((row) => {
      if (
        !row ||
        typeof row.id !== "string" ||
        !/^[a-z0-9-]{1,40}$/.test(row.id) ||
        seen.has(row.id) ||
        typeof row.name !== "string" ||
        row.name.length > 100
      )
        throw new Error("数据源 ID 或名称无效");
      seen.add(row.id);
      const u = new URL(row.url);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        (u.port && u.port !== "443") ||
        u.hash ||
        [...u.searchParams.keys()].some((k) => /key|token|secret|auth|password/i.test(k))
      )
        throw new Error("外部端点须使用不含凭据的标准 HTTPS URL");
      const clean = { id: row.id, name: row.name, url: u.href };
      if (["exitSources", "connectionSources"].includes(kind) && row.platform !== undefined) {
        if (!["claude", "gpt", "shared"].includes(row.platform))
          throw new Error("平台标记须为 claude、gpt 或 shared");
        clean.platform = row.platform;
      }
      for (const key of ["note", "category"])
        if (typeof row[key] === "string") clean[key] = row[key].slice(0, 500);
      if (kind === "exitSources") {
        if (!["trace", "ipify"].includes(row.format))
          throw new Error("出口数据格式须为 trace 或 ipify");
        clean.format = row.format;
      }
      if (kind === "pingNodes" && row.tokenEnv !== undefined) {
        if (typeof row.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.tokenEnv))
          throw new Error("Ping 令牌环境变量名无效");
        clean.tokenEnv = row.tokenEnv;
      }
      return clean;
    });
  }
  for (const u of result.stunServers) {
    if (
      typeof u !== "string" ||
      !/^stuns?:[a-zA-Z0-9.-]+:\d{1,5}$/.test(u) ||
      Number(u.split(":").at(-1)) < 1 ||
      Number(u.split(":").at(-1)) > 65535
    )
      throw new Error("仅允许 STUN 主机与端口");
  }
  return result;
}
