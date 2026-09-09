import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
test('local HTTP service serves assets and rejects cross-site / malformed requests without outbound calls', async (t) => {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const dir = await mkdtemp(join(tmpdir(), 'preflight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, 'guard.mjs');
  await writeFile(
    preload,
    "import https from 'node:https';https.request=()=>{process.stdout.write('UNEXPECTED_OUTBOUND');throw new Error('Unexpected outbound');};",
  );
  const env = {
    ...process.env,
    PORT: String(port),
    BIND_ADDRESS: '127.0.0.1',
    DEV_ORIGIN: '',
    CONFIG_FILE: join(dir, 'missing.json'),
    IPAPI_KEY: 'sample-secret-never-in-browser',
    ABUSEIPDB_KEY: '',
    DNS_COLLECTOR_URL: '',
    DNS_COLLECTOR_TOKEN: '',
    DNS_MODE: 'auto',
  };
  const child = spawn(
    process.execPath,
    ['--import', preload, 'server/index.mjs'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  child.stdout.on('data', (x) => (logs += x));
  child.stderr.on('data', (x) => (logs += x));
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', r);
      setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 1500).unref();
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let config;
  for (let i = 0; i < 100; i++) {
    try {
      config = await fetch(base + '/api/config');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  assert.ok(config, logs);
  const text = await config.text();
  assert.ok(!text.includes(env.IPAPI_KEY));
  const token = JSON.parse(text).data.apiToken;
  assert.equal(JSON.parse(text).data.dnsTransport.mode, 'auto');
  assert.equal(JSON.parse(text).data.backendCheckSources.length, 3);
  const headers = {
    'Content-Type': 'application/json',
    Origin: base,
    'X-Preflight-Token': token,
  };
  const post = (path, body, h = headers) =>
    fetch(base + path, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await fetch(base + '/api/config', {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      const req = request(
        base + '/api/config',
        { headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    }),
    403,
  );
  assert.equal(
    (
      await post(
        '/api/rdap',
        { query: 'example.com', consent: true },
        { ...headers, 'X-Preflight-Token': 'é'.repeat(48) },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        '/api/rdap',
        { query: 'example.com', consent: true },
        { ...headers, Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/api/rdap', { query: 'example.com', consent: false })).status,
    400,
  );
  assert.equal((await post('/api/backend-check', { consent: false })).status, 400);
  assert.equal((await fetch(base + '/api/backend-check')).status, 405);
  assert.equal(
    (
      await post('/api/ip-profile', {
        ip: '127.0.0.1',
        providers: ['ipwho'],
        consent: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await post('/api/dns/start', { count: 3, consent: true })).status,
    400,
  );
  const unconfigured = await (
    await post('/api/ip-profile', {
      ip: '8.8.8.8',
      providers: ['abuse'],
      consent: true,
    })
  ).json();
  assert.equal(unconfigured.ok, true);
  assert.equal(unconfigured.data[0].state, 'unconfigured');
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(
    home.headers.get('content-security-policy'),
    /default-src 'self'/,
  );
  assert.ok((await home.text()).includes('AI 体检站'));
  assert.equal((await fetch(base + '/probe.json')).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 403);
  assert.ok(!logs.includes('UNEXPECTED_OUTBOUND'), logs);
});
