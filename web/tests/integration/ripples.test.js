/**
 * ripples.test.js — every change to a plan cascades through the system (owner, 2026-10-13:
 * "every change to an event should cascade through the entire system").
 *
 * An RSVP updates the guest list, and also: the plan's Creating list, which agents talk as
 * insiders (the plan circle), and a private heads-up for anyone still deciding who avoids
 * the person who said yes. Plus the structure that keeps it that way: only planops (and
 * the storage layer it calls) writes plans, and the matrix names a reaction — or a reason
 * — for every kind of change against every part of the system.
 */
'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'ripples-test';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
const texts = [];
sms._setClient({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } });

const { app } = require('../../server');
const request = supertest(app);
const db = require('../../db');
const agent = require('../../agent');
const avoid = require('../../avoid');
const planops = require('../../planops');
const plan = require('../../plan');
const todos = require('../../todos');
const ripples = require('../../ripples');
const { PARTS, MATRIX } = require('../../ripples/matrix');

let n = 0;
function mkUser(name) {
  const phone = `+1202558${String(6000 + n++).padStart(4, '0')}`;
  db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state, timezone) VALUES (?, ?, ?, 'complete', 'America/Los_Angeles')`).run(uuidv4(), name, phone);
  db.writeConsent(phone, 'INVITE_PAGE');
  return db.getUserByPhone(phone);
}
const knows = (owner, other) => db.upsertContact({ invited_by_user_id: owner.id, name: other.name, phone: other.phone, tier: 1 });
const invOf = (eventId, u) => db._raw().prepare(`SELECT ei.* FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id WHERE ei.event_id = ? AND c.phone = ?`).get(eventId, u.phone);
const notices = (u) => db._raw().prepare("SELECT text, event_id FROM conversation_history WHERE user_id = ? AND kind = 'notice' ORDER BY rowid").all(u.id);
const allText = (u) => db._raw().prepare('SELECT text FROM conversation_history WHERE user_id = ?').all(u.id).map((r) => r.text).join('\n')
  + db._raw().prepare('SELECT text FROM inbound_messages WHERE from_id = ?').all(u.id).map((r) => r.text).join('\n');
async function planWith(host, guests, title) {
  const r = await planops.create(host.id, { title, activity_type: 'trip', tentative: true,
    when: undefined, scheduled_at: new Date(Date.now() + 20 * 86400e3).toISOString(), contact_ids: guests.map((g) => knows(host, g)) });
  return r.eventId;
}
async function cookieFor(u) {
  await request.post('/auth/otp/send').send({ phone: u.phone });
  const { code } = db._raw().prepare('SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(u.phone);
  return (await request.post('/auth/otp/verify').send({ phone: u.phone, code })).headers['set-cookie'][0];
}

describe('one door: only planops changes plans', () => {
  const root = path.join(__dirname, '../..');
  const files = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', 'public', 'tools', 'scripts'].includes(f.name)) continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
    }
  })(root);
  const rel = (p) => path.relative(root, p);

  test('only planops.js and multiparty.js (the storage layer) write plans or invitations', () => {
    const writers = files.filter((f) => /(INSERT INTO|UPDATE|DELETE FROM)\s+(social_events|event_invitations)\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    assert.deepEqual(writers, ['multiparty.js', 'planops.js']);
  });

  test("multiparty's writing functions are called only by planops", () => {
    for (const fn of ['createEvent', 'inviteContacts', 'mergeEvents', 'dismissInvitation', '_publicRsvpWrite']) {
      const callers = files.filter((f) => new RegExp(`multiparty\\.${fn}\\(`).test(fs.readFileSync(f, 'utf8'))).map(rel);
      assert.deepEqual(callers.filter((c) => c !== 'planops.js'), [], fn);
    }
  });
});

describe('the matrix: every change × every part of the system is decided', () => {
  const names = new Map(ripples.REACTIONS.map((r) => [r.name, r]));
  test('every kind of change has a cell for every part', () => {
    assert.deepEqual(Object.keys(MATRIX).sort(), Object.keys(ripples.TYPES).sort());
    for (const [type, row] of Object.entries(MATRIX)) {
      assert.deepEqual(Object.keys(row).sort(), Object.keys(PARTS).sort(), type);
      for (const [part, cell] of Object.entries(row)) assert.ok(typeof cell === 'string' && cell.length > 8, `${type} × ${part}`);
    }
  });
  test('a reaction named in the matrix exists and listens for that change; every listener is in the matrix', () => {
    for (const [type, row] of Object.entries(MATRIX)) {
      for (const cell of Object.values(row)) {
        const m = /^reaction:(.+)$/.exec(cell);
        if (!m) continue;
        assert.ok(names.has(m[1]), `unknown reaction ${m[1]}`);
        assert.ok(names.get(m[1]).on.includes(type), `${m[1]} doesn't listen for ${type}`);
      }
    }
    for (const r of ripples.REACTIONS) {
      for (const type of r.on) assert.ok(Object.values(MATRIX[type]).includes(`reaction:${r.name}`), `${r.name} on ${type} not in the matrix`);
    }
  });
  test('an unknown kind of change is refused', () => {
    assert.throws(() => ripples.emit([{ type: 'something_new', event_id: 'x' }]), /Unknown plan change type/);
  });
});

describe('an RSVP ripples', () => {
  test('from the app: guest list, a recorded ripple, and the host is told', async () => {
    const sean = mkUser('Sean Rip'); const allie = mkUser('Allie Rip');
    const eventId = await planWith(sean, [allie], 'Rip Dinner');
    const res = await request.post('/api/events/rsvp').set('Cookie', await cookieFor(allie)).send({ invitation_id: invOf(eventId, allie).id, status: 'accepted' });
    assert.equal(res.status, 200);
    assert.equal(invOf(eventId, allie).status, 'accepted');
    const rip = ripples.history(eventId).find((r) => r.type === 'guest_responded');
    assert.ok(rip.done_at, 'ran');
    assert.equal(rip.results['host-notice'], 1);
    assert.match(allText(sean), /Allie Rip accepted the invite to Rip Dinner/);
    assert.match(allText(sean), /\[Agent-to-Agent RSVP\] ✅/, "the host's agent is asked to pass it on");
  });

  test("someone else's invitation can't be answered", async () => {
    const sean = mkUser('Sean Auth'); const allie = mkUser('Allie Auth'); const bam = mkUser('Bam Auth');
    const eventId = await planWith(sean, [allie], 'Auth Plan');
    const res = await request.post('/api/events/rsvp').set('Cookie', await cookieFor(bam)).send({ invitation_id: invOf(eventId, allie).id, status: 'declined' });
    assert.equal(res.status, 403);
    assert.equal(invOf(eventId, allie).status, 'invited');
  });

  test('a no frees their to-dos and tells the host which ones', async () => {
    const sean = mkUser('Sean Todo'); const allie = mkUser('Allie Todo');
    const eventId = await planWith(sean, [allie], 'Todo Trip');
    todos.add(sean.id, eventId, { text: 'Book the campsite', assignee: 'Allie' });
    planops.respond(invOf(eventId, allie).id, 'declined', { by: 'guest', phone: allie.phone });
    const t = db._raw().prepare('SELECT assignee_phone FROM event_todos WHERE event_id = ?').get(eventId);
    assert.equal(t.assignee_phone, null, 'back to anyone');
    assert.match(notices(sean).at(-1).text, /Allie can't make it to Todo Trip, so “Book the campsite” is open again/);
  });

  test('the host removing someone frees their to-dos too, through the change path', async () => {
    const sean = mkUser('Sean Rm'); const allie = mkUser('Allie Rm');
    const eventId = await planWith(sean, [allie], 'Rm Plan');
    todos.add(sean.id, eventId, { text: 'Bring the cooler', assignee: 'Allie' });
    const res = await request.delete(`/api/events/${eventId}/invite/${invOf(eventId, allie).id}`).set('Cookie', await cookieFor(sean));
    assert.equal(res.status, 200);
    assert.equal(invOf(eventId, allie), undefined);
    assert.ok(ripples.history(eventId).some((r) => r.type === 'guest_removed'));
    assert.equal(db._raw().prepare('SELECT assignee_phone FROM event_todos WHERE event_id = ?').get(eventId).assignee_phone, null);
  });

  test('the same answer again ripples nothing (only clears a pause)', async () => {
    const sean = mkUser('Sean Same'); const allie = mkUser('Allie Same');
    const eventId = await planWith(sean, [allie], 'Same Plan');
    planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    const before = ripples.history(eventId).length;
    const r = planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    assert.equal(r.unchanged, true);
    assert.equal(ripples.history(eventId).length, before);
  });
});

describe('avoid-list heads-up when someone says yes', () => {
  test('anyone still deciding who avoids them is told privately and paused; nobody else learns why', async () => {
    const sean = mkUser('Sean Host'); const allie = mkUser('Allie Avoids'); const julie = mkUser('Julie Yes');
    avoid.addAvoid(allie.id, knows(allie, julie));
    const eventId = await planWith(sean, [allie, julie], 'Heads Up Weekend');
    db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 0').run();   // start clean (the invite-time check already asked)
    planops.respond(invOf(eventId, julie).id, 'accepted', { by: 'guest', phone: julie.phone });

    const n0 = notices(allie).at(-1);
    assert.match(n0.text, /Heads-up: Julie said yes to Heads Up Weekend\. Still going\?/);
    assert.equal(n0.event_id, eventId);
    assert.doesNotMatch(n0.text, /avoid/i, 'says who, never why');
    assert.equal(invOf(eventId, allie).needs_owner_decision, 1, "paused — her agent won't answer for her");
    const p = plan.planFor(eventId, allie.id);
    assert.equal(p.invitation.must_ask, true);
    assert.equal(texts.filter((t) => t.to === allie.phone).length, 0, 'in the app, never a text');
    assert.doesNotMatch(allText(julie) + allText(sean), /Allie.*(avoid|heads-up)|heads-up/i, 'Julie and the host learn nothing');

    // Allie answers: the pause clears.
    planops.respond(invOf(eventId, allie).id, 'declined', { by: 'guest', phone: allie.phone });
    assert.equal(invOf(eventId, allie).needs_owner_decision, 0);
  });

  test('an interested guest is asked "Still going?" on Home and on the plan', async () => {
    const sean = mkUser('Sean Two'); const allie = mkUser('Allie Two'); const julie = mkUser('Julie Two');
    avoid.addAvoid(allie.id, knows(allie, julie));
    const eventId = await planWith(sean, [allie], 'Still Going Trip');
    planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    await planops.invite(sean.id, eventId, [knows(sean, julie)]);
    db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 0 WHERE event_id = ?').run(eventId);
    planops.respond(invOf(eventId, julie).id, 'accepted', { by: 'guest', phone: julie.phone });
    assert.equal(plan.planFor(eventId, allie.id).next, 'Still going? Tap to answer');
    const item = require('../../plans').feedFor(allie.id).items.find((i) => i.event_id === eventId);
    assert.equal(item.action, 'Still going? Tap to answer');
    // "Still going" = yes again: unchanged answer, pause cleared, no new ripples to others.
    const r = planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    assert.equal(r.unchanged, true);
    assert.equal(plan.planFor(eventId, allie.id).next, null);
  });
});

describe('the plan circle: insiders talk differently', () => {
  test('host and people who said yes are insiders; invited-only or cancelled are not', async () => {
    const sean = mkUser('Sean Circle'); const allie = mkUser('Allie Circle'); const bam = mkUser('Bam Circle');
    const eventId = await planWith(sean, [allie, bam], 'Circle Plan');
    planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    assert.equal(plan.inCircle(eventId, sean.id, allie.id), true);
    assert.equal(plan.inCircle(eventId, sean.id, bam.id), false, 'invited, not in yet');
    planops.update(sean.id, eventId, { cancel: true });
    assert.equal(plan.inCircle(eventId, sean.id, allie.id), false);
  });

  test("an insider's question gets the plan; an outsider's gets only the outside rules", async () => {
    const sean = mkUser('Sean Ask'); const allie = mkUser('Allie Ask'); const bam = mkUser('Bam Ask');
    const eventId = await planWith(sean, [allie, bam], 'Grover Circle');
    planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    db._raw().prepare('DELETE FROM inbound_messages').run();
    const ask = (to) => agent.executeTool('message_agent', { contact_id: knows(sean, to), topic: 'coordination', event_id: eventId, message: 'Can you bring the tent?' }, sean.id, sean.phone);
    await ask(allie); await ask(bam);
    const systems = [];
    agent._setAnthropic({ messages: { create: async (req) => { systems.push(JSON.stringify(req.system)); return { id: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '' }] }; } } });
    await agent.tick(); await agent.tick();
    const toAllie = systems.find((s) => s.includes('Allie Ask'));
    const toBam = systems.find((s) => s.includes('Bam Ask'));
    assert.match(toAllie, /This question is from INSIDE a plan/);
    assert.match(toAllie, /Grover Circle/);
    assert.match(toBam, /This question is from OUTSIDE your user's plans/);
    assert.doesNotMatch(toBam, /INSIDE a plan \(plan circle\)/);
  });

  test('the system prompt explains the plan circle', () => {
    assert.match(agent.buildSystemPrompt({ name: 'X', phone: '+1' }, ''), /PLAN CIRCLE: agents of people who are in the same plan/);
  });
});

describe('the other ways in also ripple', () => {
  test('deferring marks them in and ripples (host told, heads-up checked)', async () => {
    const sean = mkUser('Sean Def'); const allie = mkUser('Allie Def');
    const eventId = await planWith(sean, [allie], 'Def Plan');
    const r = await agent.executeTool('defer_on_plan', { invitation_id: invOf(eventId, allie).id, defer_to: ['Sean'] }, allie.id, allie.phone);
    assert.equal(r.ok, true);
    const types = ripples.history(eventId).map((x) => x.type);
    assert.ok(types.includes('deferred') && types.includes('guest_responded'));
    assert.match(allText(sean), /Allie Def accepted the invite to Def Plan/);
  });

  test('a text reply from someone without ButterflAI goes through the change path', async () => {
    const sean = mkUser('Sean Sms');
    const eventId = await planWith(sean, [], 'Sms Plan');
    const cid = db.upsertContact({ invited_by_user_id: sean.id, name: 'Nonuser Pat', phone: '+12025589999', tier: 1 });
    db.writeConsent('+12025589999', 'INVITE_PAGE');
    await planops.invite(sean.id, eventId, [cid]);
    // The real text entry point (the classifier falls back to keywords without a model).
    const reply = await require('../../multiparty').handleRsvpReply('+12025589999', 'yes');
    assert.match(reply, /You're in/);
    assert.ok(ripples.history(eventId).some((r) => r.type === 'guest_responded' && r.via === 'sms'));
    assert.match(allText(sean), /Nonuser Pat accepted the invite to Sms Plan/);
  });

  test('hiding an invite is recorded', async () => {
    const sean = mkUser('Sean Hide'); const allie = mkUser('Allie Hide');
    const eventId = await planWith(sean, [allie], 'Hide Plan');
    const res = await request.post(`/api/events/invitations/${invOf(eventId, allie).id}/dismiss`).set('Cookie', await cookieFor(allie));
    assert.equal(res.status, 200);
    assert.ok(ripples.history(eventId).some((r) => r.type === 'invite_hidden'));
  });

  test('a failed reaction is retried from the coord loop', async () => {
    const sean = mkUser('Sean Retry'); const allie = mkUser('Allie Retry');
    const eventId = await planWith(sean, [allie], 'Retry Plan');
    const r = ripples.REACTIONS.find((x) => x.name === 'host-notice');
    const real = r.run; let calls = 0;
    r.run = () => { calls++; throw new Error('boom'); };
    planops.respond(invOf(eventId, allie).id, 'accepted', { by: 'guest', phone: allie.phone });
    const row = ripples.history(eventId).find((x) => x.type === 'guest_responded');
    assert.equal(row.done_at, null);
    assert.match(row.last_error, /host-notice: boom/);
    r.run = real;
    db._raw().prepare('UPDATE plan_ripples SET created_at = created_at - 60 WHERE id = ?').run(row.id);
    assert.equal(ripples.retryPending(), 1);
    const after = ripples.history(eventId).find((x) => x.type === 'guest_responded');
    assert.ok(after.done_at);
    assert.equal(after.results['host-notice'], 1);
    assert.equal(after.results['avoid-heads-up'], 0, 'reactions that already ran are not run twice');
    assert.equal(calls, 1);
  });
});

describe('existing plans catch up (retro)', () => {
  const retro = require('../../retro');
  const task = (id) => retro.TASKS.find((t) => t.id === id);
  test("to-dos still assigned to someone who's out are freed", async () => {
    const sean = mkUser('Sean Old'); const allie = mkUser('Allie Old');
    const eventId = await planWith(sean, [allie], 'Old Todo Plan');
    todos.add(sean.id, eventId, { text: 'Old chore', assignee: 'Allie' });
    db._raw().prepare("UPDATE event_invitations SET status = 'declined' WHERE event_id = ?").run(eventId);   // declined before ripples existed
    assert.equal(task('2026-10-13-free-todos-of-guests-who-are-out').run(sean), 'freed 1');
    assert.equal(db._raw().prepare('SELECT assignee_phone FROM event_todos WHERE event_id = ?').get(eventId).assignee_phone, null);
  });
  test('someone on your avoid list who already said yes: heads-up now, once', async () => {
    const sean = mkUser('Sean Old2'); const allie = mkUser('Allie Old2'); const julie = mkUser('Julie Old2');
    const eventId = await planWith(sean, [allie, julie], 'Old Heads Up');
    db._raw().prepare("UPDATE event_invitations SET status = 'accepted', needs_owner_decision = 0 WHERE id = ?").run(invOf(eventId, julie).id);
    db._raw().prepare('UPDATE event_invitations SET needs_owner_decision = 0 WHERE id = ?').run(invOf(eventId, allie).id);
    avoid.addAvoid(allie.id, knows(allie, julie));
    const t = task('2026-10-13-avoid-heads-up-for-existing-yes');
    assert.equal(t.kind, 'propose');
    assert.equal(t.run(allie), 'told 1');
    assert.match(notices(allie).at(-1).text, /Julie said yes to Old Heads Up/);
    assert.equal(t.run(allie), 'told 0', 'already paused — not told twice');
  });
});
