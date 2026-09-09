import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { isPublicIp, validateTarget, resolveTarget, pingCommand, parsePing, runPing } from '../src/ping.mjs';
import { authorized, readConfig, createHandler } from '../src/server.mjs';

const token = 'a'.repeat(64);
const config = readConfig({ PING_AGENT_TOKEN: token });
function request(data = { target: 'example.com' }, headers = {}, method = 'POST', url = '/ping') {
  const req = Readable.from([JSON.stringify(data)]);
  req.method = method; req.url = url;
  req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers };
  return req;
}
class Response extends EventEmitter {
  destroyed = false;
  writeHead(code, headers) { this.status = code; this.headers = headers; }
  end(body) { this.body = JSON.parse(body); }
}
async function call(handler, req) { const res = new Response(); await handler(req, res); return res; }

test('rejects private, special, mapped and scoped addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '192.0.2.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:8.8.8.8',
    'fc00::1', 'fe80::1%en0', '2001:db8::1', '2002:0808:0808::1', '64:ff9b::0808:0808', '3fff::1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('input permits normalized domains and excludes command, URL and port syntax', () => {
  assert.equal(validateTarget(' Example.COM '), 'example.com');
  assert.equal(validateTarget('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
  for (const input of ['localhost', 'a.local', '-c 100 example.com', 'example.com;id',
    'example.com/path', 'example.com:443', 'example.com?x', 'example.com#x', 'user@example.com',
    'https://example.com', '8.8.8.8\n-c 99', 'a..com', '127.0.0.1']) {
    assert.throws(() => validateTarget(input), undefined, input);
  }
});

test('DNS refuses mixed public/private records and pins one resolved public IP', async () => {
  await assert.rejects(resolveTarget('example.com', async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ]), /非公网/);
  const result = await resolveTarget('example.com', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.deepEqual(result, { target: 'example.com', address: '8.8.8.8', family: 4 });
});

test('command takes only validated IPs with fixed packet count', () => {
  assert.deepEqual(pingCommand('8.8.8.8', 'linux'), { command: 'ping', args: ['-n', '-c', '3', '-W', '2', '8.8.8.8'] });
  assert.equal(pingCommand('2606:4700:4700::1111', 'darwin').command, 'ping6');
  assert.throws(() => pingCommand('example.com'));
  assert.throws(() => pingCommand('8.8.8.8;id'));
});

test('parses latency and preserves unknown when ICMP does not answer', () => {
  assert.deepEqual(parsePing('3 packets transmitted, 3 received, 0% packet loss\nrtt min/avg/max/mdev = 1.200/2.300/3.400/0.100 ms'),
    { state: 'received', min: 1.2, avg: 2.3, max: 3.4, loss: 0 });
  assert.deepEqual(parsePing('100% packet loss'), { state: 'unknown', min: null, avg: null, max: null, loss: 100 });
  assert.equal(parsePing('Minimum = 10ms, Maximum = 30ms, Average = 20ms').avg, 20);
});

test('ping spawns pinned address without shell or authorization secrets', async () => {
  let command;
  const result = await runPing('example.com', {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    spawnProcess: (binary, args, options) => {
      command = { binary, args, options };
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('min/avg/max/mdev = 1/2/3/0 ms')); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(command.args.at(-1), '8.8.8.8');
  assert.equal(command.options.shell, false);
  assert.equal(command.options.env.PING_AGENT_TOKEN, undefined);
  assert.equal(result.avg, 2);
});

test('token comparison fails safely for incorrect or multibyte headers', () => {
  assert.equal(authorized(`Bearer ${token}`, token), true);
  assert.equal(authorized(`Bearer ${'é'.repeat(64)}`, token), false);
  assert.equal(authorized(undefined, token), false);
  assert.throws(() => readConfig({ PING_AGENT_TOKEN: 'short' }));
  assert.throws(() => readConfig({ PING_AGENT_TOKEN: 'replace_with_your_own_random_token_before_start' }));
});

test('aborting a running probe terminates its child process', async () => {
  const controller = new AbortController();
  let killed = false;
  const promise = runPing('8.8.8.8', {
    signal: controller.signal,
    spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); };
      queueMicrotask(() => controller.abort());
      return child;
    },
  });
  await assert.rejects(promise, /取消/);
  assert.equal(killed, true);
});

test('rejects unauthenticated and browser requests before invoking ping', async () => {
  let calls = 0;
  const handler = createHandler(config, { ping: async () => { calls++; } });
  assert.equal((await call(handler, request({}, { authorization: 'bad' }))).status, 401);
  assert.equal((await call(handler, request({}, { origin: 'null' }))).status, 403);
  assert.equal((await call(handler, request({}, { 'sec-fetch-site': 'same-origin' }))).status, 403);
  assert.equal(calls, 0);
});

test('valid request matches main ownPing contract and no CORS headers are emitted', async () => {
  const handler = createHandler(config, { ping: async target => ({ target, state: 'received', min: 1, avg: 2, max: 3, loss: 0 }) });
  const res = await call(handler, request());
  assert.equal(res.status, 200); assert.equal(res.body.target, 'example.com');
  assert.equal(res.body.avg, 2); assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});

test('rate limit prevents additional probes until its window expires', async () => {
  let time = 0, calls = 0;
  const handler = createHandler({ ...config, perMinute: 1 }, { now: () => time, ping: async () => { calls++; return {}; } });
  assert.equal((await call(handler, request())).status, 200);
  assert.equal((await call(handler, request())).status, 429);
  time = 60001;
  assert.equal((await call(handler, request())).status, 200);
  assert.equal(calls, 2);
});

test('concurrency is bounded and freed after completion', async () => {
  let finish;
  const handler = createHandler({ ...config, concurrency: 1 }, { ping: () => new Promise(resolve => { finish = resolve; }) });
  const first = call(handler, request());
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(handler, request())).status, 429);
  finish({}); await first;
});

test('oversize and extra fields cannot invoke a probe; health is authenticated and local', async () => {
  let calls = 0;
  const handler = createHandler(config, { ping: async () => { calls++; return {}; } });
  assert.equal((await call(handler, request({ target: 'example.com', packets: 999 }))).status, 400);
  assert.equal((await call(handler, request({ target: 'x'.repeat(2048) }))).status, 400);
  const health = await call(handler, request({}, {}, 'GET', '/health'));
  assert.equal(health.status, 200); assert.equal(calls, 0);
});
