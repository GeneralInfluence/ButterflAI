/**
 * The ripple matrix: for every kind of plan change (ripples.TYPES) and every part of the
 * system, either the reaction that handles it ('reaction:<name>') or why nothing needs to
 * happen. tests/integration/ripples.test.js fails when a cell is missing, names a reaction
 * that doesn't listen for that change, or a reaction listens for a change the matrix
 * doesn't send it — so adding a kind of change, or a part of the system, forces the
 * question "what does this ripple into?" (owner, 2026-10-13).
 *
 * Common reasons, reused below:
 */
'use strict';

const LIVE = 'Reads plan.js live (Home, calendar, Events, chat pills, the agent\'s snapshot) — nothing stored to update.';
const LOG = 'planops writes plan_changes in the same call.';
const NA = (why) => `Not affected: ${why}`;

/** The parts of the system a change can ripple into. */
const PARTS = {
  guest_list:   'Who is invited, in, out (event_invitations)',
  creating:     "The plan's to-do list (event_todos)",
  plan_circle:  'Which agents talk as insiders about this plan',
  avoid_lists:  'People in the plan who avoid someone in it',
  host:         'Telling the host',
  deferrers:    'People who go with whatever others decide',
  screens:      'Home, calendar, Events, chat pills, the agent\'s view',
  chat:         "The plan's discussion (messages filed under it)",
  calendar:     'Google Calendar entries (calmirror.js; Apple not mirrored yet)',
  change_log:   'plan_changes (who changed what)',
  parts:        'Plans that are part of this one (social_events.parent_id) — they have its people',
};
const PARTS_SAME = NA('a part keeps its own details; only who is in follows the bigger plan.');

const CIRCLE_LIVE = 'Computed live from the guest list (plan.inCircle) — nothing stored.';
const CAL = 'reaction:calendar';

const MATRIX = {
  created: {
    guest_list: 'planops.create invites through planops.invite, which records guest_added for each person.',
    creating: NA('a new plan has no to-dos; the agent suggests some (manage_todos).'),
    plan_circle: CIRCLE_LIVE, avoid_lists: 'Checked per guest when invited (guest_added).',
    host: NA('the host made it.'), deferrers: NA('nobody has deferred on a new plan.'),
    screens: LIVE, chat: 'The turn that created it is filed under it (topics.tagTurn).', calendar: CAL, change_log: LOG,
    parts: 'planops.create with part_of invites everyone in the bigger plan.',
  },
  renamed: {
    guest_list: NA('names don\'t change who is in.'), creating: NA('to-dos belong to the plan, not its name.'),
    plan_circle: CIRCLE_LIVE, avoid_lists: NA('nobody new is involved.'), host: 'reaction:co-creator-fyi',
    deferrers: NA('only date, place, lock-in and cancellation are worth an FYI (owner, 2026-10-09).'),
    screens: LIVE, chat: 'Pills show the current name (plan.js).', calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
  dates_changed: {
    guest_list: NA('answers stand; guests can change theirs.'), creating: NA('to-dos aren\'t dated.'),
    plan_circle: CIRCLE_LIVE, avoid_lists: NA('nobody new is involved.'), host: 'reaction:co-creator-fyi',
    deferrers: 'reaction:deferrers-fyi', screens: LIVE, chat: NA('no message needed; the plan shows the new dates.'),
    calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
  place_changed: {
    guest_list: NA('answers stand.'), creating: NA('to-dos stay.'), plan_circle: CIRCLE_LIVE,
    avoid_lists: NA('nobody new is involved.'), host: 'reaction:co-creator-fyi', deferrers: 'reaction:deferrers-fyi',
    screens: LIVE, chat: NA('the plan shows the new place.'), calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
  details_changed: {
    guest_list: NA('answers stand.'), creating: NA('to-dos stay.'), plan_circle: CIRCLE_LIVE,
    avoid_lists: NA('nobody new is involved.'), host: 'reaction:co-creator-fyi',
    deferrers: NA('notes, kind, group and visibility aren\'t worth an FYI.'), screens: LIVE,
    chat: NA('the plan shows the change.'), calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
  locked_in: {
    guest_list: NA('interested guests stay in; the plan now reads "confirmed".'), creating: NA('to-dos stay.'),
    plan_circle: CIRCLE_LIVE, avoid_lists: NA('nobody new is involved.'), host: 'reaction:co-creator-fyi',
    deferrers: 'reaction:deferrers-fyi', screens: LIVE, chat: NA('the plan shows it.'), calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
  cancelled: {
    guest_list: NA('kept for history; the plan reads "cancelled" and leaves every screen.'), creating: NA('kept with the plan.'),
    plan_circle: 'Nobody is an insider of a cancelled plan (plan.inCircle checks status).', avoid_lists: NA('nobody is going.'),
    host: NA('the host cancelled it.'), deferrers: 'reaction:deferrers-fyi', screens: LIVE,
    chat: NA('the discussion stays readable.'), calendar: CAL, change_log: LOG,
    parts: NA('a cancelled plan\'s parts stay as they are; each part\'s host decides about theirs.'),
  },
  merged: {
    guest_list: 'mergeEvents moves invitations (the more committed answer wins), in the same transaction.',
    creating: 'mergeEvents moves open Creating items (an item repeating one already there stays behind).', plan_circle: CIRCLE_LIVE,
    avoid_lists: NA('the same people, now in one plan (owner asked first).'), host: 'reaction:co-creator-fyi',
    deferrers: 'mergeEvents carries deferrals over.', screens: LIVE,
    chat: 'mergeEvents moves the discussion, agent threads and mentions.', calendar: CAL, change_log: LOG,
    parts: NA('parts point at the plan they were part of; a merge leaves them as they are.'),
  },
  guest_added: {
    guest_list: 'The invite itself.', creating: 'reaction:creating',
    plan_circle: NA('invited isn\'t inside yet; saying yes is (guest_responded).'),
    avoid_lists: 'Inside the invite (multiparty.inviteContacts — the privacy choke point): anyone in it who avoids the new guest is asked; the new guest\'s own list declines or asks.',
    host: NA('the host invited them.'), deferrers: NA('a new guest changes nothing they deferred on.'),
    screens: LIVE, chat: 'Group plans: one catch-up to the newcomer (groups.js).', calendar: CAL, change_log: LOG,
    parts: 'reaction:parts',
  },
  guest_responded: {
    guest_list: 'The answer itself.', creating: 'reaction:creating', plan_circle: CIRCLE_LIVE,
    avoid_lists: 'reaction:avoid-heads-up', host: 'reaction:host-notice',
    deferrers: NA('one person\'s answer isn\'t a change to the plan.'), screens: LIVE,
    chat: 'The host\'s chat gets the system line (host-notice).', calendar: CAL, change_log: LOG,
    parts: NA('saying yes or no to the bigger plan doesn\'t change who is in its parts (removal does).'),
  },
  guest_removed: {
    guest_list: 'The removal itself.', creating: 'reaction:creating', plan_circle: CIRCLE_LIVE,
    avoid_lists: NA('someone leaving can\'t make it worse for anyone.'), host: NA('the host removed them.'),
    deferrers: NA('not a change to the plan itself.'), screens: LIVE,
    chat: NA('the removed person isn\'t told (the host chose it; their invite just disappears).'), calendar: CAL, change_log: LOG,
    parts: 'reaction:parts',
  },
  deferred: {
    guest_list: 'Deferring marks them in — recorded as guest_responded accepted in the same batch.',
    creating: NA('deferring changes no to-do.'), plan_circle: 'In the circle as someone who is in (accepted).',
    avoid_lists: 'Via the guest_responded in the same batch.',
    host: 'The host\'s card shows "whatever you & Melanie decide" (plan.js, live).',
    deferrers: 'Open questions about this plan are answered with the fixed line at once (planops.defer).',
    screens: LIVE, chat: NA('nothing to say; that is the point of deferring.'),
    calendar: 'Via the guest_responded in the same batch (their status is what the calendar shows).', change_log: LOG,
    parts: PARTS_SAME,
  },
  invite_hidden: {
    guest_list: NA('hiding is personal; their answer stands.'), creating: NA('nothing changes.'),
    plan_circle: NA('hiding doesn\'t change who is in.'), avoid_lists: NA('nothing changes.'),
    host: NA('it is private to the guest.'), deferrers: NA('nothing changes.'),
    screens: 'plan.js leaves hidden invites out for that guest.', chat: NA('nothing to say.'), calendar: CAL, change_log: LOG,
    parts: PARTS_SAME,
  },
};

module.exports = { PARTS, MATRIX };
