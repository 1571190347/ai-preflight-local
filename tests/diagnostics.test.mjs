import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runChecks,
  parseTrace,
  regionNote,
  isPlatform,
} from '../lib/diagnostics.ts';
function fixture(overrides = {}) {
  const calls = [];
  const values = new Map([['existing-user-data', 'keep']]);
  let cookie = 'existing=keep';
  let time = 0;
  const runtime = {
    protocol: 'https:',
    now: () => (time += 20),
    cookie: {
      read: () => cookie,
      write: (v) => {
        const pair = v.split(';')[0];
        cookie = v.includes('Max-Age=0')
          ? 'existing=keep'
          : 'existing=keep; ' + pair;
      },
    },
    storage: {
      setItem: (k, v) => values.set(k, v),
      getItem: (k) => values.get(k) ?? null,
      removeItem: (k) => values.delete(k),
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('/probe'))
        return new Response(
          JSON.stringify({ service: 'ai-preflight', version: 1 }),
        );
      if (url.includes('trace'))
        return new Response('ip=203.0.113.77\nloc=CN\n');
      return new Response(
        JSON.stringify({
          status: { indicator: 'none', description: 'All Systems Operational' },
        }),
      );
    },
    ...overrides,
  };
  return { runtime, calls, values, getCookie: () => cookie };
}
test('both platforms complete; real data is masked; temporary state is cleaned up', async () => {
  const f = fixture();
  const updates = [];
  const r = await runChecks('both', (x) => updates.push(x), f.runtime);
  assert.equal(r.length, 7);
  assert.equal(updates.length, 7);
  assert.equal(r.find((x) => x.id === 'exit').value, '中国 · 203.0.*.*');
  assert(!JSON.stringify(r).includes('203.0.113.77'));
  assert.equal(r.find((x) => x.id === 'connection').state, 'pass');
  assert.equal(r.find((x) => x.id === 'chatgpt').state, 'info');
  assert.deepEqual([...f.values], [['existing-user-data', 'keep']]);
  assert.equal(f.getCookie(), 'existing=keep');
  assert.equal(
    new Set(f.calls.filter((x) => x.url.startsWith('/probe')).map((x) => x.url))
      .size,
    3,
  );
  for (const call of f.calls.filter((x) => x.url.startsWith('https:'))) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
  }
});
test('single selection never contacts the unselected platform', async () => {
  const f = fixture();
  const r = await runChecks('claude', () => {}, f.runtime);
  assert.equal(r.length, 6);
  assert(!r.some((x) => x.id === 'chatgpt'));
  assert(!f.calls.some((x) => x.url.includes('openai')));
});
test('blocked network and denied storage do not produce a pass', async () => {
  const f = fixture({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    storage: {
      setItem: () => {
        throw new Error('denied');
      },
      getItem: () => null,
      removeItem: () => {},
    },
    cookie: { read: () => '', write: () => {} },
  });
  const r = await runChecks('chatgpt', () => {}, f.runtime);
  assert.equal(r.find((x) => x.id === 'connection').state, 'attention');
  assert.equal(r.find((x) => x.id === 'exit').state, 'unknown');
  assert.equal(r.find((x) => x.id === 'chatgpt').state, 'unknown');
  assert.equal(r.find((x) => x.id === 'storage').state, 'attention');
  assert.equal(r.find((x) => x.id === 'cookie').state, 'attention');
});
test('HTML fallback and unexpected API shapes never pass as diagnostic responses', async () => {
  const f = fixture({
    fetch: async () => new Response('<html>Sign in</html>'),
  });
  const r = await runChecks('both', () => {}, f.runtime);
  assert.equal(r.find((x) => x.id === 'connection').state, 'attention');
  assert.equal(r.find((x) => x.id === 'exit').state, 'unknown');
  assert.equal(r.find((x) => x.id === 'claude').state, 'unknown');
});
test('status incident is attention; HTTP is attention', async () => {
  const f = fixture({
    protocol: 'http:',
    fetch: async () =>
      new Response(
        JSON.stringify({
          status: { indicator: 'major', description: 'Major Service Outage' },
        }),
      ),
  });
  const r = await runChecks('chatgpt', () => {}, f.runtime);
  assert.equal(r.find((x) => x.id === 'https').state, 'attention');
  assert.equal(r.find((x) => x.id === 'chatgpt').state, 'attention');
});
test('trace parsing and rule freshness reject misleading conclusions', () => {
  assert.throws(() => parseTrace('ip=hello\nloc=CN'));
  assert.throws(() => parseTrace('ip=999.1.1.1\nloc=CN'));
  assert.throws(() => parseTrace('<html/>'));
  assert.equal(parseTrace('ip=2001:db8::1234\nloc=US').maskedIp, '2001:db8:…');
  assert(regionNote('CN', Date.parse('2026-09-08')).includes('未列入'));
  assert(regionNote('CN', Date.parse('2026-12-08')).includes('重新核实'));
  assert(regionNote('US', Date.parse('2026-09-08')).includes('未对'));
});
test('invalid platform input fails before starting any requests', async () => {
  const f = fixture();
  assert.equal(isPlatform('gpt'), false);
  await assert.rejects(() => runChecks('invalid', () => {}, f.runtime));
  assert.equal(f.calls.length, 0);
});
