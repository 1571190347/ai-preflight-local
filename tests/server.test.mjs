import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isPublicIp,
  publicIp,
  target,
  safeRequest,
  checkRequest,
} from '../server/security.mjs';
import {
  normalizeProfile,
  normalizeStatus,
  inCidr,
  parseFeed,
} from '../server/providers.mjs';
import { loadConfig } from '../server/config.mjs';

function withConfig(value, run, { raw = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-config-test-'));
  const previous = process.env.CONFIG_FILE;
  try {
    process.env.CONFIG_FILE = join(dir, 'config.json');
    if (value !== undefined)
      writeFileSync(
        process.env.CONFIG_FILE,
        raw ? value : JSON.stringify(value),
      );
    return run();
  } finally {
    if (previous === undefined) delete process.env.CONFIG_FILE;
    else process.env.CONFIG_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
const endpoint = {
  id: 'example',
  name: 'Example',
  url: 'https://example.com/probe',
};
const feed = { id: 'example', name: 'Example News' };

test('public IP validation preserves ordinary IPv4 and IPv6 but rejects invalid spellings', () => {
  for (const ip of [
    '1.1.1.1',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860:0:0:0:0:8888',
  ]) {
    assert.equal(isPublicIp(ip), true, ip);
    assert.equal(publicIp(ip), ip);
  }
  for (const ip of [
    '',
    null,
    '127.1',
    '0x7f000001',
    '0127.0.0.1',
    '1.2.3.256',
    ':::',
    'fffff::1',
    'fe80::1%en0',
  ]) {
    assert.equal(isPublicIp(ip), false, String(ip));
    assert.throws(() => publicIp(ip), /公网/);
  }
});

test('SSRF guard rejects private, translated, documentation and special-purpose destinations', () => {
  for (const ip of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'fec0::1',
    '2001:2::1',
    '3fff::1',
    '5f00::1',
  ])
    assert.equal(isPublicIp(ip), false, ip);
});

test('outbound requests reject unsafe URL forms and IP literals before any network operation', async () => {
  for (const url of [
    'http://example.com/',
    'file:///etc/passwd',
    'https://user:password@example.com/',
    'https://example.com:8443/',
    'https://127.0.0.1/',
    'https://127.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[fec0::1]/',
  ])
    await assert.rejects(safeRequest(url), /HTTPS|公网/, url);
});

test('targets normalize domain case and IDN while retaining explicit IP and ASN kinds', () => {
  assert.deepEqual(target('  EXAMPLE.COM  '), {
    kind: 'domain',
    value: 'example.com',
  });
  assert.deepEqual(target('例子.公司'), {
    kind: 'domain',
    value: 'xn--fsqu00a.xn--55qx5d',
  });
  assert.deepEqual(target('8.8.8.8'), { kind: 'ip', value: '8.8.8.8' });
  assert.deepEqual(target('as15169', { allowAsn: true }), {
    kind: 'autnum',
    value: '15169',
  });
  assert.deepEqual(target('AS4294967295', { allowAsn: true }), {
    kind: 'autnum',
    value: '4294967295',
  });
  for (const asn of ['AS0', 'AS4294967296'])
    assert.throws(() => target(asn, { allowAsn: true }));
});

test('targets reject URL syntax, command-like input, local names and malformed labels', () => {
  for (const input of [
    'https://example.com',
    'example.com/path',
    'example.com:443',
    'user@example.com',
    'example.com?x=1',
    'example.com#x',
    'example.com\\evil',
    'example.com\r\nx',
    'example.com;whoami',
    'localhost',
    'host.local',
    'host.internal',
    'host.test',
    'host.invalid',
    'a..com',
    '-host.com',
    'a'.repeat(64) + '.com',
    '127.0.0.1',
    '10.0.0.1',
    '::1',
  ])
    assert.throws(() => target(input), undefined, input);
});

test('request guard accepts local browser and Vite requests, rejects cross-origin and rebinding forms', () => {
  const get = (headers) => ({ method: 'GET', headers });
  const post = (headers) => ({ method: 'POST', headers });
  assert.equal(checkRequest(get({ host: '127.0.0.1:4173' }), 4173), true);
  assert.equal(checkRequest(get({ host: '[::1]:4173' }), 4173), true);
  assert.equal(
    checkRequest(
      post({
        host: 'localhost:4173',
        origin: 'http://localhost:4173',
        'content-type': 'application/json; charset=utf-8',
        'sec-fetch-site': 'same-origin',
      }),
      4173,
    ),
    true,
  );
  assert.equal(
    checkRequest(
      post({
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      }),
      4174,
      'http://127.0.0.1:5173',
    ),
    true,
  );
  for (const req of [
    get({ host: 'attacker.example:4173' }),
    get({ host: 'localhost.attacker.example:4173' }),
    get({ host: '127.0.0.1:4173', origin: 'https://attacker.example' }),
    get({ host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site' }),
    post({ host: '127.0.0.1:4173', 'content-type': 'application/json' }),
    post({
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'text/plain',
    }),
    post({
      host: '127.0.0.1:4173',
      origin: 'null',
      'content-type': 'application/json',
    }),
  ])
    assert.equal(checkRequest(req, 4173), false, JSON.stringify(req));
});

test('config strips unrecognized fields and preserves only environment variable references for ping keys', () => {
  const previous = process.env.CONFIG_FILE;
  withConfig(
    {
      apiToken: 'must-not-surface',
      connectionSources: [
        {
          ...endpoint,
          secret: 'not-public',
          headers: { Authorization: 'not-public' },
          note: 'n'.repeat(700),
        },
      ],
      pingNodes: [
        { ...endpoint, tokenEnv: 'PING_NODE_TOKEN', token: 'not-public' },
      ],
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.connectionSources[0], {
        ...endpoint,
        note: 'n'.repeat(500),
      });
      assert.deepEqual(config.pingNodes[0], {
        ...endpoint,
        tokenEnv: 'PING_NODE_TOKEN',
      });
      assert.equal(JSON.stringify(config).includes('not-public'), false);
      assert.equal('apiToken' in config, false);
    },
  );
  assert.equal(process.env.CONFIG_FILE, previous);
});

test('config rejects URLs containing secrets, credentials, fragments or alternate transport', () => {
  for (const url of [
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:444/',
    'https://example.com/#secret',
    'https://example.com/?key=secret',
    'https://example.com/?API_KEY=secret',
    'https://example.com/?access_token=secret',
    'https://example.com/?password=secret',
  ])
    withConfig({ newsFeeds: [{ ...endpoint, url }] }, () =>
      assert.throws(() => loadConfig(), /HTTPS|凭据/),
    );
  withConfig(
    { newsFeeds: [{ ...endpoint, url: 'https://example.com/?format=json' }] },
    () =>
      assert.equal(
        loadConfig().newsFeeds[0].url,
        'https://example.com/?format=json',
      ),
  );
});

test('config validates structures, source IDs, formats, STUN ports and key variable names', () => {
  for (const value of [
    null,
    [],
    { newsFeeds: 'invalid' },
    { newsFeeds: Array(65).fill(endpoint) },
    { newsFeeds: [endpoint, endpoint] },
    { newsFeeds: [{ ...endpoint, id: '../escape' }] },
    { exitSources: [{ ...endpoint, format: 'html' }] },
    { pingNodes: [{ ...endpoint, tokenEnv: 'secret-value' }] },
    { stunServers: ['stun:example.com:0'] },
    { stunServers: ['stun:example.com:65536'] },
    { stunServers: ['turn:example.com:3478'] },
  ])
    withConfig(value, () => assert.throws(() => loadConfig()));
  withConfig('{broken', () => assert.throws(() => loadConfig(), /JSON/), {
    raw: true,
  });
  withConfig(undefined, () => {
    const config = loadConfig();
    assert.ok(config.exitSources.length > 0);
    assert.deepEqual(config.pingNodes, []);
  });
});

test('missing and null IP profile fields stay unknown without discarding geography', () => {
  const profile = normalizeProfile('ipapi', {
    ip: '8.8.8.8',
    company: null,
    asn: null,
    location: { country: 'United States', city: 'Example' },
  });
  assert.equal(profile.ip, '8.8.8.8');
  assert.equal(profile.city, 'Example');
  assert.equal(profile.asn, null);
  assert.equal(profile.organization, null);
  assert.equal(profile.type, null);
  assert.equal(profile.sourceRisk, null);
  assert.ok(Object.values(profile.flags).every((value) => value === null));
  assert.equal(
    normalizeProfile('ipapi', {
      ip: '8.8.8.8',
      company: 'Example Network',
      asn: 15169,
    }).organization,
    'Example Network',
  );
});

test('risk normalization keeps explicit booleans, rejects truthiness and never invents platform scores', () => {
  const profile = normalizeProfile('ipapi', {
    ip: '8.8.8.8',
    is_vpn: false,
    is_proxy: true,
    is_tor: 'false',
    is_abuser: 0,
    company: { name: 'Example', type: 'hosting', abuser_score: '0.05 (Low)' },
    asn: { asn: 15169 },
  });
  assert.equal(profile.flags.is_vpn, false);
  assert.equal(profile.flags.is_proxy, true);
  assert.equal(profile.flags.is_tor, null);
  assert.equal(profile.flags.is_abuser, null);
  assert.equal(profile.flags.is_datacenter, null);
  assert.equal(profile.sourceRisk, '0.05 (Low)');
  assert.equal(profile.asn, 15169);
  assert.match(profile.note, /不是 Claude/);
  assert.deepEqual(
    normalizeProfile('ipwho', { ip: '8.8.8.8', country: 'US' }).flags,
    {},
  );
  assert.equal(
    normalizeProfile('abuse', {
      data: { ipAddress: '8.8.8.8', abuseConfidenceScore: 0 },
    }).sourceRisk,
    0,
  );
  assert.equal(
    normalizeProfile('abuse', { data: { ipAddress: '8.8.8.8' } }).sourceRisk,
    null,
  );
  assert.throws(() => normalizeProfile('ipapi', { error: 'rate limited' }));
  assert.throws(() => normalizeProfile('ipwho', { success: false }));
});

test('status normalization distinguishes reported incidents from unknown response formats', () => {
  const source = { ...endpoint, category: 'AI' };
  assert.equal(
    normalizeStatus(source, {
      status: { indicator: 'none', description: 'Operational' },
    }).state,
    'received',
  );
  const incident = normalizeStatus(source, {
    status: { indicator: 'major' },
    incidents: [
      {
        name: 'Outage',
        status: 'investigating',
        incident_updates: [{ body: 'Investigating' }],
      },
    ],
  });
  assert.equal(incident.state, 'attention');
  assert.equal(incident.incidents[0].body, 'Investigating');
  assert.equal(incident.incidents[0].url, source.url);
  for (const data of [
    null,
    {},
    { status: { indicator: 'ok' } },
    { status: { indicator: false } },
  ])
    assert.throws(() => normalizeStatus(source, data));
});

test('RDAP CIDR selection matches subnet boundaries and equivalent compressed IPv6', () => {
  for (const [ip, cidr, expected] of [
    ['8.8.8.0', '8.8.8.0/24', true],
    ['8.8.8.255', '8.8.8.0/24', true],
    ['8.8.9.0', '8.8.8.0/24', false],
    ['8.8.8.8', '8.8.8.8/32', true],
    ['8.8.8.9', '8.8.8.8/32', false],
    ['8.8.8.8', '0.0.0.0/0', true],
    ['2606:4700:4700::1111', '2606:4700::/32', true],
    ['2606:4701::1', '2606:4700::/32', false],
    ['2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111/128', true],
    ['2606:4700:4700::1112', '2606:4700:4700::1111/128', false],
    ['2606:4700::1', '::/0', true],
    ['8.8.8.8', '2606:4700::/32', false],
    ['2606:4700::1', '8.8.8.0/24', false],
    ['8.8.8.8', '8.8.8.0/33', false],
    ['2606:4700::1', '2606:4700::/129', false],
    ['8.8.8.8', '8.8.8.0/-1', false],
    ['8.8.8.8', '8.8.8.0/not-a-prefix', false],
  ])
    assert.equal(inCidr(ip, cidr), expected, `${ip} in ${cidr}`);
});

test('RSS and Atom parsing returns safe titles and HTTP links with a bounded item count', () => {
  const rss =
    '<rss><channel><item><title><![CDATA[<b>Hello</b> &amp; world]]></title><link>https://example.com/story?a=1&amp;b=2</link><pubDate>2026-09-07</pubDate></item><item><title>Bad link</title><link>javascript:alert(1)</link></item></channel></rss>';
  assert.deepEqual(parseFeed(rss, feed), [
    {
      title: 'Hello & world',
      url: 'https://example.com/story?a=1&b=2',
      date: '2026-09-07',
      source: feed.name,
      sourceId: feed.id,
    },
  ]);
  const atom =
    '<feed><entry><title>Atom post</title><link href="https://example.com/atom"/><updated>2026-09-07T12:00:00Z</updated></entry></feed>';
  assert.equal(parseFeed(atom, feed)[0].url, 'https://example.com/atom');
  assert.equal(
    parseFeed(
      '<rss>' +
        '<item><title>Post</title><link>https://example.com/</link></item>'.repeat(
          100,
        ) +
        '</rss>',
      feed,
    ).length,
    60,
  );
  assert.throws(
    () => parseFeed('<itemized>not an entry</itemized>', feed),
    /RSS/,
  );
});

test('malformed maximum-size RSS cannot hold the server event loop with quadratic scanning', () => {
  // A subprocess deadline also protects the test runner if a future regex regression blocks synchronously.
  const moduleUrl = new URL('../server/providers.mjs', import.meta.url).href;
  const script = `import {parseFeed} from ${JSON.stringify(moduleUrl)};\nconst xml='<item>'.repeat(500000);\ntry { parseFeed(xml,{id:'test',name:'test'}); process.exit(2); } catch (error) { if (!/RSS/.test(error.message)) throw error; }`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 10000 },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(
    result.status,
    0,
    result.stderr || 'malformed RSS exceeded the bounded parsing deadline',
  );
});
