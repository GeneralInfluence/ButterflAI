/**
 * plan-nav.js — the same top on Chat, Creating and Events (owner, 2026-10-20: "keep this pills
 * interface for the creating tab, the chat tab, and the events or calendar tab … so a person
 * knows how to get back and forth very easily").
 *
 *   Row 1 (pills):    All · <a pill per plan>          — which plan; you stay on the same tab
 *   Row 2 (switcher): [cyborg butterfly] ButterflAI · ✨ Creating · 📅 Details — the same plan, another view
 *   (the cyborg-butterfly thumbnail + "ButterflAI", not "Chat" — Sean's pick, 2026-10-21: you're talking to your AI, not chatting with people — Sean, 🐛 #76)
 *                     (on All: ButterflAI · ✨ Creating · 📅 Calendar)
 *   Named "myButterflAI" (Sean, 🐛 #86, 2026-10-21 — it's your own ButterflAI).
 *
 * PlanNav.pills(el, { page, eventId, discussions })  — Creating and Events (Chat has its own
 *   pills with General and rename, in the same style).
 * PlanNav.modes(el, { page, eventId, day })           — all three.
 */
(function () {
  const BASE = { chat: '/app/chat', creating: '/app/creating', events: '/app/events' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const real = (id) => id && id !== 'general';
  const href = (page, eventId, day) => BASE[page] + (real(eventId) ? '?event=' + encodeURIComponent(eventId) + (day ? '&day=' + day : '') : '');

  // Past plans drop out of the pills by themselves (🐛 #92 — Sean: "How do I remove this past event from the pills …
  // I'd like to have the things that are in the past kind of automatically not be my future plans"). They're behind one
  // "🕘 Past" pill; the one you're looking at keeps its pill.
  const PAST_KEY = 'bfly-pills-past';
  const showPast = () => { try { return localStorage.getItem(PAST_KEY) === '1'; } catch (_) { return false; } };
  function visible(discussions, eventId) {
    const all = discussions || [];
    const past = all.filter((d) => d.stage === 'past' && d.event_id !== eventId);
    return { shown: showPast() ? all : all.filter((d) => !past.includes(d)), past };
  }
  function pastPill(past) {
    if (!past.length) return '';
    return `<a class="tpill tpill-past" href="#" onclick="PlanNav.togglePast(event)">${showPast() ? '🕘 Hide past' : `🕘 Past · ${past.length}`}</a>`;
  }
  function togglePast(e) {
    e.preventDefault();
    try { localStorage.setItem(PAST_KEY, showPast() ? '0' : '1'); } catch (_) {}
    location.reload();
  }
  const pillHtml = (page, d, eventId) => `<a class="tpill${d.event_id === eventId ? ' active' : ''}${d.stage === 'past' ? ' past' : ''}" href="${href(page, d.event_id)}" title="${esc(d.title)}">`
    + `<span>${d.stage === 'past' ? '🕘' : d.tentative ? '🗓️' : '📅'} ${esc(d.title)}</span>${d.tentative && d.stage !== 'past' ? '<span class="tent">tentative</span>' : ''}</a>`;

  function pills(el, { page, eventId, discussions }) {
    el.classList.add('plan-pills');
    const v = visible(discussions, eventId);
    el.innerHTML = `<a class="tpill${real(eventId) ? '' : ' active'}" href="${BASE[page]}">All</a>`
      + v.shown.map((d) => pillHtml(page, d, eventId)).join('') + pastPill(v.past);
    el.hidden = false;
    const a = el.querySelector('.tpill.active');
    if (a) a.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  async function modes(el, { page, eventId, day }) {
    el.classList.add('plan-modes-wrap');
    const plan = real(eventId);
    const tab = (p, label, extra = '') => `<a class="${p === page ? 'active' : ''}" href="${href(p, eventId, day)}" data-mode="${p}">${label}${extra}</a>`;
    const draw = (count, waiting) => {
      el.innerHTML = `<nav class="plan-modes" aria-label="${plan ? 'This plan' : 'Everything'}">`
        + tab('chat', '<img class="ai-ico" src="/icons/butterfly-128.png" alt="" width="20" height="20"> myButterflAI') + tab('creating', '✨ Creating', (count ? ` <span class="count">${esc(count)}</span>` : '') + (waiting ? `<span class="dot" title="${waiting} new to look at" aria-label="${waiting} new to look at"></span>` : ''))
        + tab('events', plan ? '📅 Details' : '📅 Calendar') + '</nav>';
      el.hidden = false;
    };
    draw('');
    if (!plan) return;
    try {   // Creating's progress, and what's waiting for you there
      const r = await fetch('/api/events/' + encodeURIComponent(eventId) + '/todos');
      if (!r.ok) return;
      const d = await r.json();
      const kept = d.todos.filter((t) => !t.suggested);
      const waiting = (d.suggestions || []).filter((s) => s.can_decide).length + d.todos.filter((t) => t.suggested).length;
      draw(kept.length ? `${d.progress.done}/${d.progress.total}` : '', waiting);
    } catch (_) {}
  }

  async function discussions() {
    try { return (await fetch('/api/chat/discussions').then((r) => r.json())).discussions || []; } catch (_) { return []; }
  }

  // The bottom bar's "Plans" opens wherever you last were in Plans (chat / creating / details).
  try { localStorage.setItem('bfly-plans-last', location.pathname + location.search); } catch (_) {}

  window.PlanNav = { pills, modes, discussions, href, visible, pastPill, pillHtml, togglePast };
})();
