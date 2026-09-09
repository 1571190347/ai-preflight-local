import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";

const launcherSource = fileURLToPath(new URL("../scripts/launcher.mjs", import.meta.url));
const fixture = `import http from 'node:http';
import fs from 'node:fs';
if (process.env.FAIL_START === '1') throw new Error('fixture startup failure');
if (process.env.TEST_LOG_SECRET) { const secret=process.env.TEST_LOG_SECRET; process.stderr.write(secret.slice(0,3)); setTimeout(()=>process.stderr.write(secret.slice(3)+'\\n'),10); }
if (process.env.TEST_LOG_MANY) for(let i=0;i<120;i++)console.log('x'.repeat(7000));
const server=http.createServer((req,res)=>{
 if(req.url==='/api/health') res.end(JSON.stringify({ok:true,data:{local:true,instanceId:process.env.PREFLIGHT_INSTANCE_ID}}));
 else if(req.url==='/fixture') res.end(JSON.stringify({bind:process.env.BIND_ADDRESS,config:process.env.CONFIG_FILE,custom:process.env.TEST_VALUE,nodeOptions:process.env.NODE_OPTIONS||null,pid:process.pid}));
 else res.end('fixture');
});
server.listen(Number(process.env.PORT),process.env.BIND_ADDRESS);
if(process.env.IGNORE_TERM!=='1') process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
else process.on('SIGTERM',()=>{});
`;
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function install(t, extra = "") {
  const root = await mkdtemp(join(tmpdir(), "preflight-launcher-"));
  for (const dir of ["app/scripts", "app/server", "config", "state"])
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  await copyFile(launcherSource, join(root, "app/scripts/launcher.mjs"));
  await writeFile(join(root, "app/server/index.mjs"), fixture);
  await writeFile(join(root, "config/config.local.json"), "{}\n");
  const port = await availablePort();
  await writeFile(
    join(root, "config/.env"),
    `PORT=${port}\nBIND_ADDRESS=0.0.0.0\nCONFIG_FILE=wrong.json\nTEST_VALUE="spaces work"\nNODE_OPTIONS=--does-not-exist\n${extra}`,
  );
  t.after(async () => {
    await run(root, ["stop"]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, port };
}
function run(root, args = ["start"], useEnv = false) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PREFLIGHT_NO_OPEN: "1" };
    delete env.NODE_OPTIONS;
    delete env.PORT;
    if (useEnv) env.PREFLIGHT_INSTALL_DIR = root;
    else delete env.PREFLIGHT_INSTALL_DIR;
    const child = spawn(
      process.execPath,
      [join(root, "app/scripts/launcher.mjs"), ...args, ...(useEnv ? [] : ["--install-dir", root])],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("launcher fixture timed out"));
    }, 25000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
function request(port, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers, method, agent: false },
      (res) => {
        let body = "";
        res.on("data", (data) => (body += data));
        res.on("end", () => resolve({ code: res.statusCode, body }));
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
function assertOK(result) {
  assert.equal(result.code, 0, result.stderr + result.stdout);
}
const getState = (root) => readFile(join(root, "state/session.json"), "utf8").then(JSON.parse);

test(
  "installed launcher starts detached, loads private configuration, authenticates control, and stops its own child",
  { timeout: 30000 },
  async (t) => {
    const { root, port } = await install(t, "TEST_LOG_SECRET=fixture-secret-never-print\n");
    assert.equal((await run(root, ["status"])).code, 1);
    const started = await run(root, ["start", "--no-open"], true);
    assertOK(started);
    assert.match(started.stdout, new RegExp("127\\.0\\.0\\.1:" + port));
    const state = await getState(root);
    const details = JSON.parse((await request(port, "/fixture")).body);
    assert.equal(details.bind, "127.0.0.1");
    assert.equal(details.config, join(root, "config/config.local.json"));
    assert.equal(details.custom, "spaces work");
    assert.equal(details.nodeOptions, null);
    assert.equal(details.pid, state.childPid);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(root, "state/session.json"))).mode & 0o777, 0o600);
    }
    assert.equal((await request(state.controlPort, "/stop", {}, "POST")).code, 403);
    assert.equal(
      (
        await request(state.controlPort, "/status", {
          "x-preflight-challenge": "a".repeat(32),
          "x-preflight-proof": "é".repeat(64),
        })
      ).code,
      403,
    );
    const challenge = "b".repeat(32),
      proof = createHmac("sha256", state.token).update(`POST\n/stop\n${challenge}`).digest("hex");
    assert.equal(
      (
        await request(
          state.controlPort,
          "/stop",
          {
            Origin: "https://example.invalid",
            "x-preflight-challenge": challenge,
            "x-preflight-proof": proof,
          },
          "POST",
        )
      ).code,
      403,
    );
    assertOK(await run(root, ["status"]));
    assertOK(await run(root, ["open", "--no-open"]));
    assertOK(await run(root, ["start"]));
    assert.equal((await getState(root)).childPid, state.childPid);
    assertOK(await run(root, ["stop"]));
    assert.equal((await run(root, ["status"])).code, 1);
    assert.equal((await run(root, ["open", "--no-open"])).code, 1);
    await assert.rejects(request(port, "/api/health"));
    const log = await readFile(join(root, "state/launcher.log"), "utf8");
    assert.ok(!log.includes("fixture-secret-never-print"));
    assert.ok(!log.includes(state.token));
    assert.ok(!started.stdout.includes(state.token));
    assert.match(log, /\[redacted\]/);
  },
);

test(
  "occupied app port is reported without adopting or stopping the unrelated service",
  { timeout: 30000 },
  async (t) => {
    const { root, port } = await install(t);
    const unrelated = http.createServer((req, res) =>
      res.end(JSON.stringify({ ok: true, data: { local: true } })),
    );
    await new Promise((resolve) => unrelated.listen(port, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => unrelated.close(resolve)));
    const result = await run(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /端口.*已被占用/);
    assert.equal((await request(port, "/")).code, 200);
    assertOK(await run(root, ["stop"]));
  },
);

test(
  "stale state never authorizes signaling an unrelated PID or endpoint",
  { timeout: 30000 },
  async (t) => {
    const { root } = await install(t);
    const controlPort =
      49152 +
      (createHash("sha256")
        .update("ai-preflight-local-v1" + root)
        .digest()
        .readUInt16BE(0) %
        16384);
    await writeFile(
      join(root, "state/session.json"),
      JSON.stringify({
        format: 1,
        root,
        controlPort,
        port: 4173,
        token: "a".repeat(64),
        instanceId: "b".repeat(32),
        childPid: process.pid,
        supervisorPid: process.pid,
      }),
    );
    const stopped = await run(root, ["stop"]);
    assert.equal(stopped.code, 1);
    assert.match(stopped.stderr, /未停止任何进程/);
    process.kill(process.pid, 0);
    // A fresh supervisor can safely replace stale metadata after obtaining its OS lock.
    assertOK(await run(root));
    assert.notEqual((await getState(root)).childPid, process.pid);
    assertOK(await run(root, ["stop"]));
  },
);

test("two concurrent starts converge to one service", { timeout: 30000 }, async (t) => {
  const { root, port } = await install(t);
  const results = await Promise.all([run(root), run(root)]);
  for (const result of results) assertOK(result);
  const state = await getState(root);
  assert.equal(JSON.parse((await request(port, "/fixture")).body).pid, state.childPid);
  assertOK(await run(root, ["stop"]));
});

test(
  "startup failure exits promptly and leaves no authenticated service",
  { timeout: 30000 },
  async (t) => {
    const { root } = await install(t, "FAIL_START=1\n");
    const before = Date.now(),
      result = await run(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /启动失败/);
    assert.ok(Date.now() - before < 12000);
    assert.equal((await run(root, ["status"])).code, 1);
  },
);

test(
  "stop terminates only its owned child, escalating on Unix when graceful shutdown is ignored",
  { timeout: 30000 },
  async (t) => {
    const { root, port } = await install(t, "IGNORE_TERM=1\n");
    assertOK(await run(root));
    const before = Date.now();
    assertOK(await run(root, ["stop"]));
    // Windows implements child.kill('SIGTERM') as termination, so its child never
    // reaches a JavaScript signal handler. Unix must exercise the timed fallback.
    if (process.platform !== "win32") assert.ok(Date.now() - before >= 3500);
    assert.ok(Date.now() - before < 9000);
    await assert.rejects(request(port, "/"));
  },
);

test("logs rotate to one bounded private backup", { timeout: 30000 }, async (t) => {
  const { root } = await install(t, "TEST_LOG_MANY=1\n");
  assertOK(await run(root));
  assertOK(await run(root, ["stop"]));
  const logs = (await readdir(join(root, "state"))).filter((name) =>
    name.startsWith("launcher.log"),
  );
  assert.deepEqual(logs.sort(), ["launcher.log", "launcher.log.1"]);
  for (const file of logs) {
    const info = await stat(join(root, "state", file));
    assert.ok(info.size <= 256 * 1024);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  }
});

test("invalid PORT fails without spawning a service", { timeout: 30000 }, async (t) => {
  const { root } = await install(t, "PORT=999999\n");
  const result = await run(root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PORT 须为/);
  assert.equal((await run(root, ["status"])).code, 1);
});
