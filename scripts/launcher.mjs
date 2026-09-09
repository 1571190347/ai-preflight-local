#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const script = fileURLToPath(import.meta.url);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
const HEALTH_TIMEOUT = 12000;
const LOG_LIMIT = 256 * 1024;
const prefix = "ai-preflight-local-v1";

function options(args) {
  let command = "start",
    root = process.env.PREFLIGHT_INSTALL_DIR,
    noOpen = process.env.PREFLIGHT_NO_OPEN === "1";
  if (args[0] && !args[0].startsWith("-")) command = args.shift();
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--no-open") noOpen = true;
    else if (args[at] === "--install-dir" && args[at + 1] && !args[at + 1].startsWith("--"))
      root = args[++at];
    else
      throw new Error(
        "用法：ai-preflight start|stop|status|open [--install-dir 绝对路径] [--no-open]",
      );
  }
  if (!["start", "stop", "status", "open", "__supervise"].includes(command))
    throw new Error("命令须为 start、stop、status 或 open");
  root ||=
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ai-preflight-local")
      : join(homedir(), ".local", "share", "ai-preflight-local");
  if (!isAbsolute(root)) throw new Error("安装目录须为绝对路径");
  root = resolve(root);
  // The OS owns this lock: a crashed supervisor releases its port automatically.
  // A collision with another application is an error; no PID from disk is signalled.
  const controlPort =
    49152 +
    (createHash("sha256")
      .update(prefix + root)
      .digest()
      .readUInt16BE(0) %
      16384);
  return {
    command,
    root,
    noOpen,
    controlPort,
    stateDir: join(root, "state"),
    stateFile: join(root, "state", "session.json"),
  };
}
function noSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("拒绝符号链接：" + path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function protectDirectory(path) {
  noSymlink(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function stateRead(opts) {
  noSymlink(opts.root);
  noSymlink(opts.stateDir);
  noSymlink(opts.stateFile);
  let raw;
  try {
    raw = readFileSync(opts.stateFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    if (Buffer.byteLength(raw) > 4096) throw new Error();
    const state = JSON.parse(raw);
    if (
      state.format !== 1 ||
      state.root !== opts.root ||
      state.controlPort !== opts.controlPort ||
      !/^[a-f0-9]{64}$/.test(state.token) ||
      !/^[a-f0-9]{32}$/.test(state.instanceId) ||
      !Number.isInteger(state.port) ||
      state.port < 1024 ||
      state.port > 65535 ||
      !Number.isInteger(state.childPid) ||
      state.childPid < 1
    )
      throw new Error();
    return state;
  } catch {
    throw new Error("运行状态文件无效；请检查 " + opts.stateFile);
  }
}
function stateWrite(opts, state) {
  noSymlink(opts.stateFile);
  const temporary = join(opts.stateDir, ".session-" + state.instanceId + ".tmp");
  writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, opts.stateFile);
  chmodSync(opts.stateFile, 0o600);
}
function stateRemove(opts, token) {
  try {
    if (stateRead(opts)?.token === token) unlinkSync(opts.stateFile);
  } catch {
    /* Never remove an unrecognized replacement. */
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function proof(token, text) {
  return createHmac("sha256", token).update(text).digest("hex");
}
function equal(a, b) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function request(port, path, { method = "GET", headers = {}, timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, result) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      }
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers, agent: false },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) req.destroy(new Error("本地服务响应过大"));
          else chunks.push(chunk);
        });
        res.on("end", () =>
          finish(null, {
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
        res.on("error", (error) => finish(error));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("本地服务响应超时")), timeout);
    req.on("error", (error) => finish(error));
    req.end();
  });
}
async function control(opts, state, action) {
  const method = action === "stop" ? "POST" : "GET",
    path = "/" + action;
  const challenge = randomBytes(16).toString("hex");
  const result = await request(opts.controlPort, path, {
    method,
    timeout: action === "stop" ? 9000 : 1500,
    headers: {
      "x-preflight-challenge": challenge,
      "x-preflight-proof": proof(state.token, `${method}\n${path}\n${challenge}`),
    },
  });
  if (
    result.status !== 200 ||
    !equal(result.headers["x-preflight-proof"], proof(state.token, `${challenge}\n${result.body}`))
  )
    throw new Error("无法验证本地启动器身份；没有停止任何进程");
  const data = JSON.parse(result.body);
  if (!data.ok || data.instanceId !== state.instanceId) throw new Error("本地启动器状态不匹配");
  return data;
}
function environment(opts) {
  noSymlink(opts.root);
  noSymlink(join(opts.root, "app"));
  noSymlink(join(opts.root, "config"));
  const envFile = join(opts.root, "config", ".env");
  noSymlink(envFile);
  let local = {};
  try {
    const text = readFileSync(envFile, "utf8");
    if (Buffer.byteLength(text) > 1048576) throw new Error("配置文件过大");
    local = parseEnv(text);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const env = {
    ...process.env,
    ...local,
    BIND_ADDRESS: "127.0.0.1",
    CONFIG_FILE: join(opts.root, "config", "config.local.json"),
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PORT 须为 1024–65535");
  if (port === opts.controlPort) throw new Error("PORT 与本地启动器控制端口冲突，请更换 PORT");
  env.PORT = String(port);
  if (!existsSync(join(opts.root, "app", "server", "index.mjs")))
    throw new Error("安装不完整：缺少 app/server/index.mjs，请重新运行安装器");
  return { env, port };
}
function logger(opts, secrets) {
  const file = join(opts.stateDir, "launcher.log"),
    backup = file + ".1";
  for (const path of [file, backup]) {
    noSymlink(path);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  return (value) => {
    let message = String(value);
    for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]");
    const line = `${new Date().toISOString()} ${message.slice(0, 8192)}\n`;
    noSymlink(file);
    noSymlink(backup);
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > LOG_LIMIT) {
      if (existsSync(backup)) unlinkSync(backup);
      renameSync(file, backup);
    }
    appendFileSync(file, line, { mode: 0o600 });
    chmodSync(file, 0o600);
  };
}
function capture(stream, log) {
  const decoder = new StringDecoder("utf8");
  let pending = "",
    dropped = false;
  const consume = (text) => {
    for (const part of text.split(/(\n)/)) {
      if (part === "\n") {
        log(dropped ? "[过长的日志行已省略]" : pending.replace(/\r$/, ""));
        pending = "";
        dropped = false;
      } else if (!dropped) {
        pending += part;
        if (pending.length > 65536) {
          pending = "";
          dropped = true;
        }
      }
    }
  };
  stream.on("data", (chunk) => consume(decoder.write(chunk)));
  stream.on("end", () => {
    consume(decoder.end());
    if (pending || dropped) log(dropped ? "[过长的日志行已省略]" : pending);
  });
}
async function freePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () =>
      reject(new Error(`端口 ${port} 已被占用；请停止占用服务或修改 config/.env 中的 PORT`)),
    );
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
async function health(port, instanceId) {
  try {
    const result = await request(port, "/api/health", { timeout: 700 });
    const data = JSON.parse(result.body);
    return (
      result.status === 200 &&
      data.ok === true &&
      data.data?.local === true &&
      data.data?.instanceId === instanceId
    );
  } catch {
    return false;
  }
}
async function supervise(opts) {
  const { env, port } = environment(opts);
  protectDirectory(opts.stateDir);
  const token = randomBytes(32).toString("hex"),
    instanceId = randomBytes(16).toString("hex");
  const log = logger(opts, [
    token,
    ...Object.entries(env)
      .filter(([key]) => /token|key|secret|password/i.test(key))
      .map(([, value]) => value),
  ]);
  let child,
    childEnded = false,
    ready = false,
    shuttingDown,
    exitResolve;
  const childExit = new Promise((resolve) => {
    exitResolve = resolve;
  });
  const server = http.createServer(async (req, res) => {
    const challenge = req.headers["x-preflight-challenge"];
    const accepted =
      ((req.method === "GET" && req.url === "/status") ||
        (req.method === "POST" && req.url === "/stop")) &&
      req.socket.remoteAddress === "127.0.0.1" &&
      req.headers.host === `127.0.0.1:${opts.controlPort}` &&
      !req.headers.origin &&
      typeof challenge === "string" &&
      /^[a-f0-9]{32}$/.test(challenge) &&
      equal(
        req.headers["x-preflight-proof"],
        proof(token, `${req.method}\n${req.url}\n${challenge}`),
      );
    if (!accepted) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url === "/stop") {
      try {
        await shutdown();
      } catch {
        res.writeHead(503);
        res.end("Unable to confirm child termination");
        return;
      }
    }
    const body = JSON.stringify({
      ok: true,
      instanceId,
      running: ready && !childEnded && !shuttingDown,
      port,
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Connection: "close",
      "x-preflight-proof": proof(token, `${challenge}\n${body}`),
    });
    if (req.url === "/stop") res.once("finish", () => server.close());
    res.end(body);
  });
  server.headersTimeout = 3000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  async function shutdown() {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      ready = false;
      if (child && !childEnded) {
        child.kill("SIGTERM");
        await Promise.race([childExit, delay(4000)]);
        if (!childEnded) child.kill("SIGKILL");
        await Promise.race([childExit, delay(2000)]);
        if (!childEnded) throw new Error("无法确认本地服务已经退出，保留运行状态");
      }
      stateRemove(opts, token);
      if (child) log("本地服务已停止");
    })();
    return shuttingDown;
  }
  function notify(value) {
    if (process.connected) process.send(value);
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: opts.controlPort, exclusive: true }, resolve);
    }).catch((error) => {
      if (error.code === "EADDRINUSE") {
        const collision = new Error("本地启动器控制端口已被占用；没有更改或停止其他进程");
        collision.code = "CONTROL_IN_USE";
        throw collision;
      }
      throw error;
    });
    await freePort(port);
    child = spawn(process.execPath, [join(opts.root, "app", "server", "index.mjs")], {
      cwd: join(opts.root, "app"),
      env: { ...env, PREFLIGHT_INSTANCE_ID: instanceId },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    capture(child.stdout, log);
    capture(child.stderr, log);
    child.once("error", () => {
      childEnded = true;
      exitResolve();
    });
    child.once("exit", (code, signal) => {
      childEnded = true;
      exitResolve();
      log(`应用退出：${signal || code}`);
      if (ready && !shuttingDown) {
        ready = false;
        stateRemove(opts, token);
        server.close();
      }
    });
    const state = {
      format: 1,
      root: opts.root,
      supervisorPid: process.pid,
      childPid: child.pid,
      controlPort: opts.controlPort,
      port,
      token,
      instanceId,
    };
    if (!child.pid) throw new Error("无法创建本地服务进程");
    stateWrite(opts, state);
    const until = Date.now() + HEALTH_TIMEOUT;
    while (!childEnded && Date.now() < until) {
      if ((await health(port, instanceId)) && !childEnded) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready)
      throw new Error(
        childEnded
          ? "本地服务启动失败，请查看 state/launcher.log"
          : "本地服务未在 12 秒内通过健康检查，请查看 state/launcher.log",
      );
    log(`本地服务已启动：http://127.0.0.1:${port}`);
    notify({ ready: true, port });
    if (process.connected) process.disconnect();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        shutdown()
          .then(() => server.close())
          .catch((error) => log(error.message));
      });
  } catch (error) {
    await shutdown();
    server.close();
    notify({ error: error.message, code: error.code });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
}
async function startSupervisor(opts) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(process.execPath, [script, "__supervise", "--install-dir", opts.root], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env,
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("启动器响应超时；请运行 status 检查状态"));
    }, HEALTH_TIMEOUT + 10000);
    child.once("error", (error) => finish(error));
    child.once("exit", () => finish(new Error("启动器未能启动；请检查安装目录与 config/.env")));
    child.on("message", (message) => {
      if (message.error) {
        const error = new Error(message.error);
        error.code = message.code;
        finish(error);
      } else if (message.ready) finish(null, message);
    });
  });
}
async function openBrowser(url, opts) {
  if (opts.noOpen) return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      console.error("无法自动打开浏览器，请访问：" + url);
      resolve();
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.command === "__supervise") {
    await supervise(opts);
    return;
  }
  let state = stateRead(opts),
    running = null,
    connectionError = null;
  if (state) {
    try {
      running = await control(opts, state, "status");
    } catch (error) {
      connectionError = error;
    }
  }
  if (opts.command === "stop") {
    if (running) {
      await control(opts, state, "stop");
      console.log("AI 体检站已停止。");
      return;
    }
    if (state && (connectionError?.code !== "ECONNREFUSED" || alive(state.childPid)))
      throw new Error(
        "无法验证运行实例，未停止任何进程。请检查 status 和 state/launcher.log；不要依靠旧 PID 停止进程",
      );
    console.log("AI 体检站未运行。");
    return;
  }
  if (opts.command === "status") {
    if (running?.running) console.log(`AI 体检站正在运行：http://127.0.0.1:${running.port}`);
    else {
      console.log(
        state &&
          connectionError &&
          (connectionError.code !== "ECONNREFUSED" || alive(state.childPid))
          ? "无法验证运行实例；未更改任何进程。"
          : "AI 体检站未运行。",
      );
      process.exitCode = 1;
    }
    return;
  }
  if (opts.command === "open") {
    if (!running?.running) throw new Error("AI 体检站未运行，请先执行 ai-preflight start");
  } else if (!running?.running) {
    environment(opts);
    try {
      running = await startSupervisor(opts);
    } catch (error) {
      // A simultaneous start may have won the OS lock while this command waited.
      const until = Date.now() + (error.code === "CONTROL_IN_USE" ? HEALTH_TIMEOUT : 0);
      do {
        const current = stateRead(opts);
        if (current) {
          try {
            const status = await control(opts, current, "status");
            if (status.running) {
              running = status;
              break;
            }
          } catch {
            /* Keep the actual startup failure. */
          }
        }
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < until);
      if (!running?.running && !running?.ready) throw error;
    }
  }
  const url = `http://127.0.0.1:${running.port}`;
  console.log(`AI 体检站正在运行：${url}`);
  await openBrowser(url, opts);
}
main().catch((error) => {
  console.error("AI 体检站：" + error.message);
  process.exitCode = 1;
});
