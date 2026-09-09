import { spawn } from "node:child_process";
import { target, resolvePublic, jsonRequest } from "./security.mjs";
const jobs = new Map();
export function parsePing(output) {
  const unix = output.match(/min\/avg\/max(?:\/[^\s=]+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  const windows = output.match(
    /(?:Minimum|最短|最小)\s*=\s*([\d.]+)\s*ms[\s\S]*?(?:Maximum|最长|最大)\s*=\s*([\d.]+)\s*ms[\s\S]*?(?:Average|平均)\s*=\s*([\d.]+)\s*ms/i,
  );
  const min = unix ? +unix[1] : windows ? +windows[1] : null,
    avg = unix ? +unix[2] : windows ? +windows[3] : null,
    max = unix ? +unix[3] : windows ? +windows[2] : null;
  const loss = output.match(/([\d.]+)%\s*(?:packet loss|loss|丢失|遺失)/i);
  return {
    state: min === null ? "unknown" : "received",
    min,
    avg,
    max,
    loss: loss ? +loss[1] : null,
  };
}
export async function localPing(query) {
  const q = target(query);
  const addresses = await resolvePublic(q.value);
  const address = addresses.find((a) => a.family === 4) ?? addresses[0];
  const command = process.platform === "darwin" && address.family === 6 ? "ping6" : "ping";
  const args =
    process.platform === "win32"
      ? ["-n", "3", "-w", "2000", address.address]
      : ["-n", "-c", "3", "-W", process.platform === "darwin" ? "2000" : "2", address.address];
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 12000);
    const collect = (d) => {
      output += d.toString();
      if (output.length > 20000) child.kill();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let settled = false;
    function done(extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        observer: "本机服务",
        target: q.value,
        address: address.address,
        ...parsePing(output),
        raw: output.slice(0, 20000),
        ...extra,
      });
    }
    child.on("error", () =>
      done({
        message: "系统 ping 命令不可用。可改用 Globalping 或安装系统网络工具。",
      }),
    );
    child.on("close", (code) => done({ exitCode: code }));
  });
}
export async function startGlobalPing(query, limit) {
  const q = target(query);
  await resolvePublic(q.value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("节点数量须为 1–20");
  const data = await jsonRequest("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.GLOBALPING_TOKEN
        ? { Authorization: "Bearer " + process.env.GLOBALPING_TOKEN }
        : {}),
    },
    body: JSON.stringify({
      type: "ping",
      target: q.value,
      limit,
      inProgressUpdates: true,
      measurementOptions: { packets: 3 },
    }),
  });
  if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id))
    throw new Error("Globalping 返回了无效测量 ID");
  for (const [id, job] of jobs) if (Date.now() - job.at > 600000) jobs.delete(id);
  if (jobs.size >= 100) jobs.delete(jobs.keys().next().value);
  jobs.set(data.id, { at: Date.now(), target: q.value });
  return {
    id: data.id,
    status: "in-progress",
    target: q.value,
    source: "Globalping",
    notice: "目标和测量可能公开；测量来源是远程节点，不是浏览器。",
  };
}
export async function globalPingResult(id) {
  if (typeof id !== "string" || !jobs.has(id) || Date.now() - jobs.get(id).at > 600000)
    throw new Error("测量不属于本次本地会话或已过期");
  const data = await jsonRequest(
    "https://api.globalping.io/v1/measurements/" + encodeURIComponent(id),
  );
  return {
    id,
    status: data.status,
    target: data.target,
    source: "Globalping",
    results: (Array.isArray(data.results) ? data.results : []).slice(0, 20).map((x) => ({
      observer: [x.probe?.city, x.probe?.country, x.probe?.network].filter(Boolean).join(" · "),
      state: x.result?.status ?? "unknown",
      address: x.result?.resolvedAddress ?? null,
      min: x.result?.stats?.min ?? null,
      avg: x.result?.stats?.avg ?? null,
      max: x.result?.stats?.max ?? null,
      loss: x.result?.stats?.loss ?? null,
      raw: x.result?.rawOutput ?? "",
    })),
  };
}
export async function ownPing(query, nodes) {
  const q = target(query);
  await resolvePublic(q.value);
  if (!nodes.length) throw new Error("尚未配置自建节点。请参考 services/ping-agent/README.md");
  return {
    status: "finished",
    source: "自建节点",
    target: q.value,
    results: await Promise.all(
      nodes.slice(0, 20).map(async (node) => {
        try {
          const token = node.tokenEnv && process.env[node.tokenEnv];
          if (!token) throw new Error("未配置节点访问令牌");
          const result = await jsonRequest(node.url.replace(/\/$/, "") + "/ping", {
            method: "POST",
            timeout: 15000,
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ target: q.value }),
          });
          return { ...result, observer: node.name };
        } catch (e) {
          return { observer: node.name, state: "unknown", message: e.message };
        }
      }),
    ),
  };
}
