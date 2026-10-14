/**
 * feedbackcase.js — every 🐛 becomes a test (owner, 2026-10-13: "each caterpillar should
 * become a new test, so something about the event would have to be saved for that test").
 *
 * When someone sends feedback, a *case* is saved with it: the plan as they saw it (plan.js),
 * its change history (plan_changes), what rippled (plan_ripples), and the recent conversation
 * about it — enough to rebuild the situation in a test after the plan itself is long gone
 * (cancelled plans are deleted after 90 days).
 *
 * Anonymized when saved, because cases become test fixtures in the repo: every person is
 * "Person A", "Person B"… (the person who sent it is "Viewer"), phone numbers, emails, ids and
 * links are removed, and street addresses dropped. Nothing private-mode is included (those
 * turns are placeholders already). tests/integration/feedback-cases.test.js replays every
 * fixture in tests/fixtures/feedback/.
 */
'use strict';

const db = require('./db');

const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_RE = /https?:\/\/\S+/g;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the name → alias map and a function that scrubs any text with it. */
function anonymizer(viewer, eventId) {
  const names = new Map();   // lowercased name → alias
  // Single, obviously-not-real first names: plans show people by first name, and the
  // replay rebuilds people from these.
  const STANDINS = ['Aspen', 'Birch', 'Cedar', 'Dale', 'Elm', 'Fern', 'Grove', 'Hazel', 'Iris', 'Juniper', 'Kestrel', 'Linden', 'Maple',
    'Nova', 'Oak', 'Pine', 'Quill', 'Reed', 'Sage', 'Teal', 'Umber', 'Vale', 'Wren', 'Yarrow', 'Zinnia'];
  let i = 0;
  const add = (full, alias) => {
    const parts = String(full || '').trim().split(/\s+/).filter((p) => p.length > 1);
    if (!parts.length) return;
    const a = alias || STANDINS[i++ % STANDINS.length];
    for (const n of [parts.join(' '), ...parts]) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), a);
    return a;
  };
  add(viewer?.name, 'Viewer');
  if (viewer?.nickname) add(viewer.nickname, 'Viewer');
  if (eventId) {
    const e = db._raw().prepare('SELECT host_user_id FROM social_events WHERE id = ?').get(eventId);
    const host = e && db.getUser(e.host_user_id);
    if (host && host.id !== viewer?.id) add(host.name);
    for (const r of db._raw().prepare(`SELECT c.name, c.nickname, c.also_known_as, u.name AS uname FROM event_invitations ei JOIN contacts c ON c.id = ei.contact_id
      LEFT JOIN users u ON u.phone = c.phone WHERE ei.event_id = ?`).all(eventId)) {
      const a = add(r.uname || r.name);
      for (const extra of [r.name, r.nickname, ...String(r.also_known_as || '').split(/[,;]/)]) if (extra) add(extra, a);
    }
  }
  // Longest names first so "Allie McLaine" wins over "Allie".
  const ordered = [...names.entries()].sort((a, b) => b[0].length - a[0].length);
  const scrub = (v) => {
    if (v == null) return v;
    let s = String(v).replace(URL_RE, '<link>').replace(EMAIL, '<email>').replace(UUID, '<id>').replace(PHONE, '<phone>');
    for (const [n, a] of ordered) s = s.replace(new RegExp(`\\b${escRe(n)}(?:['’]s)?\\b`, 'gi'), (m) => (/['’]s$/i.test(m) ? `${a}'s` : a));
    return s;
  };
  return { scrub, aliases: [...new Set(names.values())] };
}

/** Which plan is this feedback about? The screen's event, else the chat message's. */
function eventFor(userId, { state, agentMessage }) {
  const fromState = state && (state.event_id || state.plan?.id);
  if (fromState) return String(fromState);
  if (agentMessage) {
    const r = db._raw().prepare(`SELECT event_id FROM conversation_history WHERE user_id = ? AND role = 'assistant' AND text = ? AND event_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(userId, String(agentMessage));
    if (r) return r.event_id;
  }
  return null;
}

/**
 * Build the anonymized case for a piece of feedback. Returns a plain object (stored as
 * feedback.case_json; also the test fixture).
 */
function build(userId, { state = null, agentMessage = null, note = null, page = null } = {}) {
  const viewer = db.getUser(userId);
  const eventId = eventFor(userId, { state, agentMessage });
  const { scrub, aliases } = anonymizer(viewer, eventId);
  const out = { version: 1, reported: new Date().toISOString().slice(0, 10), page: page || state?.screen || null, note: scrub(note), flagged_reply: scrub(agentMessage), people: aliases };

  if (eventId) {
    const p = require('./plan').planFor(eventId, userId);
    const e = db._raw().prepare('SELECT created_at FROM social_events WHERE id = ?').get(eventId);
    if (p) {
      out.plan = {
        title: scrub(p.title), what: p.what, place: p.place ? scrub(p.place) : null, notes: scrub(p.notes),
        role: p.role, host: p.host.is_you ? 'Viewer' : scrub(p.host.name), tentative: p.tentative, stage: p.stage,
        dates: { kind: p.dates.kind, proposals: p.dates.proposals, label: p.dates.label, days: p.days },
        group: p.group ? scrub(p.group.name) : null,
        people: p.people.map((x) => ({ name: scrub(x.name), status: x.status, deferring_to: x.deferring_to.map(scrub) })),
        invitation: p.invitation ? { status: p.invitation.status, must_ask: p.invitation.must_ask } : null,
        asked: p.asked.map(scrub), creating: p.creating, next: p.next,
        answers: (p.answers || []).map((a) => ({ who: scrub(a.who), topic: a.topic, answer: scrub(a.answer) })),
      };
      const t0 = e?.created_at || 0;
      out.history = db._raw().prepare('SELECT field, old_value, new_value, via, created_at FROM plan_changes WHERE event_id = ? ORDER BY id').all(eventId)
        .map((h) => ({ at: h.created_at - t0, field: h.field, via: h.via, from: scrub(h.old_value), to: scrub(h.new_value) }));
      out.ripples = db._raw().prepare('SELECT type, via, data, results, last_error, created_at FROM plan_ripples WHERE event_id = ? ORDER BY id').all(eventId)
        .map((r) => {
          let data = {}; try { data = JSON.parse(r.data || '{}'); } catch (_) {}
          const keep = {};
          for (const k of ['status', 'previous', 'by', 'source', 'name', 'to', 'undo', 'fields', 'changed', 'date_tbd', 'venue_name']) if (data[k] !== undefined) keep[k] = Array.isArray(data[k]) ? data[k].map(scrub) : typeof data[k] === 'string' ? scrub(data[k]) : data[k];
          return { at: r.created_at - t0, type: r.type, via: r.via, data: keep, results: (() => { try { return JSON.parse(r.results || 'null'); } catch (_) { return null; } })(), error: r.last_error ? scrub(r.last_error) : null };
        });
    }
  }
  // The conversation leading up to it: the plan's discussion if there is one, else recent.
  const turns = db._raw().prepare(`SELECT role, text, kind, created_at FROM conversation_history WHERE user_id = ?
    ${eventId ? 'AND event_id = ?' : ''} AND private_ct IS NULL ORDER BY created_at DESC LIMIT 16`).all(...(eventId ? [userId, eventId] : [userId])).reverse();
  out.conversation = turns.map((t) => ({ role: t.role, kind: t.kind || undefined, text: scrub(String(t.text).slice(0, 1500)) }));
  return out;
}

module.exports = { build, anonymizer, eventFor };
