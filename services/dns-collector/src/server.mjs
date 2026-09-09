import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SessionStore, RateLimiter } from './sessions.mjs';
import { createDnsResponder, readName, validateZone } from './dns.mjs';

function envInteger(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

export function configFromEnv(env = process.env) {
  const zone = validateZone(env.DNS_ZONE);
  const publicIpv4 = env.PUBLIC_IPV4;
  if (net.isIP(publicIpv4 ?? '') !== 4) throw new Error('PUBLIC_IPV4 must be an IPv4 address');
  const token = env.DNS_COLLECTOR_TOKEN ?? '';
  if (token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('DNS_COLLECTOR_TOKEN must be 32–256 URL-safe random characters');
  const apiBind = env.API_BIND ?? '127.0.0.1';
  const dnsBind = env.DNS_BIND ?? '0.0.0.0';
  if (!net.isIP(apiBind) || !net.isIP(dnsBind)) throw new Error('API_BIND and DNS_BIND must be IP addresses');
  return {
    zone, publicIpv4, token, apiBind, dnsBind,
    dnsPort: envInteger(env, 'DNS_PORT', 53, 1, 65535),
    apiPort: envInteger(env, 'API_PORT', 8053, 1, 65535),
    maxSessions: envInteger(env, 'MAX_SESSIONS', 1000, 1, 10_000),
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('Expected application/json');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024) { req.resume(); throw new Error('Request body exceeds 1024 bytes'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApiHandler({ store, token, limiter = new RateLimiter({ limit: 120 }) }) {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (req, res) => {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.allow(peer)) return sendJson(res, 429, { error: 'Rate limit exceeded' });
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    // A remote web page cannot use a locally reachable API via browser requests.
    // This API is exclusively server-to-server and never emits CORS headers.
    if (req.headers.origin) return sendJson(res, 403, { error: 'Browser origins are not accepted' });
    const path = req.url;
    if (path === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
    if (path === '/sessions' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return sendJson(res, 400, { error: 'Expected JSON body with count 3 or 10 (maximum 1024 bytes)' }); }
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== 'count') || (body.count !== 3 && body.count !== 10)) {
        return sendJson(res, 400, { error: 'count must be 3 or 10; no other fields accepted' });
      }
      const session = store.create(body.count);
      return session ? sendJson(res, 201, session) : sendJson(res, 503, { error: 'Session capacity reached; retry after 120 seconds' });
    }
    const match = /^\/sessions\/([a-f0-9]{32})$/.exec(path ?? '');
    if (match && (req.method === 'GET' || req.method === 'DELETE')) {
      const session = store.get(match[1]);
      if (!session) return sendJson(res, 404, { error: 'Session missing or expired' });
      if (req.method === 'GET') return sendJson(res, 200, session);
      store.delete(match[1]);
      res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end();
    }
    return sendJson(res, 404, { error: 'Not found' });
  };
}

export async function startCollector(config) {
  const store = new SessionStore({ zone: config.zone, maxSessions: config.maxSessions });
  const respond = createDnsResponder({ zone: config.zone, publicIpv4: config.publicIpv4, store });
  const peerLimit = new RateLimiter({ limit: 600 });
  const globalLimit = new RateLimiter({ limit: 10_000, maxKeys: 1 });
  const allow = (peer) => globalLimit.allow('all') && peerLimit.allow(peer.replace(/^::ffff:/, ''));
  const udp = dgram.createSocket(net.isIP(config.dnsBind) === 6 ? 'udp6' : 'udp4');
  const sockets = new Set();
  const udpHandler = (packet, peer) => {
    if (!allow(peer.address)) return;
    let response = respond(packet, peer.address);
    if (!response) return;
    // Always honour the classic UDP payload limit; TCP returns the full answer.
    if (response.length > 512) {
      response = Buffer.from(response.subarray(0, readName(response, 12).end + 4));
      response.writeUInt16BE(response.readUInt16BE(2) | 0x0200, 2);
      response.fill(0, 6, 12);
    }
    udp.send(response, peer.port, peer.address, () => {});
  };
  udp.on('message', udpHandler);
  const tcp = net.createServer((socket) => {
    if (sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0), frames = 0;
    socket.on('data', (chunk) => {
      if (pending.length + chunk.length > 8192) { socket.destroy(); return; }
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const size = pending.readUInt16BE(0);
        if (size < 12 || size > 4096 || frames >= 32) { socket.destroy(); return; }
        if (pending.length < size + 2) return;
        const packet = pending.subarray(2, size + 2);
        pending = pending.subarray(size + 2);
        frames++;
        const peer = socket.remoteAddress ?? 'unknown';
        if (!allow(peer)) { socket.destroy(); return; }
        const response = respond(packet, peer);
        if (!response) { socket.destroy(); return; }
        const prefix = Buffer.alloc(2); prefix.writeUInt16BE(response.length);
        socket.write(Buffer.concat([prefix, response]));
        if (socket.writableLength > 65_536) { socket.destroy(); return; }
      }
    });
  });
  const api = http.createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, createApiHandler({ store, token: config.token }));
  api.maxConnections = 128;
  api.on('clientError', (_error, socket) => socket.destroy());
  const sweep = setInterval(() => store.sweep(), 5000);
  sweep.unref();
  const close = async () => {
    clearInterval(sweep);
    for (const socket of sockets) socket.destroy();
    api.closeAllConnections();
    await Promise.all([api, tcp].map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await new Promise((resolve) => { try { udp.close(resolve); } catch { resolve(); } });
    for (const id of store.sessions.keys()) store.delete(id);
  };
  try {
    // Port 0 is deliberately available to the exported start helper for tests;
    // normal CLI environment validation requires configured ports >= 1.
    await new Promise((resolve, reject) => {
      udp.once('error', reject); udp.bind(config.dnsPort, config.dnsBind, () => { udp.off('error', reject); resolve(); });
    });
    const dnsPort = udp.address().port;
    await new Promise((resolve, reject) => {
      tcp.once('error', reject); tcp.listen(dnsPort, config.dnsBind, () => { tcp.off('error', reject); resolve(); });
    });
    await new Promise((resolve, reject) => {
      api.once('error', reject); api.listen(config.apiPort, config.apiBind, () => { api.off('error', reject); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  // Report only static operational errors; packet names, IPs, tokens and session
  // records are never written to application logs.
  for (const server of [udp, tcp, api]) server.on('error', () => process.stderr.write('Collector network listener error\n'));
  return { store, apiPort: api.address().port, dnsPort: udp.address().port, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = configFromEnv();
    const collector = await startCollector(config);
    process.stdout.write(`DNS collector listening on DNS port ${collector.dnsPort}, API ${config.apiBind}:${collector.apiPort}\n`);
    let stopping = false;
    const shutdown = async () => { if (stopping) return; stopping = true; await collector.close(); process.exit(0); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
