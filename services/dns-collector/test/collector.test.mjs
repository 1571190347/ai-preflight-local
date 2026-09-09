import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { Readable } from 'node:stream';
import { SessionStore, RateLimiter } from '../src/sessions.mjs';
import { createDnsResponder, parseQuery, encodeName, readName, validateZone, qtypeName } from '../src/dns.mjs';
import { configFromEnv, createApiHandler, startCollector } from '../src/server.mjs';

const zone = 'probe.example.test';
const token = 'test_only_not_for_production_'.repeat(2);
const config = { zone, publicIpv4: '192.0.2.10', token, apiBind: '127.0.0.1', dnsBind: '127.0.0.1', apiPort: 0, dnsPort: 0, maxSessions: 10 };
const integration = { skip: process.env.DNS_COLLECTOR_INTEGRATION !== '1' };
async function mockRequest(handler, { method = 'GET', url = '/health', headers = {}, body = '', peer = '127.0.0.1' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: peer } });
  const response = { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, writeHead(status, headers = {}) { this.status = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); }, end(data) { this.body = data ? JSON.parse(data) : null; } };
  await handler(req, response);
  return response;
}
function query(name, type = 1, { id = 42, flags = 0x0100, qclass = 1 } = {}) {
  const header = Buffer.alloc(12); header.writeUInt16BE(id); header.writeUInt16BE(flags, 2); header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4); question.writeUInt16BE(type); question.writeUInt16BE(qclass, 2);
  return Buffer.concat([header, encodeName(name), question]);
}
function records(packet) {
  let offset = readName(packet, 12).end + 4;
  const output = [];
  for (let i = 0; i < packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10); i++) {
    const { name, end } = readName(packet, offset);
    const size = packet.readUInt16BE(end + 8);
    output.push({ name, type: packet.readUInt16BE(end), ttl: packet.readUInt32BE(end + 4), data: packet.subarray(end + 10, end + 10 + size) });
    offset = end + 10 + size;
  }
  assert.equal(offset, packet.length);
  return output;
}
function udpQuery(port, packet) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const timer = setTimeout(() => { client.close(); reject(new Error('UDP timeout')); }, 2000);
    client.on('error', (error) => { clearTimeout(timer); client.close(); reject(error); });
    client.on('message', (message) => { clearTimeout(timer); client.close(); resolve(message); });
    client.send(packet, port, '127.0.0.1');
  });
}
function tcpQuery(port, packet) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1');
    let pending = Buffer.alloc(0);
    client.setTimeout(2000, () => client.destroy(new Error('TCP timeout')));
    client.on('error', reject);
    client.on('connect', () => {
      const prefix = Buffer.alloc(2); prefix.writeUInt16BE(packet.length);
      // Exercise a split length prefix as well as normal DNS framing.
      client.write(prefix.subarray(0, 1));
      client.write(Buffer.concat([prefix.subarray(1), packet]));
    });
    client.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        client.destroy(); resolve(pending.subarray(2));
      }
    });
  });
}

test('sessions expire after exactly 120 seconds and erase hostname references', () => {
  let now = 1_000;
  const store = new SessionStore({ zone, now: () => now });
  const session = store.create(3);
  assert.equal(session.hostnames.length, 3);
  assert.equal(new Set(session.hostnames).size, 3);
  assert.match(session.id, /^[a-f0-9]{32}$/);
  for (const hostname of session.hostnames) assert.match(hostname, /^[a-f0-9]{24}-[a-f0-9]{32}\.probe\.example\.test$/);
  assert.equal(Date.parse(session.expiresAt), now + 120_000);
  now += 119_999; assert.ok(store.get(session.id));
  now += 1; assert.equal(store.get(session.id), null);
  assert.equal(store.hosts.size, 0); assert.equal(store.sessions.size, 0);
});

test('observations accept only exact issued live names and deduplicate resolver/type', () => {
  const store = new SessionStore({ zone }); const session = store.create(10);
  assert.equal(store.observe(`invented.${zone}`, '203.0.113.1', 'A'), false);
  assert.equal(store.observe(`prefix.${session.hostnames[0]}`, '203.0.113.1', 'A'), false);
  store.observe(session.hostnames[0], '203.0.113.1', 'A');
  store.observe(session.hostnames[1], '203.0.113.1', 'A');
  store.observe(session.hostnames[2], '203.0.113.1', 'AAAA');
  assert.equal(store.get(session.id).observations.length, 2);
  const copy = store.get(session.id); copy.observations[0].resolverIp = 'modified';
  assert.equal(store.get(session.id).observations[0].resolverIp, '203.0.113.1');
  assert.equal(store.delete(session.id), true);
  assert.equal(store.observe(session.hostnames[0], '203.0.113.1', 'A'), false);
  assert.equal(store.delete(session.id), false);
});

test('session and observation capacity stay bounded; expiry frees capacity', () => {
  let now = 0; const store = new SessionStore({ zone, maxSessions: 1, maxObservations: 2, now: () => now });
  const session = store.create(3); assert.equal(store.create(10), null);
  for (let i = 1; i < 20; i++) store.observe(session.hostnames[0], `203.0.113.${i}`, 'A');
  assert.equal(store.get(session.id).observations.length, 2);
  now = 120_000; assert.ok(store.create(3)); assert.equal(store.sessions.size, 1); assert.equal(store.hosts.size, 3);
  assert.throws(() => store.create(4), /count/);
});

test('rate limiter expires fixed windows and cannot grow beyond maxKeys', () => {
  let now = 0; const limiter = new RateLimiter({ limit: 2, maxKeys: 1, windowMs: 50, now: () => now });
  assert.equal(limiter.allow('a'), true); assert.equal(limiter.allow('a'), true); assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), false); assert.equal(limiter.buckets.size, 1);
  now = 50; assert.equal(limiter.allow('b'), true); assert.equal(limiter.buckets.size, 1);
});

test('DNS authority returns zero-cache NXDOMAIN and records the socket peer', () => {
  const store = new SessionStore({ zone }); const session = store.create(3);
  const respond = createDnsResponder({ zone, publicIpv4: '192.0.2.10', store });
  const response = respond(query(session.hostnames[0].toUpperCase(), 28), '::ffff:203.0.113.5');
  assert.equal(response.readUInt16BE(0), 42);
  assert.equal(response.readUInt16BE(2) & 0x000f, 3);
  assert.equal(response.readUInt16BE(2) & 0x0480, 0x0400); // AA, no RA.
  assert.equal(response.readUInt16BE(6), 0);
  const [soa] = records(response); assert.equal(soa.type, 6); assert.equal(soa.ttl, 0); assert.equal(soa.data.readUInt32BE(soa.data.length - 4), 0);
  assert.deepEqual(store.get(session.id).observations.map(({ resolverIp, qtype }) => ({ resolverIp, qtype })), [{ resolverIp: '203.0.113.5', qtype: 'AAAA' }]);
});

test('zone NS/SOA and ns1 A work, existing names return NODATA for unsupported types', () => {
  const store = new SessionStore({ zone }); const respond = createDnsResponder({ zone, publicIpv4: '192.0.2.10', store });
  const ns = respond(query(zone, 2), '203.0.113.5');
  assert.equal(ns.readUInt16BE(6), 1); assert.equal(ns.readUInt16BE(10), 1); assert.deepEqual(records(ns).map((r) => r.type), [2, 1]);
  assert.deepEqual(records(respond(query(`ns1.${zone}`, 1), '203.0.113.5'))[0].data, Buffer.from([192, 0, 2, 10]));
  assert.equal(records(respond(query(zone, 6), '203.0.113.5'))[0].type, 6);
  const nodata = respond(query(zone, 1), '203.0.113.5'); assert.equal(nodata.readUInt16BE(2) & 15, 0); assert.equal(nodata.readUInt16BE(6), 0); assert.equal(nodata.readUInt16BE(8), 1);
});

test('outside-zone, suffix-confused and non-IN questions are refused without recursion', () => {
  const store = new SessionStore({ zone }); const respond = createDnsResponder({ zone, publicIpv4: '192.0.2.10', store });
  for (const packet of [query('example.org'), query(`evil${zone}`), query(zone, 1, { qclass: 3 })]) {
    const response = respond(packet, '203.0.113.5'); assert.equal(response.readUInt16BE(2) & 15, 5); assert.equal(response.readUInt16BE(2) & 0x0480, 0); assert.equal(records(response).length, 0);
  }
});

test('malformed DNS packets, invalid compression and multiple questions are dropped', () => {
  const valid = query(zone); const multiple = Buffer.from(valid); multiple.writeUInt16BE(2, 4);
  const pointer = Buffer.concat([valid.subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
  const forward = Buffer.concat([valid.subarray(0, 12), Buffer.from([0xc0, 0x0e, 0, 1, 0, 1])]);
  const truncated = valid.subarray(0, valid.length - 1);
  const store = new SessionStore({ zone }); const respond = createDnsResponder({ zone, publicIpv4: '192.0.2.10', store });
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(5000), multiple, pointer, forward, truncated, Buffer.concat([valid, Buffer.from([0])]), query(zone, 1, { flags: 0x8000 }), query(zone, 1, { flags: 0x0200 })]) {
    assert.equal(respond(invalid, '203.0.113.5'), null);
  }
});

test('EDNS is parsed safely and client-subnet bytes never replace observed peer', () => {
  const store = new SessionStore({ zone }); const session = store.create(3); const packet = query(session.hostnames[0]); packet.writeUInt16BE(1, 10);
  const opt = Buffer.from([0, 0, 41, 4, 208, 0, 0, 0, 0, 0, 12, 0, 8, 0, 8, 0, 1, 32, 0, 198, 51, 100, 44]);
  const withEdns = Buffer.concat([packet, opt]); assert.equal(parseQuery(withEdns).name, session.hostnames[0]);
  const respond = createDnsResponder({ zone, publicIpv4: '192.0.2.10', store }); respond(withEdns, '203.0.113.8');
  assert.equal(store.get(session.id).observations[0].resolverIp, '203.0.113.8');
  const invalid = Buffer.from(withEdns); invalid[packet.length + 6] = 1; assert.throws(() => parseQuery(invalid), /version/);
});

test('configuration validates token, zone, ports and addresses', () => {
  const env = { DNS_ZONE: 'Probe.Example.test.', PUBLIC_IPV4: '192.0.2.10', DNS_COLLECTOR_TOKEN: token };
  assert.equal(configFromEnv(env).zone, zone); assert.equal(configFromEnv(env).apiBind, '127.0.0.1');
  for (const patch of [{ DNS_ZONE: '-bad.example' }, { DNS_ZONE: 'localhost' }, { PUBLIC_IPV4: 'bad' }, { DNS_COLLECTOR_TOKEN: 'short' }, { API_PORT: '0' }, { DNS_PORT: '65536' }, { API_BIND: 'localhost' }]) assert.throws(() => configFromEnv({ ...env, ...patch }));
  assert.equal(validateZone('probe.example.test.'), zone); assert.equal(qtypeName(65280), 'TYPE65280');
});

test('mock HTTP API enforces auth and exposes the exact session lifecycle', async () => {
  const store = new SessionStore({ zone }); const handler = createApiHandler({ store, token });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await mockRequest(handler)).status, 401);
  assert.equal((await mockRequest(handler, { headers: { ...headers, authorization: `Bearer ${token.slice(1)}x` } })).status, 401);
  assert.equal((await mockRequest(handler, { headers: { ...headers, origin: 'https://untrusted.test' } })).status, 403);
  const health = await mockRequest(handler, { headers }); assert.equal(health.status, 200); assert.deepEqual(health.body, { ok: true });
  assert.equal(health.headers['cache-control'], 'no-store'); assert.equal(health.headers['access-control-allow-origin'], undefined);
  const created = await mockRequest(handler, { headers, method: 'POST', url: '/sessions', body: '{"count":3}' });
  assert.equal(created.status, 201); assert.deepEqual(Object.keys(created.body).sort(), ['expiresAt', 'hostnames', 'id']);
  const { id, hostnames } = created.body; store.observe(hostnames[0], '203.0.113.4', 'A');
  const result = await mockRequest(handler, { headers, url: `/sessions/${id}` }); assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'id', 'observations']); assert.deepEqual(Object.keys(result.body.observations[0]).sort(), ['qtype', 'resolverIp', 'seenAt']);
  assert.equal((await mockRequest(handler, { headers, method: 'DELETE', url: `/sessions/${id}` })).status, 204);
  assert.equal((await mockRequest(handler, { headers, url: `/sessions/${id}` })).status, 404);
  assert.equal((await mockRequest(handler, { headers, url: '/unknown' })).status, 404);
});

test('mock HTTP rejects invalid, large and unknown fields and enforces capacity/rate limits', async () => {
  const store = new SessionStore({ zone, maxSessions: 1 }); const handler = createApiHandler({ store, token });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  for (const body of ['invalid', 'null', '[]', '{"count":4}', '{"count":3,"extra":true}', ' '.repeat(1025)]) {
    assert.equal((await mockRequest(handler, { headers, method: 'POST', url: '/sessions', body })).status, 400);
  }
  assert.equal((await mockRequest(handler, { headers: { authorization: `Bearer ${token}` }, method: 'POST', url: '/sessions', body: '{"count":3}' })).status, 400);
  assert.equal((await mockRequest(handler, { headers, method: 'POST', url: '/sessions', body: '{"count":10}' })).status, 201);
  assert.equal((await mockRequest(handler, { headers, method: 'POST', url: '/sessions', body: '{"count":3}' })).status, 503);
  const limited = createApiHandler({ store, token, limiter: new RateLimiter({ limit: 1 }) });
  assert.equal((await mockRequest(limited, { headers })).status, 200); assert.equal((await mockRequest(limited, { headers })).status, 429);
});

test('HTTP + real high-port UDP/TCP integration: auth, creation, observations, deletion', integration, async (t) => {
  const collector = await startCollector(config); t.after(() => collector.close());
  const base = `http://127.0.0.1:${collector.apiPort}`;
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { ...auth, Origin: 'https://untrusted.example' } })).status, 403);
  const health = await fetch(`${base}/health`, { headers: auth }); assert.equal(health.status, 200); assert.equal(health.headers.get('access-control-allow-origin'), null);
  for (const body of [{ count: 4 }, { count: 3, unexpected: true }, null]) {
    assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  const created = await fetch(`${base}/sessions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"count":3}' });
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
  const session = await created.json(); assert.equal(session.hostnames.length, 3);
  assert.equal((await udpQuery(collector.dnsPort, query(session.hostnames[0]))).readUInt16BE(2) & 15, 3);
  assert.equal((await tcpQuery(collector.dnsPort, query(session.hostnames[1], 28))).readUInt16BE(2) & 15, 3);
  const result = await (await fetch(`${base}/sessions/${session.id}`, { headers: auth })).json();
  assert.deepEqual(result.observations.map(({ resolverIp, qtype }) => ({ resolverIp, qtype })), [{ resolverIp: '127.0.0.1', qtype: 'A' }, { resolverIp: '127.0.0.1', qtype: 'AAAA' }]);
  assert.equal((await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE', headers: auth })).status, 204);
  assert.equal((await fetch(`${base}/sessions/${session.id}`, { headers: auth })).status, 404);
  assert.equal(collector.store.hosts.size, 0);
});

test('long zone responses truncate UDP safely and remain complete over TCP', integration, async (t) => {
  const longZone = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(55)}`;
  const collector = await startCollector({ ...config, zone: longZone }); t.after(() => collector.close());
  const udp = await udpQuery(collector.dnsPort, query(longZone, 2)); assert.ok(udp.length <= 512); assert.ok(udp.readUInt16BE(2) & 0x0200); assert.equal(udp.readUInt16BE(6), 0);
  const tcp = await tcpQuery(collector.dnsPort, query(longZone, 2)); assert.ok(tcp.length > 512); assert.equal(tcp.readUInt16BE(2) & 0x0200, 0); assert.deepEqual(records(tcp).map((r) => r.type), [2, 1]);
});
