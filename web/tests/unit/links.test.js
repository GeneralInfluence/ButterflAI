/**
 * links.test.js — the agent can't send made-up ButterflAI links (2026-10-09, Melanie got
 * butterflai.app/login, app.butterflai.com/login, butterflai.social/login and a literal
 * "[ButterflAI login]"; Sean was told butterfly.com).
 */
'use strict';
delete process.env.BASE_URL;
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../links');

describe('checkOutbound', () => {
  test('every link the agent actually sent Melanie is refused', () => {
    for (const t of [
      'Here is your login link: https://butterflai.app/login',
      'log in at https://app.butterflai.com/login.',
      'https://butterflai.social/login',
      'here is your login link: [ButterflAI login]',
      'open butterfly.com',
    ]) assert.equal(links.checkOutbound(t).ok, false, t);
  });
  test('the refusal carries the real links', () => {
    assert.match(links.checkOutbound('https://butterflai.app/login').message, /https:\/\/butterflai\.social\/app\/login/);
  });
  test('real links and normal text pass', () => {
    for (const t of ['Log in: https://butterflai.social/app/login', 'butterflai.social', 'https://butterflai.social/invite/abc', 'see you at 8 [maybe 9](https://x.co)', 'Wings tonight?'])
      assert.equal(links.checkOutbound(t).ok, true, t);
  });
});

describe('fixReply', () => {
  test('wrong domains/paths in replies to the user are corrected', () => {
    assert.equal(links.fixReply('Go to https://butterfly.com/login now'), 'Go to https://butterflai.social/app/login now');
    assert.equal(links.fixReply('butterflai.app/login.'), 'https://butterflai.social/app/login.');
    assert.equal(links.fixReply('https://butterflai.social/app/chat'), 'https://butterflai.social/app/chat');
  });
  test('the prompt line lists the real login link', () => {
    assert.match(links.linksForPrompt(), /log in https:\/\/butterflai\.social\/app\/login/);
  });
});
