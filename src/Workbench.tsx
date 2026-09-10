import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ShieldCheck,
  ArrowRight,
  Download,
  RefreshCw,
  EyeOff,
  Globe2,
  Settings2,
  Monitor,
  Radio,
  Search,
  Network,
  FileText,
  History as HistoryIcon,
  Palette,
  Square,
  Copy,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  api,
  chosenEndpoints,
  platformEndpoints,
  platformCountry,
  endpointPlatform,
  readSnapshots,
  saveSnapshot,
  batch,
  browserBasics,
  downloadText,
  exitCheck,
  linkCheck,
  buildQuickReport,
  buildAiReadableReport,
  sleep,
  type Config,
  type QuickReport,
} from "./client";
import { inspectDevice, collectWebRTC, redact } from "./browser-tools";
import { cardThemes, cardPatterns, cardStamps, makeIpCard } from "./card-tools";
import { regionNote, sources } from "@/lib/diagnostics";
type Data = Record<string, any>;
type Saved = { id: string; at: string; data: unknown };
const sections = [
  ["overview", "总览", Activity],
  ["ip", "IP 与分流", Globe2],
  ["claude", "Claude", ShieldCheck],
  ["gpt", "ChatGPT / Codex", ShieldCheck],
  ["quality", "IP 画像", Search],
  ["connect", "网络连通", Network],
  ["dns", "DNS 检测", Network],
  ["rtc", "WebRTC", Radio],
  ["ping", "全球 Ping", Activity],
  ["status", "服务状态", Globe2],
  ["whois", "WHOIS / RDAP", FileText],
  ["device", "设备与指纹", Monitor],
  ["history", "本地历史", HistoryIcon],
  ["news", "AI 资讯", FileText],
  ["card", "IP 卡片", Palette],
  ["privacy", "数据与设置", Settings2],
] as const;
const states: Record<string, string> = {
  received: "已获取",
  attention: "需核对",
  unknown: "无法确认",
  unconfigured: "需配置",
  finished: "已完成",
  inprogress: "进行中",
  "in-progress": "进行中",
};
const HISTORY_KEY = "ai-preflight-local-history-v1";
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  let safe = false;
  try {
    safe = ["https:", "http:"].includes(new URL(href).protocol);
  } catch {
    /* invalid URL */
  }
  return safe ? (
    <a className="external-link" href={href} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  ) : (
    <span>{children}</span>
  );
}
function Pill({ state }: { state: string }) {
  return (
    <span
      className={`state-pill ${state === "attention" ? "attention" : state === "received" || state === "finished" ? "info" : "unknown"}`}
    >
      {states[state] ?? state}
    </span>
  );
}
const Pane = ({ id, children }: { id: string; children: ReactNode }) => (
  <TabsContent value={id}>{children}</TabsContent>
);
export default function Workbench() {
  const [view, setView] = useState("overview");
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");
  const [external, setExternal] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [fingerprint, setFingerprint] = useState(false);
  const [saveEnabled, setSaveEnabled] = useState(false);
  const [data, setData] = useState<Data>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);
  const [exitIds, setExitIds] = useState<string[]>([]);
  const [linkIds, setLinkIds] = useState<string[]>([]);
  const [ip, setIp] = useState("");
  const [profileIds, setProfileIds] = useState(["ipapi", "ipwho"]);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState("local");
  const [limit, setLimit] = useState("5");
  const [query, setQuery] = useState("");
  const [statusCategory, setStatusCategory] = useState("全部");
  const [tldFilter, setTldFilter] = useState("");
  const [newsSearch, setNewsSearch] = useState("");
  const [newsSource, setNewsSource] = useState("全部");
  const [newsPage, setNewsPage] = useState(1);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [theme, setTheme] = useState(cardThemes[0].id);
  const [pattern, setPattern] = useState(cardPatterns[0].id);
  const [stamp, setStamp] = useState(cardStamps[0].id);
  const [cardTitle, setCardTitle] = useState("我的网络环境");
  const [cardDetail, setCardDetail] = useState("本地生成 · 仅展示本次观察");
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/config", { cache: "no-store", signal: ctl.signal })
      .then((r) => r.json())
      .then((b) => {
        if (!b.ok || !b.data?.apiToken) throw new Error("本地 API 未就绪");
        setConfig(b.data);
        const exits = b.data.exitSources as Config["exitSources"];
        const shared = exits.filter((x) => endpointPlatform(x) === "shared");
        setExitIds((shared.length ? shared : exits).map((x) => x.id));
        setLinkIds((b.data.connectionSources as Config["connectionSources"]).map((x) => x.id));
      })
      .catch((e) => {
        if (!ctl.signal.aborted)
          setConfigError(e.message + "。请使用 pnpm dev 或 pnpm start 启动完整工具。");
      });
    return () => ctl.abort();
  }, []);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!config || autoStarted.current) return;
    autoStarted.current = true;
    void runQuickReport(config);
  }, [config]);
  function put(key: string, value: unknown) {
    setData((current) => ({ ...current, [key]: value }));
  }
  async function perform(
    key: string,
    fn: (signal: AbortSignal) => Promise<unknown>,
    outside = true,
  ) {
    if (active.current) return;
    if (outside && !external) {
      setError("请先开启本次会话的外部检测。");
      return;
    }
    if (outside && !config) {
      setError("本地服务尚未就绪");
      return;
    }
    const ctl = new AbortController();
    active.current = ctl;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await fn(ctl.signal);
      if (!ctl.signal.aborted) {
        put(key, result);
        setNotice("本次操作已完成，结果仅保留在当前页面。");
      }
    } catch (e) {
      setError(
        ctl.signal.aborted
          ? "已停止本次操作；已经发出的远程测量可能仍会短暂运行。"
          : e instanceof Error
            ? e.message
            : "操作失败",
      );
    } finally {
      active.current = null;
      setBusy("");
    }
  }
  function toggle(list: string[], id: string, setter: (v: string[]) => void) {
    setter(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }
  const ips: string[] = (data.ip ?? []).filter((x: Data) => x.ip).map((x: Data) => x.ip);
  const knownIp = ip.trim() || ips[0] || "";
  const display = (value: unknown) => (hidden ? redact(value) : value);
  function raw(value: unknown) {
    return (
      <pre className="raw-result">
        {typeof display(value) === "string"
          ? (display(value) as string)
          : JSON.stringify(display(value), null, 2)}
      </pre>
    );
  }
  function output(key: string) {
    if (data[key] === undefined)
      return (
        <div className="empty-result">
          <span className="empty-dot" />
          尚未检测。准备好后，点击上方按钮。
        </div>
      );
    return raw(data[key]);
  }
  function runExits(ids = exitIds, key = "ip") {
    return perform(key, async (signal) =>
      batch(chosenEndpoints(config!.exitSources, ids), (e) => exitCheck(e, signal)),
    );
  }
  function runLinks(ids = linkIds, key = "connect") {
    return perform(key, async (signal) =>
      batch(chosenEndpoints(config!.connectionSources, ids), (e) => linkCheck(e, signal)),
    );
  }
  async function runQuickReport(reportConfig = config) {
    if (!reportConfig || active.current) return;
    const ctl = new AbortController();
    active.current = ctl;
    setExternal(true);
    setBusy("quick");
    setError("");
    setNotice("");
    setData((current) => ({
      ...current,
      quick: { state: "running", stage: "正在识别公网出口…" },
    }));
    try {
      const browserExits = await batch(
        reportConfig.exitSources,
        (endpoint) => exitCheck(endpoint, ctl.signal),
        4,
      );
      const sharedEndpoints = reportConfig.exitSources
        .filter((endpoint) => endpointPlatform(endpoint) === "shared")
        .slice(0, 3);
      const serverExits = await batch(
        sharedEndpoints,
        async (endpoint) => {
          try {
            return await api(reportConfig, "/api/exit", { id: endpoint.id }, ctl.signal);
          } catch (cause) {
            if (ctl.signal.aborted) throw cause;
            return {
              id: endpoint.id,
              name: endpoint.name,
              source: endpoint.url,
              observer: "本机服务",
              state: "unknown",
              ip: null,
              error: cause instanceof Error ? cause.message : "无法读取出口",
            };
          }
        },
        3,
      );
      const preferred = [...browserExits, ...serverExits].find(
        (row: Data) => row.state === "received" && row.ip && row.id === "ipv4",
      );
      const fallback = [...browserExits, ...serverExits].find(
        (row: Data) => row.state === "received" && row.ip,
      );
      const currentIp = String(preferred?.ip ?? fallback?.ip ?? "");
      setData((current) => ({
        ...current,
        quick: { state: "running", stage: "正在查询 IP 属性和 AI 连接…" },
      }));
      const aiEndpoints = reportConfig.connectionSources.filter(
        (endpoint) => endpointPlatform(endpoint) !== "shared",
      );
      const providers = ["ipapi", "ipwho", "shodan"];
      if (reportConfig.configured.abuse) providers.push("abuse");
      const [basics, device, links, profiles] = await Promise.all([
        browserBasics(),
        inspectDevice(false),
        batch(
          aiEndpoints,
          async (endpoint) => ({
            ...(await linkCheck(endpoint, ctl.signal)),
            platform: endpointPlatform(endpoint),
          }),
          4,
        ),
        currentIp
          ? api(reportConfig, "/api/ip-profile", { ip: currentIp, providers }, ctl.signal).catch(
              (cause) => {
                if (ctl.signal.aborted) throw cause;
                return [
                  {
                    source: "IP 画像",
                    state: "unknown",
                    message: cause instanceof Error ? cause.message : "查询失败",
                  },
                ];
              },
            )
          : Promise.resolve([]),
      ]);
      const report = buildQuickReport({
        currentIp: currentIp || null,
        exits: [...browserExits, ...serverExits],
        profiles,
        links,
      });
      if (ctl.signal.aborted) return;
      if (currentIp) setIp(currentIp);
      setData((current) => ({
        ...current,
        quick: report,
        basics,
        device,
        ip: browserExits,
        serverIp: serverExits,
        quality: profiles,
        connect: links,
        claudeIp: browserExits.filter((row: Data) => row.platform === "claude"),
        gptIp: browserExits.filter((row: Data) => row.platform === "gpt"),
        claudeConnect: links.filter((row: Data) => row.platform === "claude"),
        gptConnect: links.filter((row: Data) => row.platform === "gpt"),
      }));
      setNotice("自动体检已完成。可在下方模块继续查看原始证据。");
    } catch (cause) {
      if (!ctl.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "自动体检失败";
        setData((current) => ({ ...current, quick: { state: "error", message } }));
        setError(message);
      }
    } finally {
      if (active.current === ctl) active.current = null;
      setBusy("");
    }
  }
  async function copyAiReport() {
    const report = data.quick as QuickReport | undefined;
    if (report?.state !== "finished") return;
    try {
      await navigator.clipboard.writeText(buildAiReadableReport(report, data));
      setNotice("已复制脱敏的 AI 易读报告，可以粘贴给你的 AI 继续分析。");
    } catch {
      setError("浏览器不允许写入剪贴板，请改用“下载 AI 报告”。");
    }
  }
  function command(label: string, key: string, action: () => void, outside = true) {
    return (
      <button
        className="primary-button"
        disabled={!!busy || (outside && (!external || !config))}
        onClick={action}
      >
        {busy === key ? <RefreshCw size={16} className="spinning" /> : <ArrowRight size={16} />}{" "}
        {busy === key ? "正在检测…" : label}
      </button>
    );
  }
  function evidence(text: ReactNode) {
    return (
      <div className="evidence-note">
        <ShieldCheck size={17} />
        <p>{text}</p>
      </div>
    );
  }
  function ipRows(key = "ip") {
    const rows = data[key];
    return !rows ? (
      output(key)
    ) : (
      <div className="results-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>访问目的地</TableHead>
              <TableHead>出口 IP</TableHead>
              <TableHead>地区代码</TableHead>
              <TableHead>结果</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((x: Data) => (
              <TableRow key={x.id}>
                <TableCell>
                  <strong>{x.name}</strong>
                  <small>
                    {x.observer} · {new URL(x.source).host}
                  </small>
                </TableCell>
                <TableCell className="mono">{x.ip ? String(display(x.ip)) : "—"}</TableCell>
                <TableCell>{x.country ?? "未提供"}</TableCell>
                <TableCell>
                  <Pill state={x.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="table-note">
          {new Set(rows.filter((x: Data) => x.ip).map((x: Data) => x.ip)).size > 1
            ? "观察到不同出口。请结合 IPv4 / IPv6 与目的地判断是否符合自己的分流预期。"
            : "相同出口或未获取完整数据，不能证明所有目的地都走同一条路径。"}
        </p>
        {rows
          .filter((x: Data) => x.error)
          .map((x: Data) => (
            <p className="table-note" key={x.id}>
              {x.name}：{String(display(x.error))}。{x.note}
            </p>
          ))}
      </div>
    );
  }
  function linkRows(key = "connect") {
    const rows = data[key];
    return !rows ? (
      output(key)
    ) : (
      <div className="results-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>目的地</TableHead>
              <TableHead>收到响应</TableHead>
              <TableHead>中位数</TableHead>
              <TableHead>解释</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((x: Data) => (
              <TableRow key={x.id}>
                <TableCell>{x.name}</TableCell>
                <TableCell>{x.successes} / 3</TableCell>
                <TableCell className="mono">{x.median === null ? "—" : x.median + " ms"}</TableCell>
                <TableCell>{x.successes ? "HTTP 状态不可读" : "无法确认"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  async function runDns(count: number, signal: AbortSignal) {
    const session = await api(config!, "/api/dns/start", { count }, signal);
    put("dnsSession", session.id);
    await batch(
      session.hostnames as string[],
      async (hostname) => {
        try {
          await fetch("https://" + hostname + "/", {
            mode: "no-cors",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
          });
        } catch {
          /* NXDOMAIN is expected; collector observes DNS. */
        }
      },
      4,
    );
    await sleep(1200, signal);
    const result = await api(config!, "/api/dns/result", { id: session.id }, signal);
    return {
      ...result,
      note: "观察到的是递归解析器的出口，不是设备真实 IP。空结果可能源于阻断、缓存或采集端配置；不能判定“安全”。",
    };
  }
  async function geoLookup(addresses: string[], signal: AbortSignal) {
    const unique = [...new Set(addresses)].slice(0, 30);
    if (!unique.length) throw new Error("尚无可查询的地址");
    return batch(
      unique,
      async (address) => {
        try {
          const result = await api(
            config!,
            "/api/ip-profile",
            { ip: address, providers: ["ipwho"] },
            signal,
          );
          return { address, ...result[0] };
        } catch (e) {
          if (signal.aborted) throw e;
          return {
            address,
            state: "unknown",
            message: "非公网地址或数据源不可读；未查询到归属地",
          };
        }
      },
      3,
    );
  }
  function geoRows(key: string) {
    return !data[key] ? null : (
      <div className="results-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>国家 / 城市</TableHead>
              <TableHead>运营商</TableHead>
              <TableHead>结果</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data[key].map((x: Data, i: number) => (
              <TableRow key={i}>
                <TableCell className="mono">{String(display(x.address))}</TableCell>
                <TableCell>{[x.country, x.city].filter(Boolean).join(" / ") || "未提供"}</TableCell>
                <TableCell>{x.organization || "未提供"}</TableCell>
                <TableCell>
                  <Pill state={x.state} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="table-note">归属地来自 ipwho.is，仅作数据库线索；不是设备定位。</p>
      </div>
    );
  }
  async function ping(signal: AbortSignal) {
    const result = await api(config!, "/api/ping/start", { target, mode, limit: +limit }, signal);
    if (!result.id) return result;
    let latest = result;
    put("ping", result);
    for (let i = 0; i < 25; i++) {
      await sleep(1200, signal);
      const next = await api(config!, "/api/ping/result", { id: result.id }, signal);
      latest = next;
      put("ping", next);
      if (next.status === "finished") return next;
    }
    return { ...latest, note: "测量尚未结束，可点击刷新测量结果。" };
  }
  function saveHistory() {
    try {
      setSaved(saveSnapshot(localStorage, HISTORY_KEY, data));
      setNotice("已在当前浏览器保存脱敏快照。");
    } catch {
      setError("本地存储不可用，未保存。");
    }
  }
  function loadHistory() {
    try {
      setSaved(readSnapshots(localStorage, HISTORY_KEY));
      setNotice("已读取当前浏览器历史。");
    } catch {
      setError("历史数据不可读。");
    }
  }
  const makeCard = (forceMask = false) =>
    makeIpCard({
      ip: knownIp || "尚未填写 IP",
      title: cardTitle,
      detail: cardDetail,
      theme,
      pattern,
      stamp,
      hideIp: forceMask || hidden,
    });
  async function pngCard() {
    const svg = makeCard(true);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("卡片图像无法加载"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1440;
      canvas.height = 680;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 不可用");
      ctx.drawImage(img, 0, 0, 1440, 680);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 导出失败"))), "image/png"),
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ip-card.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const selectedTitle = sections.find((x) => x[0] === view)?.[1] ?? "总览";
  const profiles = data.quality ?? [];
  const quick = data.quick as Data | undefined;
  return (
    <div className="local-shell">
      <header className="local-header">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("overview");
          }}
        >
          <span className="brand-mark">
            <Activity size={23} />
          </span>
          AI 体检站 <small>LOCAL 0.4</small>
        </a>
        <div className="header-controls">
          <label>
            <EyeOff size={15} />
            隐藏敏感信息
            <Switch checked={hidden} onCheckedChange={setHidden} aria-label="隐藏敏感信息" />
          </label>
          <span className="local-tag">
            <ShieldCheck size={16} /> 本机运行
          </span>
        </div>
      </header>
      <Tabs
        value={view}
        onValueChange={(v) => {
          setView(String(v));
          setError("");
          setNotice("");
        }}
        orientation="vertical"
        className="local-layout"
      >
        <TabsList className="local-nav">
          {sections.map(([id, name, Icon]) => (
            <TabsTrigger key={id} value={id}>
              <Icon size={16} />
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
        <main className="local-main">
          <div className="local-heading">
            <div>
              <p className="eyebrow">LOCAL-FIRST / NETWORK DIAGNOSTICS</p>
              <h1>{view === "overview" ? "打开即出报告，看懂当前网络。" : selectedTitle}</h1>
            </div>
            <div className="session-control">
              <span>
                外部检测 <small>仅本次会话</small>
              </span>
              <Switch
                checked={external}
                disabled={!!busy}
                onCheckedChange={setExternal}
                aria-label="允许本次会话的外部检测"
              />
            </div>
          </div>
          <p className="session-note">
            {external
              ? "首页会自动请求公开 IP、网络属性和 Claude / ChatGPT 入口来生成报告；关闭后仅影响后续手动检测。"
              : "外部检测已关闭。本地基础检查、设备信息与卡片生成仍可使用。"}
          </p>
          {configError && (
            <div className="error-banner" role="alert">
              {configError}
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {busy && (
            <div className="busy-banner" role="status">
              <RefreshCw size={15} className="spinning" />
              检测中，请稍候
              <button className="quiet-button" onClick={() => active.current?.abort()}>
                <Square size={12} />
                停止
              </button>
            </div>
          )}
          <Pane id="overview">
            <section className={`quick-report quick-${quick?.level ?? "loading"}`}>
              <div className="quick-report-heading">
                <div>
                  <span className="section-label">自动体检报告</span>
                  <h2>
                    {quick?.state === "finished"
                      ? quick.title
                      : quick?.state === "error"
                        ? "自动体检没有完成"
                        : "正在检查你的网络环境…"}
                  </h2>
                  <p>
                    {quick?.state === "finished"
                      ? quick.description
                      : (quick?.message ?? quick?.stage ?? "正在连接公开检测来源，请稍候。")}
                  </p>
                </div>
                <div className="quick-actions">
                  <span className={`quick-verdict ${quick?.level ?? "loading"}`}>
                    {quick?.state === "finished"
                      ? quick.level === "risk"
                        ? "高风险信号"
                        : quick.level === "attention"
                          ? "需要留意"
                          : quick.level === "clear"
                            ? "未见明显风险"
                            : "资料不完整"
                      : "检测中"}
                  </span>
                  <button
                    className="quiet-button"
                    disabled={!!busy || !config}
                    onClick={() => void runQuickReport()}
                  >
                    <RefreshCw size={15} className={busy === "quick" ? "spinning" : ""} />
                    重新检测
                  </button>
                  {quick?.state === "finished" && (
                    <>
                      <button className="quiet-button" onClick={() => void copyAiReport()}>
                        <Copy size={15} />
                        复制给 AI
                      </button>
                      <button
                        className="quiet-button"
                        onClick={() =>
                          downloadText(
                            "ai-preflight-report.md",
                            buildAiReadableReport(quick as QuickReport, data),
                            "text/markdown;charset=utf-8",
                          )
                        }
                      >
                        <Download size={15} />
                        下载 AI 报告
                      </button>
                    </>
                  )}
                </div>
              </div>
              {quick?.state === "finished" && (
                <>
                  <dl className="quick-facts">
                    {[
                      ["当前公网 IP", display(quick.facts.ip) || "未获取"],
                      ["国家 / 地区", quick.facts.country || "未提供"],
                      ["ASN", quick.facts.asn || "未提供"],
                      ["运营商 / 组织", quick.facts.organization || "未提供"],
                      ["网络类型", quick.facts.type || "未提供"],
                      ["数据覆盖", `${quick.coverage.received} / ${quick.coverage.total} 个来源`],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <dt>{String(label)}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="finding-grid">
                    {quick.findings.map((finding: Data) => (
                      <article className={`finding-card finding-${finding.level}`} key={finding.id}>
                        <div>
                          <span className="finding-dot" />
                          <strong>{finding.title}</strong>
                        </div>
                        <p>{finding.detail}</p>
                        <small>{finding.advice}</small>
                      </article>
                    ))}
                  </div>
                  <p className="quick-time">
                    检测时间：{new Date(quick.checkedAt).toLocaleString()}。完整响应可在“IP 画像”“IP
                    与分流”和平台页面查看。
                  </p>
                  <p className="quick-share-note">
                    “复制给 AI”和 Markdown 下载会自动隐藏公网 IP，并附上证据边界与分析要求。
                  </p>
                </>
              )}
            </section>
            <div className="overview-grid">
              <section className="overview-primary">
                <span className="section-label">报告如何判断</span>
                <h2>优先看明确证据，不猜封号概率</h2>
                <p>
                  报告会识别数据源明确标记的代理、VPN、Tor、滥用、机房属性、出口地区差异和 AI
                  入口连通情况。缺少风险数据时直接写“资料不完整”。
                </p>
                {command("重新生成完整报告", "quick", () => void runQuickReport())}
              </section>
              <section className="overview-secondary">
                <ShieldCheck size={28} />
                <h3>“未发现”不等于绝对干净</h3>
                <p>
                  平台不会公开内部风控分。账号行为、付款资料、登录历史和其他共享出口使用者，不是网页检测能完整看到的。
                </p>
                <button className="text-link" onClick={() => setView("privacy")}>
                  查看所有数据源 <ArrowRight size={15} />
                </button>
              </section>
            </div>
            {data.basics && (
              <div className="metric-grid">
                {data.basics.map((x: Data) => (
                  <article className="metric-card" key={x.name}>
                    <h3>{x.name}</h3>
                    <Pill state={x.state} />
                    <p>{x.detail}</p>
                  </article>
                ))}
              </div>
            )}
            <h2 className="subheading">继续查看详细证据</h2>
            <div className="module-grid">
              {[
                ["ip", "不同网站走了不同出口？", "IPv4 / IPv6 与目的地分流"],
                ["claude", "Claude 无法使用？", "出口、连接与官方规则"],
                ["gpt", "ChatGPT / Codex 异常？", "分别检查网页与 API 路径"],
                ["dns", "DNS 走到了哪里？", "系统设置与权威 DNS 观测"],
                ["rtc", "UDP 与 HTTP 出口不同？", "多节点 STUN / ICE 观察"],
                ["quality", "想了解一个 IP？", "多源属性、风险记录和端口"],
              ].map(([id, title, desc]) => (
                <button className="module-card" key={id} onClick={() => setView(id)}>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
            {evidence(
              "本工具提供可核对的网络证据，不提供 Claude 或 OpenAI 的内部信任分，也不保证账号不会受限。",
            )}
            <section className="tool-panel" style={{ marginTop: 24 }}>
              <div className="panel-heading">
                <div>
                  <h2>后台数据源是否能访问？</h2>
                  <p className="lede">
                    浏览器和本地服务可能走不同网络路径，先确认后台能连接查询服务。
                  </p>
                </div>
                {command(
                  "检查后台连接",
                  "backend",
                  () =>
                    void perform("backend", (signal) =>
                      api(config!, "/api/backend-check", {}, signal),
                    ),
                )}
              </div>
              <p className="table-note">
                当前 DNS 模式：{config?.dnsTransport?.mode ?? "读取中"}。
                {config?.dnsTransport?.note}
              </p>
              {data.backend?.results ? (
                <div className="results-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>目的地</TableHead>
                        <TableHead>结果</TableHead>
                        <TableHead>DNS 来源</TableHead>
                        <TableHead>原因 / 耗时</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.backend.results.map((x: Data) => (
                        <TableRow key={x.id}>
                          <TableCell>{x.name}</TableCell>
                          <TableCell>
                            <Pill state={x.state} />
                          </TableCell>
                          <TableCell>{x.dns?.source ?? "未知"}</TableCell>
                          <TableCell>
                            {x.error
                              ? String(display(x.error))
                              : `HTTP ${x.httpStatus} · ${x.durationMs} ms`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <details>
                    <summary>查看观测详情</summary>
                    {raw(data.backend)}
                  </details>
                </div>
              ) : (
                output("backend")
              )}
            </section>
          </Pane>
          <Pane id="ip">
            <section className="tool-panel">
              <h2>按目的地观察出口</h2>
              <p className="lede">请求从当前浏览器直接发出，不经过本机服务转发。</p>
              <div className="choice-grid">
                {config?.exitSources.map((e) => (
                  <label key={e.id}>
                    <Switch
                      checked={exitIds.includes(e.id)}
                      disabled={!!busy}
                      onCheckedChange={() => toggle(exitIds, e.id, setExitIds)}
                    />
                    <span>
                      <strong>{e.name}</strong>
                      <small>{new URL(e.url).host}</small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="action-row">
                {command("检测浏览器出口", "ip", () => void runExits())}
                {command(
                  "对照本机服务出口",
                  "serverIp",
                  () =>
                    void perform("serverIp", (s) =>
                      batch(chosenEndpoints(config!.exitSources, exitIds), (x) =>
                        api(config!, "/api/exit", { id: x.id }, s),
                      ),
                    ),
                )}
              </div>
              <p className="table-note">
                对照按钮由本机 Node 服务访问相同端点；其代理设置可能与浏览器不同。
              </p>
              {ipRows()}
              {data.serverIp && (
                <>
                  <h3 className="subheading">本机服务观测</h3>
                  {ipRows("serverIp")}
                </>
              )}
            </section>
            {evidence(
              "平台入口可能禁止跨站读取。失败时保留“无法确认”，不会用 Cloudflare 出口冒充平台出口。IPv4 与 IPv6 同时存在也不自动判定泄露。",
            )}
          </Pane>
          {(["claude", "gpt"] as const).map((p) => (
            <Pane id={p} key={p}>
              <div className="ai-grid">
                <section className="tool-panel">
                  <h2>{p === "claude" ? "Claude" : "ChatGPT / Codex"} 使用前检查</h2>
                  <p className="lede">平台入口、网络连接和账号资格分别核对。</p>
                  <div className="action-row">
                    {command(
                      "检测相关出口",
                      p + "Ip",
                      () =>
                        void runExits(
                          platformEndpoints(config!.exitSources, p, true).map((x) => x.id),
                          p + "Ip",
                        ),
                    )}
                    {command(
                      "检查网页 / API 响应",
                      p + "Connect",
                      () =>
                        void runLinks(
                          platformEndpoints(config!.connectionSources, p).map((x) => x.id),
                          p + "Connect",
                        ),
                    )}
                  </div>
                  {ipRows(p + "Ip")}
                  {linkRows(p + "Connect")}
                </section>
                <aside className="tool-panel">
                  <h3>地区支持与账号状态</h3>
                  <p className="lede">
                    {regionNote(platformCountry(data[p + "Ip"] ?? [], p)?.country ?? "")}
                  </p>
                  <p className="table-note">
                    {platformCountry(data[p + "Ip"] ?? [], p)
                      ? `地区观察来源：${platformCountry(data[p + "Ip"], p)?.source}`
                      : "尚未取得平台自身的地区观测；通用 Cloudflare 出口不代替平台出口。"}
                  </p>
                  <SafeLink href={sources[p === "claude" ? "claude" : "chatgpt"].region}>
                    官方支持地区
                  </SafeLink>
                  <SafeLink href={sources[p === "claude" ? "claude" : "chatgpt"].help}>
                    官方登录排查
                  </SafeLink>
                  <SafeLink href={sources[p === "claude" ? "claude" : "chatgpt"].site}>
                    打开平台验证个人访问
                  </SafeLink>
                  <hr />
                  <h3>平台内部信任分</h3>
                  <p className="lede">
                    无法获取。IP 画像页展示的是外部数据源的标签与评分，不会改名为 Claude / GPT
                    评分。
                  </p>
                  <button className="quiet-button" onClick={() => setView("quality")}>
                    查看 IP 数据来源 →
                  </button>
                  <p className="table-note">
                    官方规则核实于 2026-09-07；超过 30 天自动提示重新核实。
                  </p>
                </aside>
              </div>
              {evidence(
                "API 端点收到响应不代表有调用权限；本工具不会使用 API key 登录 Claude 或 OpenAI。设备时区、语言与 IPv6 不直接换算成封号风险。",
              )}
            </Pane>
          ))}
          <Pane id="quality">
            <section className="tool-panel">
              <h2>IP 属性与风险来源</h2>
              <div className="input-row">
                <Input
                  aria-label="要查询的 IP"
                  placeholder="填写公网 IP；可先到 IP 与分流获取出口"
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                />
                {command(
                  "查询所选数据源",
                  "quality",
                  () =>
                    void perform("quality", (signal) =>
                      api(
                        config!,
                        "/api/ip-profile",
                        { ip: knownIp, providers: profileIds },
                        signal,
                      ),
                    ),
                )}
              </div>
              {!ip && ips[0] && (
                <p className="table-note">将查询本次第一个有效出口：{String(display(ips[0]))}</p>
              )}
              <div className="choice-grid">
                {[
                  ["ipapi", "ipapi.is", "地理、ASN；风险字段需要 key"],
                  ["ipwho", "ipwho.is", "地理、ASN / 运营商"],
                  ["abuse", "AbuseIPDB", "举报置信分，需要自备 key"],
                  ["shodan", "Shodan InternetDB", "历史端口与漏洞；非商业条款"],
                ].map(([id, name, desc]) => (
                  <label key={id}>
                    <Switch
                      checked={profileIds.includes(id)}
                      onCheckedChange={() => toggle(profileIds, id, setProfileIds)}
                      disabled={!!busy}
                    />
                    <span>
                      <strong>{name}</strong>
                      <small>{desc}</small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="table-note">
                所选服务会收到查询 IP；请求由本机服务发出。密钥仅从本机 .env 读取。
              </p>
            </section>
            {profiles.length
              ? profiles.map((x: Data, i: number) => (
                  <section className="tool-panel profile-panel" key={i}>
                    <div className="panel-heading">
                      <h2>{x.source}</h2>
                      <Pill state={x.state} />
                    </div>
                    {x.message ? (
                      <p>{x.message}</p>
                    ) : (
                      <>
                        <dl className="facts">
                          {[
                            ["IP", display(x.ip)],
                            ["国家 / 地区", x.country],
                            ["城市", x.city],
                            ["ASN", x.asn],
                            ["运营商 / 组织", x.organization],
                            ["类型（源数据）", x.type],
                            ["经纬度", x.latitude != null ? `${x.latitude}, ${x.longitude}` : null],
                            ["来源评分", x.sourceRisk],
                          ].map(([label, value], j) => (
                            <div key={j}>
                              <dt>{String(label)}</dt>
                              <dd>
                                {value === null || value === undefined ? "未提供" : String(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        <div className="flag-list">
                          {Object.entries(x.flags ?? {}).map(([name, value]) => (
                            <span key={name}>
                              {name.replace("is_", "")}{" "}
                              <b>
                                {value === true ? "已标记" : value === false ? "未标记" : "未知"}
                              </b>
                            </span>
                          ))}
                        </div>
                        {x.ports && (
                          <p>
                            历史端口：
                            {x.ports.length ? x.ports.join("、") : "未收录"}
                          </p>
                        )}
                        {x.vulnerabilities && (
                          <p>
                            历史漏洞标识：
                            {x.vulnerabilities.length ? x.vulnerabilities.join("、") : "未收录"}
                          </p>
                        )}
                        <p className="table-note">{x.note}</p>
                        <details>
                          <summary>查看数据源响应</summary>
                          {raw(x.raw)}
                        </details>
                      </>
                    )}
                  </section>
                ))
              : output("quality")}
            {evidence(
              "缺失字段保持未知。“未标记”不是安全证明。住宅、机房、原生、人机流量等属性只在数据源明确提供时展示；不根据 ASN 名字猜测。",
            )}
          </Pane>
          <Pane id="connect">
            <section className="tool-panel">
              <h2>浏览器 HTTP 连通观察</h2>
              <p className="lede">每个目的地请求 3 次，记录成功获得响应的次数与耗时中位数。</p>
              <div className="choice-grid">
                {config?.connectionSources.map((e) => (
                  <label key={e.id}>
                    <Switch
                      checked={linkIds.includes(e.id)}
                      disabled={!!busy}
                      onCheckedChange={() => toggle(linkIds, e.id, setLinkIds)}
                    />
                    <span>
                      <strong>{e.name}</strong>
                      <small>{new URL(e.url).host}</small>
                    </span>
                  </label>
                ))}
              </div>
              {command("检测所选网站", "connect", () => void runLinks())}
              {linkRows()}
            </section>
            {evidence(
              "跨站不透明响应可能是 403、404 或登录挑战，浏览器不能读取它的 HTTP 状态。这里展示响应计时，不把它叫作“平台正常”。",
            )}
          </Pane>
          <Pane id="dns">
            <div className="ai-grid">
              <section className="tool-panel">
                <h2>权威 DNS 解析器观察</h2>
                <p className="lede">
                  使用你自己部署的 DNS 采集端，通过随机域名观察递归解析器的出口。
                </p>
                <div className="connection-label">
                  {config?.configured.dns
                    ? `采集端：${config.dnsCollector}`
                    : "未配置采集端 · 源码包内附完整 DNS 服务"}
                </div>
                <div className="action-row">
                  {command(
                    "快速测试 · 3 次",
                    "dns",
                    () => void perform("dns", (s) => runDns(3, s)),
                  )}
                  {command(
                    "深度测试 · 10 次",
                    "dns",
                    () => void perform("dns", (s) => runDns(10, s)),
                  )}
                </div>
                {output("dns")}
                <div className="action-row">
                  {command(
                    "查询解析器归属地",
                    "dnsGeo",
                    () =>
                      void perform("dnsGeo", (s) =>
                        geoLookup(
                          (data.dns?.observations ?? []).map((x: Data) => x.resolverIp),
                          s,
                        ),
                      ),
                  )}
                </div>
                <p className="table-note">此操作把观察到的解析器 IP 发给 ipwho.is。</p>
                {geoRows("dnsGeo")}
                {data.dnsSession && (
                  <button
                    className="quiet-button"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("dnsDelete", (s) =>
                        api(config!, "/api/dns/delete", { id: data.dnsSession }, s),
                      )
                    }
                  >
                    清除本次采集端会话
                  </button>
                )}
              </section>
              <aside className="tool-panel">
                <h3>为什么需要一个域名？</h3>
                <p className="lede">
                  只有接收实际 DNS 查询的权威服务，才能观察递归解析器的出口。单独读取系统 DNS
                  设置无法替代。
                </p>
                <p className="lede">
                  源码提供 UDP / TCP DNS 与带令牌的会话
                  API。需要一个委派给自己的测试子域，以及可访问的服务器。
                </p>
                <p className="table-note">
                  会话约 120 秒自动过期。数据保留政策由你部署的采集端决定。
                </p>
              </aside>
            </div>
            <section className="tool-panel">
              <h2>本机 DNS 与接口信息</h2>
              <div className="input-row">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="填写要通过系统解析的公网域名"
                  aria-label="系统 DNS 查询域名"
                />
                {command(
                  "读取并解析",
                  "systemDns",
                  () =>
                    void perform("systemDns", (s) => api(config!, "/api/system-dns", { query }, s)),
                )}
              </div>
              {output("systemDns")}
            </section>
            {evidence(
              "解析器与 HTTP 出口地区不同只是一条线索。要判断是否偏离预期，需要结合你的 DNS、DoH 与代理设置；无观测结果不能证明没有泄露。",
            )}
          </Pane>
          <Pane id="rtc">
            <section className="tool-panel">
              <h2>WebRTC / UDP 出口观察</h2>
              <p className="lede">
                分别向已配置的 STUN 服务器收集 ICE 候选，不请求摄像头或麦克风权限。
              </p>
              <div className="source-chips">
                {config?.stunServers.map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
              <p className="table-note">
                STUN 服务会看到该 UDP 路径的出口。已知 HTTP 出口 {ips.length} 个，
                {ips.length ? "将用于对比。" : "先运行 IP 与分流可增加对比依据。"}
              </p>
              {command(
                "开始 STUN 检测",
                "rtc",
                () => void perform("rtc", (s) => collectWebRTC(config!.stunServers, ips, s)),
              )}
              {output("rtc")}
              <div className="action-row">
                {command(
                  "查询候选地址归属地",
                  "rtcGeo",
                  () =>
                    void perform("rtcGeo", (s) =>
                      geoLookup(
                        (data.rtc?.candidates ?? []).map((x: Data) => x.address),
                        s,
                      ),
                    ),
                )}
              </div>
              <p className="table-note">
                此操作将公网候选 IP 发给 ipwho.is。私网与 mDNS 地址由本机校验并拒绝。
              </p>
              {geoRows("rtcGeo")}
            </section>
            {evidence(
              "mDNS 主机候选不是公网 IP。不同出口需要核对，不能自动认定为真实地址泄露；没有候选也不能自动认定安全。",
            )}
          </Pane>
          <Pane id="ping">
            <section className="tool-panel">
              <h2>选择观测位置</h2>
              <div className="input-row">
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="公网域名或 IP"
                  aria-label="Ping 目标"
                />
                <NativeSelect
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  aria-label="Ping 观测方式"
                >
                  <option value="local">本机 ICMP</option>
                  <option value="own">自建远程节点</option>
                  <option value="global">Globalping 公共节点</option>
                </NativeSelect>
                {mode === "global" && (
                  <NativeSelect
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                    aria-label="节点数量"
                  >
                    {[1, 5, 10, 20].map((n) => (
                      <option key={n} value={n}>
                        {n} 个节点
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {command("开始测量", "ping", () => void perform("ping", ping))}
              </div>
              {mode === "global" ? (
                evidence(
                  <span>
                    测量由 <SafeLink href="https://globalping.io">Globalping</SafeLink>{" "}
                    提供，目标和测量可能公开。最多请求 20 个节点，实际数量以提供方返回为准。
                  </span>,
                )
              ) : (
                <p className="table-note">
                  {mode === "own"
                    ? `已配置 ${config?.pingNodes.length ?? 0} 个自建节点。节点服务代码包含在源码包中。`
                    : "调用本机系统 ping 命令。不同操作系统可能只返回原始输出；容器需要系统 ping 与相应权限。"}
                </p>
              )}
              {data.ping?.results ? (
                <div className="results-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>观测节点</TableHead>
                        <TableHead>最小</TableHead>
                        <TableHead>平均</TableHead>
                        <TableHead>最大</TableHead>
                        <TableHead>状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.ping.results.map((x: Data, i: number) => (
                        <TableRow key={i}>
                          <TableCell>{x.observer}</TableCell>
                          <TableCell>{x.min ?? "—"} ms</TableCell>
                          <TableCell>{x.avg ?? "—"} ms</TableCell>
                          <TableCell>{x.max ?? "—"} ms</TableCell>
                          <TableCell>{x.state ?? "未知"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <details>
                    <summary>详细测量结果</summary>
                    {raw(data.ping)}
                  </details>
                </div>
              ) : (
                output("ping")
              )}
              {data.ping?.id && (
                <button
                  className="quiet-button"
                  disabled={!!busy || !external}
                  onClick={() =>
                    void perform("ping", (s) =>
                      api(config!, "/api/ping/result", { id: data.ping.id }, s),
                    )
                  }
                >
                  刷新这次测量
                </button>
              )}
            </section>
            {evidence(
              "全球节点测量反映“节点 → 目标”的路径，不是你的浏览器到目标的路径。ICMP 不响应也不等于 HTTPS 不可用。",
            )}
          </Pane>
          <Pane id="status">
            <section className="tool-panel">
              <div className="panel-heading">
                <div>
                  <h2>官方服务状态</h2>
                  <p className="lede">按需读取，故障优先排列。点击卡片查看近期事件。</p>
                </div>
                <NativeSelect
                  value={statusCategory}
                  onChange={(e) => setStatusCategory(e.target.value)}
                  aria-label="服务类别"
                >
                  {["全部", "AI", "云服务", "开发", "社区"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="action-row">
                {command(
                  "读取当前分类",
                  "status",
                  () =>
                    void perform("status", (s) =>
                      batch(
                        config!.statusSources.filter(
                          (x) => statusCategory === "全部" || x.category === statusCategory,
                        ),
                        (x) => api(config!, "/api/status", { id: x.id }, s),
                        4,
                      ),
                    ),
                )}
              </div>
              <p className="table-note">
                从本机服务访问所选平台的官方状态域名。接口变更或不支持时显示无法确认。
              </p>
            </section>
            <div className="status-grid">
              {[...(data.status ?? [])]
                .sort(
                  (a: Data, b: Data) =>
                    (a.state === "attention" ? -1 : 0) - (b.state === "attention" ? -1 : 0),
                )
                .filter((x: Data) => statusCategory === "全部" || x.category === statusCategory)
                .map((x: Data) => (
                  <details className="status-card" key={x.id}>
                    <summary>
                      <span>
                        <strong>{x.name}</strong>
                        <small>{x.category}</small>
                      </span>
                      <Pill state={x.state} />
                    </summary>
                    <p>{x.description || x.message}</p>
                    <SafeLink href={x.url}>官方状态页</SafeLink>
                    {x.incidents?.length ? (
                      x.incidents.map((incident: Data, i: number) => (
                        <article key={i}>
                          <h3>{incident.name}</h3>
                          <small>{incident.updatedAt}</small>
                          <p>{incident.body}</p>
                          <SafeLink href={incident.url}>查看事件</SafeLink>
                        </article>
                      ))
                    ) : (
                      <p className="table-note">本次没有返回近期事件；不代表所有组件都正常。</p>
                    )}
                  </details>
                ))}
            </div>
            {!data.status && output("status")}
          </Pane>
          <Pane id="whois">
            <section className="tool-panel">
              <h2>注册信息查询</h2>
              <div className="input-row">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="WHOIS 查询对象"
                  placeholder="域名、IPv4、IPv6 或 AS15169"
                />
                {command(
                  "自动查询",
                  "whois",
                  () =>
                    void perform("whois", async (s) => {
                      try {
                        return await api(config!, "/api/rdap", { query }, s);
                      } catch (e) {
                        if (s.aborted) throw e;
                        const result = await api(config!, "/api/whois", { query }, s);
                        return {
                          ...result,
                          fallbackReason: e instanceof Error ? e.message : "RDAP 不可读",
                        };
                      }
                    }),
                )}
                {command(
                  "RDAP 查询",
                  "whois",
                  () => void perform("whois", (s) => api(config!, "/api/rdap", { query }, s)),
                )}
                {command(
                  "WHOIS 查询",
                  "whois",
                  () => void perform("whois", (s) => api(config!, "/api/whois", { query }, s)),
                )}
              </div>
              <p className="table-note">
                RDAP 从 IANA 引导表选择注册机构；WHOIS 查询 IANA 后跟随一次注册机构指引（TCP
                43）。查询对象会发送给注册机构。
              </p>
              {output("whois")}
            </section>
            <section className="tool-panel">
              <div className="panel-heading">
                <h2>RDAP 支持的域名后缀</h2>
                {command(
                  "读取 IANA 清单",
                  "tlds",
                  () => void perform("tlds", (s) => api(config!, "/api/tlds", {}, s)),
                )}
              </div>
              <Input
                value={tldFilter}
                onChange={(e) => setTldFilter(e.target.value)}
                placeholder="搜索后缀，例如 com"
                aria-label="搜索域名后缀"
              />
              <div className="source-chips">
                {data.tlds
                  ?.filter((t: string) => t.includes(tldFilter.trim().toLowerCase()))
                  .map((t: string) => (
                    <span key={t}>.{t}</span>
                  ))}
              </div>
            </section>
          </Pane>
          <Pane id="device">
            <section className="tool-panel">
              <h2>浏览器可见的设备信息</h2>
              <p className="lede">仅在本机计算，不向服务器发送，不用于创建用户标识。</p>
              <label className="single-choice">
                <Switch checked={fingerprint} onCheckedChange={setFingerprint} disabled={!!busy} />
                本次同时计算 Canvas 指纹与 WebGL 渲染器
              </label>
              {command(
                "读取本地设备信息",
                "device",
                () => void perform("device", () => inspectDevice(fingerprint), false),
                false,
              )}
              {output("device")}
            </section>
            {evidence(
              "UA 与设备信息可能被简化或修改。指纹是当前渲染结果的摘要，不是可验证的身份或平台风控证据；默认关闭。",
            )}
          </Pane>
          <Pane id="history">
            <section className="tool-panel">
              <div className="panel-heading">
                <h2>本地脱敏快照</h2>
                <label className="single-choice">
                  <Switch checked={saveEnabled} onCheckedChange={setSaveEnabled} />
                  允许保存到当前浏览器
                </label>
              </div>
              <p className="lede">
                只在点击保存时写入，最多保留 50 条。共享电脑上的其他使用者可能访问浏览器存储。
              </p>
              <div className="action-row">
                <button
                  className="primary-button"
                  onClick={saveHistory}
                  disabled={!saveEnabled || !Object.keys(data).length || !!busy}
                >
                  保存当前脱敏快照
                </button>
                <button className="quiet-button" onClick={loadHistory}>
                  读取已有历史
                </button>
                <button
                  className="quiet-button"
                  onClick={() => {
                    try {
                      localStorage.removeItem(HISTORY_KEY);
                      setSaved([]);
                      setNotice("本地历史已清除。");
                    } catch {
                      setError("无法清除本地历史。");
                    }
                  }}
                >
                  清除全部历史
                </button>
                <button
                  className="quiet-button"
                  disabled={!saved.length}
                  onClick={() =>
                    downloadText("preflight-history.json", JSON.stringify(redact(saved), null, 2))
                  }
                >
                  导出脱敏历史
                </button>
              </div>
              {saved.map((item) => (
                <details className="history-row" key={item.id}>
                  <summary>{new Date(item.at).toLocaleString("zh-CN")}</summary>
                  {raw(item.data)}
                  <button
                    className="quiet-button"
                    onClick={() => {
                      try {
                        const next = saved.filter((x) => x.id !== item.id);
                        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
                        setSaved(next);
                      } catch {
                        setError("无法修改本地历史。");
                      }
                    }}
                  >
                    删除这一条
                  </button>
                </details>
              ))}
              {!saved.length && <p className="empty-result">尚未读取或保存历史。</p>}
            </section>
          </Pane>
          <Pane id="news">
            <section className="tool-panel">
              <h2>官方动态与自选订阅源</h2>
              <p className="lede">
                按需读取 RSS / Atom，只展示标题、日期和原文链接。不会复制参考网站文章。
              </p>
              <div className="action-row">
                {command(
                  "读取已配置资讯源",
                  "news",
                  () =>
                    void perform("news", async (s) =>
                      (
                        await batch(
                          config!.newsFeeds,
                          async (feed) => {
                            try {
                              return await api(config!, "/api/news", { id: feed.id }, s);
                            } catch (e) {
                              return [
                                {
                                  source: feed.name,
                                  error: e instanceof Error ? e.message : "无法读取",
                                },
                              ];
                            }
                          },
                          2,
                        )
                      ).flat(),
                    ),
                )}
                <SafeLink href="https://www.anthropic.com/news">Anthropic 官方资讯</SafeLink>
                <SafeLink href="https://openai.com/news/">OpenAI 官方资讯</SafeLink>
              </div>
              <div className="input-row">
                <Input
                  value={newsSearch}
                  onChange={(e) => {
                    setNewsSearch(e.target.value);
                    setNewsPage(1);
                  }}
                  aria-label="搜索资讯"
                  placeholder="搜索已读取的标题"
                />
                <NativeSelect
                  value={newsSource}
                  onChange={(e) => {
                    setNewsSource(e.target.value);
                    setNewsPage(1);
                  }}
                  aria-label="筛选资讯来源"
                >
                  <option>全部</option>
                  {config?.newsFeeds.map((x) => (
                    <option key={x.id}>{x.name}</option>
                  ))}
                </NativeSelect>
              </div>
            </section>
            {data.news
              ?.filter((x: Data) => x.error)
              .map((x: Data, i: number) => (
                <p className="error-banner" key={i}>
                  {x.source}：{x.error}
                </p>
              ))}
            <div className="news-list">
              {(data.news ?? [])
                .filter(
                  (x: Data) =>
                    x.title &&
                    (newsSource === "全部" || x.source === newsSource) &&
                    x.title.toLowerCase().includes(newsSearch.toLowerCase()),
                )
                .slice((newsPage - 1) * 10, newsPage * 10)
                .map((x: Data, i: number) => (
                  <article key={i}>
                    <small>
                      {x.source} · {x.date || "未提供日期"}
                    </small>
                    <h3>
                      <SafeLink href={x.url}>{x.title}</SafeLink>
                    </h3>
                  </article>
                ))}
            </div>
            <div className="pagination-row">
              <button
                className="quiet-button"
                disabled={newsPage === 1}
                onClick={() => setNewsPage((v) => v - 1)}
              >
                上一页
              </button>
              <span>第 {newsPage} 页</span>
              <button
                className="quiet-button"
                disabled={
                  (data.news ?? []).filter(
                    (x: Data) =>
                      x.title &&
                      (newsSource === "全部" || x.source === newsSource) &&
                      x.title.toLowerCase().includes(newsSearch.toLowerCase()),
                  ).length <=
                  newsPage * 10
                }
                onClick={() => setNewsPage((v) => v + 1)}
              >
                下一页
              </button>
            </div>
          </Pane>
          <Pane id="card">
            <div className="ai-grid">
              <section className="tool-panel">
                <h2>本地 IP 卡片</h2>
                <img
                  className="ip-card-preview"
                  alt="本地生成的 IP 信息卡片预览"
                  src={"data:image/svg+xml;charset=utf-8," + encodeURIComponent(makeCard())}
                />
                <div className="action-row">
                  <button
                    className="primary-button"
                    onClick={() => downloadText("ip-card.svg", makeCard(true), "image/svg+xml")}
                  >
                    <Download size={16} />
                    脱敏 SVG
                  </button>
                  <button
                    className="quiet-button"
                    onClick={() => void perform("png", pngCard, false)}
                  >
                    脱敏 PNG
                  </button>
                  <button
                    className="quiet-button"
                    onClick={() => {
                      setTheme(cardThemes[Math.floor(Math.random() * cardThemes.length)].id);
                      setPattern(cardPatterns[Math.floor(Math.random() * cardPatterns.length)].id);
                      setStamp(cardStamps[Math.floor(Math.random() * cardStamps.length)].id);
                    }}
                  >
                    随机组合
                  </button>
                </div>
                <p className="table-note">
                  22 种主题 × 64 种图案与印章组合。生成和下载均在本机，不包含访问者识别脚本。
                </p>
              </section>
              <aside className="tool-panel card-form">
                <label>
                  IP
                  <Input
                    value={ip}
                    onChange={(e) => setIp(e.target.value)}
                    placeholder={ips[0] ? String(display(ips[0])) : "手动填写，或先检测出口"}
                  />
                </label>
                <label>
                  标题
                  <Input
                    value={cardTitle}
                    onChange={(e) => setCardTitle(e.target.value.slice(0, 60))}
                  />
                </label>
                <label>
                  说明
                  <Input
                    value={cardDetail}
                    onChange={(e) => setCardDetail(e.target.value.slice(0, 120))}
                  />
                </label>
                <label>
                  主题
                  <NativeSelect value={theme} onChange={(e) => setTheme(e.target.value)}>
                    {cardThemes.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  背景图案
                  <NativeSelect value={pattern} onChange={(e) => setPattern(e.target.value)}>
                    {cardPatterns.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  印章
                  <NativeSelect value={stamp} onChange={(e) => setStamp(e.target.value)}>
                    {cardStamps.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              </aside>
            </div>
            <section className="tool-panel">
              <h3>分享代码（先保存图片到同一目录）</h3>
              {raw({
                Markdown: "![IP 卡片](./ip-card.svg)",
                HTML: '<img src="./ip-card.svg" width="480" alt="IP 卡片" />',
                BBCode: "[img]你的图片公开地址[/img]",
              })}
              <p className="table-note">
                这是静态图片。不会在其他人打开时获取他们的 IP；网站不对外部署也可生成与分享卡片。
              </p>
            </section>
          </Pane>
          <Pane id="privacy">
            <section className="tool-panel">
              <h2>首页自动体检，其他检测按操作运行</h2>
              <div className="privacy-facts">
                <p>
                  <CheckMark />
                  打开首页会自动查询公网出口、IP 画像和 Claude / ChatGPT
                  入口，用于生成体检报告；不包含统计、广告 SDK 或远程字体。
                </p>
                <p>
                  <CheckMark />
                  API 密钥从本机 .env 读取。浏览器只能知道是否已配置，不能读取密钥值。
                </p>
                <p>
                  <CheckMark />
                  普通结果保存在当前页面。指纹和历史保存默认关闭，导出时始终脱敏。
                </p>
              </div>
              <div className="action-row">
                <button
                  className="quiet-button"
                  disabled={!!busy}
                  onClick={() => {
                    setData({});
                    setSaved([]);
                    setIp("");
                    setQuery("");
                    setTarget("");
                    setFingerprint(false);
                    setExternal(false);
                    setNotice("当前页面中的检测结果与输入已清空。已保存历史需在历史页单独清除。");
                  }}
                >
                  清空本次会话
                </button>
                <button
                  className="quiet-button"
                  disabled={!Object.keys(data).length}
                  onClick={() =>
                    downloadText(
                      "preflight-report.json",
                      JSON.stringify(
                        {
                          version: "0.4.0",
                          exportedAt: new Date().toISOString(),
                          results: redact(data),
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  导出脱敏报告
                </button>
              </div>
            </section>
            <section className="tool-panel">
              <h2>外部请求清单</h2>
              <div className="results-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>功能</TableHead>
                      <TableHead>数据去向</TableHead>
                      <TableHead>接收的信息</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ["IP / 分流", "所选出口端点", "该 HTTP 路径的来源 IP、常规请求头"],
                      ["HTTP 连接", "所选目标网站", "来源 IP 与轻量请求"],
                      [
                        "后台 DNS 兼容",
                        "Cloudflare DoH（1.1.1.1）",
                        "auto 模式遇到 Fake-IP 时解析查询域名；doh 模式始终使用；system 模式禁用",
                      ],
                      [
                        "IP 画像",
                        "ipapi.is / ipwho.is / AbuseIPDB / Shodan",
                        "查询 IP、本机服务网络出口；所选数据源的 key",
                      ],
                      ["WebRTC", "配置的 STUN 节点", "UDP 来源 IP；不发送完整候选列表"],
                      ["DNS 观测", "自建采集端 / 递归解析器", "随机测试域名、解析器出口"],
                      ["全球 Ping", "Globalping 或自建节点", "测量目标；Globalping 测量可能公开"],
                      ["注册信息", "IANA / 对应注册机构", "域名、IP 或 ASN"],
                      ["状态 / 资讯", "所选官方接口 / 订阅源", "本机服务网络出口及普通请求"],
                    ].map((row) => (
                      <TableRow key={row[0]}>
                        {row.map((cell) => (
                          <TableCell key={cell}>{cell}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
            <section className="tool-panel">
              <h2>本机配置状态</h2>
              <dl className="facts">
                {Object.entries(config?.configured ?? {}).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v ? "已配置" : "未配置"}</dd>
                  </div>
                ))}
              </dl>
              <p className="lede">
                修改 config.local.json 可替换出口、STUN、状态、资讯与自建 Ping 节点；密钥放入
                .env，修改后重启本机服务。
              </p>
              <details>
                <summary>查看当前非敏感端点配置</summary>
                {config &&
                  raw({
                    exitSources: config.exitSources,
                    connectionSources: config.connectionSources,
                    stunServers: config.stunServers,
                    statusSources: config.statusSources,
                    newsFeeds: config.newsFeeds,
                    pingNodes: config.pingNodes,
                    dnsCollector: config.dnsCollector,
                    dnsTransport: config.dnsTransport,
                    backendCheckSources: config.backendCheckSources,
                  })}
              </details>
            </section>
          </Pane>
          <footer className="local-footer">
            <span>独立开源工具 · 不隶属于 Net.Coffee、OpenAI 或 Anthropic</span>
            <span>数据来源透明 · 检测结论可核对</span>
          </footer>
        </main>
      </Tabs>
    </div>
  );
}
function CheckMark() {
  return <span className="checkmark">✓</span>;
}
