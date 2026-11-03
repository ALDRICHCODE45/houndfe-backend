const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeBody, expect: expectResponse } = require('./probe.cjs');

test('204 accepts zero bytes only; ordinary JSON stays strict', () => {
  assert.equal(decodeBody(204, ''), undefined);
  for (const text of ['null', '{}', ' '])
    assert.throws(() => decodeBody(204, text));
  assert.deepEqual(decodeBody(200, '{}'), {});
  assert.throws(() => decodeBody(200, ''));
});
test('204 enforces no-store, CORS and empty bytes', () => {
  const headers = new Headers({
    'cache-control': 'no-store',
    'access-control-allow-origin': 'http://127.0.0.1:43179',
    'access-control-allow-credentials': 'true',
  });
  const response = { status: 204, headers, text: '', body: undefined };
  assert.equal(expectResponse(response, 204), undefined);
  assert.throws(() => expectResponse({ ...response, text: 'null' }, 204));
  headers.delete('cache-control');
  assert.throws(() => expectResponse(response, 204));
});
