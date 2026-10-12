/**
 * sse.test.js — every open screen gets live replies; a reconnect never drops the new one.
 * Regression (2026-10-12): Sean saw no reply until he left chat and came back — the old
 * connection's 'close' removed the new connection from the hub.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const sse = require('../../sse');

function fakeRes() {
  const r = new EventEmitter();
  r.out = [];
  r.setHeader = () => {}; r.flushHeaders = () => {};
  r.write = (s) => { if (r.closed) throw new Error('closed'); r.out.push(s); return true; };
  r.end = () => { r.closed = true; };
  r.close = () => { r.closed = true; r.emit('close'); };
  return r;
}
const got = (r) => r.out.filter((s) => s.startsWith('data:')).map((s) => JSON.parse(s.slice(5)).text);

test('reconnect: the old connection closing afterwards does not drop the new one', () => {
  const oldRes = fakeRes(), newRes = fakeRes();
  sse.register('u1', oldRes);
  sse.register('u1', newRes);
  oldRes.close();                               // fires after the new one registered
  assert.equal(sse.push('u1', { text: 'reply' }), true);
  assert.deepEqual(got(newRes), ['reply']);
  newRes.close();
  assert.equal(sse.isConnected('u1'), false);
});

test('two screens (phone + laptop) both get it; one closing leaves the other', () => {
  const phone = fakeRes(), laptop = fakeRes();
  sse.register('u2', phone);
  sse.register('u2', laptop);
  sse.push('u2', { text: 'a' });
  assert.deepEqual(got(phone), ['a']);
  assert.deepEqual(got(laptop), ['a']);
  phone.close();
  assert.equal(sse.push('u2', { text: 'b' }), true);
  assert.deepEqual(got(laptop), ['a', 'b']);
  sse.unregister('u2');
  assert.equal(sse.push('u2', { text: 'c' }), false);
});
