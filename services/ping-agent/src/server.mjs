import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runPing, validateTarget } from './ping.mjs';

export function readConfig(env = process.env) {
  const token = env.PING_AGENT_TOKEN ?? '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || token.startsWith('replace_with_')) throw new Error('PING_AGENT_TOKEN 必须替换为 32–256 位随机字母、数字、下划线或连字符');
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
    return value;
  };
  const bind = env.PING_AGENT_BIND ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(bind)) throw new Error('PING_AGENT_BIND 配置无效');
  return { token, bind, port: number('PING_AGENT_PORT', 8060, 1024, 65535),
    concurrency: number('PING_AGENT_CONCURRENCY', 2, 1, 4),
    perMinute: number('PING_AGENT_PER_MINUTE', 6, 1, 60) };
}

export function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function respond(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Connection': 'close' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (Number(req.headers['content-length'] ?? 0) > 1024) throw new Error('请求体过大');
  let bytes = 0, body = '';
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024) throw new Error('请求体过大');
    body += chunk.toString('utf8');
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('请求必须是 JSON'); }
  if (!data || Array.isArray(data) || Object.keys(data).some(key => key !== 'target')) throw new Error('仅接受 target 字段');
  return validateTarget(data.target);
}

export function createHandler(config, { ping = runPing, now = Date.now } = {}) {
  let active = 0, requests = [];
  return async (req, res) => {
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      return respond(res, 403, { error: '仅接受服务端请求' });
    }
    if (!authorized(req.headers.authorization, config.token)) return respond(res, 401, { error: '认证失败' });
    if (req.method === 'GET' && req.url === '/health') return respond(res, 200, { service: 'ai-preflight-ping-agent', version: 1 });
    if (req.method !== 'POST' || req.url !== '/ping') return respond(res, 404, { error: '接口不存在' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { error: '需要 application/json' });
    requests = requests.filter(at => now() - at < 60000);
    if (active >= config.concurrency || requests.length >= config.perMinute) return respond(res, 429, { error: '节点繁忙，请稍后重试' });
    requests.push(now()); active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('aborted', abort);
    res.on('close', abort);
    try {
      const target = await readBody(req);
      const result = await ping(target, { signal: controller.signal });
      if (!res.destroyed) respond(res, 200, result);
    } catch (error) {
      if (!res.destroyed) respond(res, 400, { error: error.message === '系统 ping 命令不可用' ? error.message : '检测未完成；请检查公网目标、DNS 与 ICMP 条件' });
    } finally {
      active--; req.removeListener('aborted', abort); res.removeListener('close', abort);
    }
  };
}

export function start(env = process.env) {
  const config = readConfig(env);
  const server = http.createServer({ maxHeaderSize: 8192 }, createHandler(config));
  server.requestTimeout = 15000; server.headersTimeout = 5000; server.maxRequestsPerSocket = 10;
  server.listen(config.port, config.bind, () => console.log(`Ping agent listening on ${config.bind}:${config.port}`));
  server.on('error', () => { console.error('节点无法监听，请检查端口和权限'); process.exitCode = 1; });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
