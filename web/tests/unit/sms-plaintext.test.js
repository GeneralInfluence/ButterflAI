/**
 * sms-plaintext.test.js — outbound SMS is plain text.
 *
 * Regression (sim, 2026-10-05): the agent's SMS reply arrived as
 * "Done! I've invited BamBam to dinner **Friday, Oct 9, 7:00 PM**." — SMS doesn't
 * render markdown, so the asterisks showed literally. sms.send/sendUnchecked now strip it.
 */
'use strict';

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sms = require('../../sms');

describe('toPlainSms', () => {
  const p = sms.toPlainSms;

  test('strips bold — the exact regression', () => {
    assert.equal(p("Done! I've invited BamBam to dinner **Friday, Oct 9, 7:00 PM**. I'll let you know."),
      "Done! I've invited BamBam to dinner Friday, Oct 9, 7:00 PM. I'll let you know.");
    assert.equal(p('__Saturday__ works'), 'Saturday works');
  });

  test('strips italics, inline code, headings; bullets become •', () => {
    assert.equal(p('that is *really* fun'), 'that is really fun');
    assert.equal(p('use `code` here'), 'use code here');
    assert.equal(p('## Plans\n- dinner\n- drinks'), 'Plans\n• dinner\n• drinks');
  });

  test('links keep the URL', () => {
    assert.equal(p('RSVP [here](https://butterflai.social/e/1)'), 'RSVP here (https://butterflai.social/e/1)');
    assert.equal(p('[https://x.co](https://x.co)'), 'https://x.co');
  });

  test('leaves ordinary text alone', () => {
    for (const s of ['Reply STOP to opt out.', 'Rated 5* by locals', 'snake_case_name', '2 * 3 = 6', 'Meet at 7:30 — bring $20']) {
      assert.equal(p(s), s);
    }
  });
});

describe('outbound SMS bodies are plain text', () => {
  test('sendUnchecked strips markdown before it reaches Twilio', async () => {
    const sent = [];
    sms._setClient({ messages: { create: async (m) => { sent.push(m); return { sid: 'SM1' }; } } });
    await sms.sendUnchecked('+12025550100', 'See you **Friday**!');
    assert.equal(sent[0].body, 'See you Friday!');
  });
});
