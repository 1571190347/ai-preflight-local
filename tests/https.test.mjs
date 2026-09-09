import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { safeRequest } from '../server/security.mjs';
test('HTTPS guard pins IP and blocks secret forwarding and private redirect targets', async (t) => {
  const original = https.request;
  t.after(() => (https.request = original));
  let calls = [];
  let location = 'https://1.1.1.1/result';
  https.request = (url, opts, callback) => {
    calls.push({ url: String(url), opts });
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (e) => {
      req.emit('error', e);
      req.emit('close');
    };
    req.end = () =>
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = calls.length === 1 ? 307 : 200;
        response.headers = calls.length === 1 ? { location } : {};
        callback(response);
        response.emit('data', Buffer.from('{}'));
        response.emit('end');
        req.emit('close');
      });
    return req;
  };
  for (const options of [
    { sensitive: true },
    { headers: { Authorization: 'Bearer secret' } },
    { body: '{"key":"secret"}', method: 'POST' },
  ]) {
    calls = [];
    await assert.rejects(safeRequest('https://8.8.8.8/', options), /密钥/);
    assert.equal(calls.length, 1);
  }
  calls = [];
  await assert.rejects(safeRequest('https://8.8.8.8/?key=secret'), /密钥/);
  assert.equal(calls.length, 1);
  calls = [];
  location = 'https://127.0.0.1/';
  await assert.rejects(safeRequest('https://8.8.8.8/'), /公网/);
  assert.equal(calls.length, 1);
  calls = [];
  location = 'https://1.1.1.1/result';
  const result = await safeRequest('https://8.8.8.8/');
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  await new Promise((resolve) =>
    calls[0].opts.lookup('ignored', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      resolve();
    }),
  );
});
