import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectWebRTC,
  inspectDevice,
  redact,
  validateStunServer,
} from '../.test-build/browser-tools.js';
import {
  cardPatterns,
  cardStamps,
  cardThemes,
  makeIpCard,
  makeShareSnippets,
  safeXML,
} from '../.test-build/card-tools.js';

test('STUN configuration rejects credentials, URL extras, invalid ports and host labels', () => {
  assert.equal(
    validateStunServer(' STUN:stun.example.com:3478 '),
    'stun:stun.example.com:3478',
  );
  assert.equal(
    validateStunServer('stuns:example.com:5349'),
    'stuns:example.com:5349',
  );
  for (const value of [
    'turn:example.com',
    'stun:user:pass@example.com',
    'stun:example.com:0',
    'stun:example.com:65536',
    'stun:example.com?transport=tcp',
    'stun:https://example.com',
    'stun:-bad.example.com',
    'stun:example..com',
    'stun:example.com/path',
  ])
    assert.equal(validateStunServer(value), null, value);
});

test('redaction removes embedded IPs, raw headers, access keys and sensitive structured fields', () => {
  const input = {
    note: '出口 203.0.113.27；[2001:db8::1]:443；mapped ::ffff:192.0.2.2；full 2001:0db8:0000:0000:0000:0000:1428:57ab；scope fe80::abcd%en0；mixed 2001:db8:0:0:0:ffff:192.0.2.1',
    headers:
      'Authorization: Bearer abc\nCookie: sid=xyz\nX-Api-Key: should-not-share',
    url: 'https://user:secret@example.com/path?token=private-token&view=ok',
    nested: [
      {
        canvasSha256: 'abc',
        webgl: { renderer: 'GPU' },
        fingerprint: 'xyz',
        safe: '保留结果',
      },
    ],
    ip: 'broken-but-private',
    apiKey: 'not-for-sharing',
    token: 'secret',
    safe: '12:34:56 and build 1.2.3',
    standalone: 'sk-ant-12345678901234567890',
  };
  const result = redact(input);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    '203.0.113.27',
    '2001:db8',
    '192.0.2.2',
    '1428:57ab',
    'fe80::abcd',
    'sid=xyz',
    'should-not-share',
    'private-token',
    'user:secret',
    'GPU',
    'broken-but-private',
    '12345678901234567890',
  ])
    assert(!serialized.includes(privateValue), privateValue);
  assert.equal(result.safe, input.safe);
  assert.equal(result.nested[0].safe, '保留结果');
  assert.equal(input.apiKey, 'not-for-sharing', 'input was not mutated');
});

test('redaction never invokes accessors and safely handles cycles and special objects', () => {
  let accessed = false;
  const value = {
    map: new Map([['remoteAddress', '203.0.113.5']]),
    set: new Set(['2001:db8::ab']),
    date: new Date('2026-09-07T00:00:00Z'),
  };
  Object.defineProperty(value, 'getter', {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('should not run');
    },
  });
  value.self = value;
  const result = redact(value);
  assert.equal(accessed, false);
  assert.equal(result.getter, '[已省略访问器]');
  assert.equal(result.self, '[循环引用]');
  assert(!JSON.stringify(result).includes('203.0.113.5'));
  assert.equal(result.date, '2026-09-07T00:00:00.000Z');
});

test('device inspection gracefully reports a non-browser runtime', async () => {
  const result = await inspectDevice(false);
  assert.equal(result.available, false);
});

test('WebRTC uses one independent peer per STUN node and never opens media', async (t) => {
  const peers = [];
  class Peer {
    constructor(config) {
      this.config = config;
      this.closed = false;
      peers.push(this);
    }
    createDataChannel(name) {
      assert.equal(name, 'local-preflight');
    }
    createOffer() {
      return Promise.resolve({ type: 'offer', sdp: '' });
    }
    setLocalDescription() {
      queueMicrotask(() => {
        this.onicecandidate?.({
          candidate: {
            candidate: 'candidate:1 1 udp 1 203.0.113.5 5000 typ srflx',
            address: '203.0.113.5',
            type: 'srflx',
            protocol: 'udp',
          },
        });
        this.onicecandidate?.({
          candidate: {
            candidate: 'candidate:1 1 udp 1 host.local 5000 typ host',
            address: 'host.local',
            type: 'host',
            protocol: 'udp',
          },
        });
        this.onicecandidate?.({ candidate: null });
      });
      return Promise.resolve();
    }
    close() {
      this.closed = true;
    }
  }
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  t.after(() => {
    if (previous === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = previous;
  });
  const result = await collectWebRTC(
    ['stun:one.example.com', 'stun:two.example.com'],
    ['203.0.113.5'],
  );
  assert.equal(peers.length, 2);
  assert.deepEqual(
    peers.map((peer) => peer.config.iceServers[0].urls),
    ['stun:one.example.com', 'stun:two.example.com'],
  );
  assert(
    peers.every(
      (peer) =>
        peer.closed &&
        peer.onicecandidate === null &&
        peer.onicegatheringstatechange === null,
    ),
  );
  assert.equal(result.candidates.length, 4);
  assert.equal(result.errors.length, 0);
  assert(result.conclusion.includes('一致'));
  assert(
    result.candidates
      .filter((candidate) => candidate.address === 'host.local')
      .every((candidate) => candidate.comparison.includes('mDNS')),
  );
});

test('WebRTC cancellation closes all peers and invalid configuration never starts a probe', async (t) => {
  const peers = [];
  class Peer {
    constructor() {
      this.closed = false;
      peers.push(this);
    }
    createDataChannel() {}
    createOffer() {
      return new Promise(() => {});
    }
    close() {
      this.closed = true;
    }
  }
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  t.after(() => {
    if (previous === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = previous;
  });
  const invalid = await collectWebRTC(['https://invalid.example'], []);
  assert.equal(peers.length, 0);
  assert(invalid.errors[0].includes('地址无效'));
  const controller = new AbortController();
  const task = collectWebRTC(
    ['stun:one.example.com', 'stun:two.example.com'],
    [],
    controller.signal,
  );
  controller.abort();
  const result = await task;
  assert.equal(peers.length, 2);
  assert(peers.every((peer) => peer.closed && peer.onicecandidate === null));
  assert.equal(result.errors.length, 2);
  assert(result.conclusion.includes('取消'));
  await collectWebRTC(['stun:three.example.com'], [], controller.signal);
  assert.equal(peers.length, 2, 'pre-aborted run must not create a peer');
});

test('WebRTC stops each gathering attempt after its seven-second window', async (t) => {
  let closed = false;
  let requestedDelay = 0;
  class Peer {
    createDataChannel() {}
    createOffer() {
      return new Promise(() => {});
    }
    close() {
      closed = true;
    }
  }
  const previous = globalThis.RTCPeerConnection;
  const originalTimer = globalThis.setTimeout;
  globalThis.RTCPeerConnection = Peer;
  globalThis.setTimeout = (fn, delay) => {
    requestedDelay = delay;
    return originalTimer(fn, 1);
  };
  t.after(() => {
    globalThis.setTimeout = originalTimer;
    if (previous === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = previous;
  });
  const result = await collectWebRTC([], []);
  assert.equal(requestedDelay, 7000);
  assert.equal(closed, true);
  assert(result.errors.some((error) => error.includes('7 秒')));
  assert(result.conclusion.includes('无法判断'));
});

test('card catalogue has 22 original themes and 64 distinct pattern/stamp pairings', () => {
  assert.equal(cardThemes.length, 22);
  assert.equal(new Set(cardThemes.map((item) => item.id)).size, 22);
  assert.equal(cardPatterns.length, 8);
  assert.equal(cardStamps.length, 8);
  const rendered = new Set(
    cardPatterns.flatMap((pattern) =>
      cardStamps.map((stamp) =>
        makeIpCard({ pattern: pattern.id, stamp: stamp.id }),
      ),
    ),
  );
  assert.equal(rendered.size, 64);
  for (const theme of cardThemes)
    assert(
      makeIpCard({ theme: theme.id }).includes(`fill="${theme.background}"`),
    );
});

test('IP cards hide IPs in all user fields by default and escape active SVG content', () => {
  const result = makeIpCard({
    ip: '203.0.113.7',
    title: '203.0.113.7 <script>alert(1)</script>',
    detail: "2001:db8::1 <image href='https://evil.example/x'>",
  });
  assert(!result.includes('203.0.113.7'));
  assert(!result.includes('2001:db8::1'));
  assert(!result.includes('<script>'));
  assert(!result.includes('<image'));
  assert(result.includes('IP 已隐藏'));
  assert(result.includes('width="720" height="340"'));
  const visible = makeIpCard({
    ip: '203.0.113.7"><script/>',
    hideIp: false,
    theme: '" onload="evil()',
  });
  assert(visible.includes('203.0.113.7&quot;&gt;&lt;script/&gt;'));
  assert(!visible.includes('onload='));
  assert.equal(safeXML('\u0001<&"\'>'), '&lt;&amp;&quot;&apos;&gt;');
});

test('static share snippets reject remote / active sources and mask caption addresses', () => {
  const result = makeShareSnippets(
    'images/my card.png',
    'IP [203.0.113.5] <img>',
  );
  assert(result.html.includes('src="images/my%20card.png"'));
  assert(!result.html.includes('203.0.113.5'));
  assert(result.html.includes('&lt;img&gt;'));
  assert(result.markdown.includes('images/my%20card.png'));
  assert.equal(result.bbcode, '[img]images/my%20card.png[/img]');
  for (const value of [
    'https://tracker.example/pixel.png',
    '//evil.example/a.svg',
    'javascript:alert(1)',
    '../secret.png',
    'images/../../secret.png',
    'ip-card.png?track=1',
    'x\" onerror=\"x.png',
    'ip-card.jpg',
  ])
    assert.throws(() => makeShareSnippets(value), value);
});

test('shared registration records omit structured contacts and textual personal details', () => {
  const result = JSON.stringify(
    redact({
      vcardArray: ['vcard', [['email', {}, 'text', 'person@example.com']]],
      raw: 'Registrant Name: Example Person\nAdmin Email: admin@example.com\nDomain Name: example.com',
    }),
  );
  assert.ok(!result.includes('Example Person'));
  assert.ok(!result.includes('person@example.com'));
  assert.ok(!result.includes('admin@example.com'));
  assert.ok(result.includes('Domain Name: example.com'));
});
