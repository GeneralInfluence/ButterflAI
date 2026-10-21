/**
 * what-changed.test.js — Sean, 2026-10-21: "when I saw that Melanie had changed something and I clicked on the thing,
 * it went to details, but I couldn't figure out what it was exactly that had changed. So maybe when I click on my
 * notification on my phone, it should highlight that as the one thing on the screen … one time … and I never see it again."
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'what-changed-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create: async () => ({ sid: 'SM' }) } });
const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const planops = require('../../planops');

let n = 0;
function mkUser(name) {
  const phone = `+1202538${String(1000 + n++)}`;
  db._raw().prepare("INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')").run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('a change notification shows that change', () => {
  test('Melanie changes the notes: Sean\'s notification opens the plan at that change — who, before and after', async () => {
    const sean = mkUser('Sean C'); const mel = mkUser('Melanie C'); const stranger = mkUser('Stranger C');
    const cid = db.upsertContact({ invited_by_user_id: sean.id, name: mel.name, phone: mel.phone, tier: 1 });
    const e = (await planops.create(sean.id, { title: 'Melanie\'s Weekend C', scheduled_at: new Date(Date.now() + 3 * 86400e3).toISOString(), notes: 'Friday: spa', contact_ids: [cid] })).eventId;
    const inv = db._raw().prepare('SELECT id FROM event_invitations WHERE event_id = ?').get(e).id;
    planops.respond(inv, 'accepted', { by: 'guest', phone: mel.phone });
    planops.setCohost(sean.id, e, inv, true);
    await planops.update(mel.id, e, { notes: 'Friday: Massages for 4 at Renaissance Hotel 10am', venue_name: 'Renaissance Hotel' });
    const fyi = db._raw().prepare("SELECT text FROM conversation_history WHERE user_id = ? AND kind = 'notice' AND text LIKE 'Melanie%changed%'").get(sean.id);
    assert.match(fyi.text, /Tap to see what changed/);
    const id = db._raw().prepare('SELECT max(id) id FROM plan_changes WHERE event_id = ? AND actor_id = ?').get(e, mel.id).id;
    const c = await cookieFor(sean);
    const r = await request.get(`/api/events/${e}/changed/${id}`).set('Cookie', c);
    assert.equal(r.status, 200);
    assert.equal(r.body.who, 'Melanie');
    const notes = r.body.fields.find((f) => f.field === 'notes');
    assert.deepEqual([notes.before, notes.after], ['Friday: spa', 'Friday: Massages for 4 at Renaissance Hotel 10am']);
    assert.ok(r.body.fields.some((f) => f.field === 'venue_name'), 'everything changed in that moment');
    assert.equal((await request.get(`/api/events/${e}/changed/${id}`).set('Cookie', await cookieFor(stranger))).status, 403);
  });
  test('the page shows it once, highlighted, and forgets it', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../public/app/events.html'), 'utf8');
    assert.ok(html.includes("if (summaryId && /^\\d+$/.test(q.get('changed') || '')) showChange(summaryId, q.get('changed'));"));
    assert.ok(html.includes("'bfly-seen-change-' + changeId") && html.includes('✨ What changed') && html.includes("history.replaceState(null, '', location.pathname + '?event=' + encodeURIComponent(eventId));"));
  });
});
