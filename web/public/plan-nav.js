/**
 * plan-nav.js — the same top on Chat, Creating and Events (owner, 2026-10-20: "keep this pills
 * interface for the creating tab, the chat tab, and the events or calendar tab … so a person
 * knows how to get back and forth very easily").
 *
 *   Row 1 (pills):    All · <a pill per plan>          — which plan; you stay on the same tab
 *   Row 2 (switcher): 💬 Chat · ✨ Creating · 📅 Details — the same plan, another view
 *                     (on All: 💬 Chat · ✨ Creating · 📅 Calendar)
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

  function pills(el, { page, eventId, discussions }) {
    el.classList.add('plan-pills');
    el.innerHTML = `<a class="tpill${real(eventId) ? '' : ' active'}" href="${BASE[page]}">All</a>`
      + (discussions || []).map((d) => `<a class="tpill${d.event_id === eventId ? ' active' : ''}" href="${href(page, d.event_id)}" title="${esc(d.title)}">`
        + `<span>${d.tentative ? '🗓️' : '📅'} ${esc(d.title)}</span>${d.tentative ? '<span class="tent">tentative</span>' : ''}</a>`).join('');
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
        + tab('chat', '💬 Chat') + tab('creating', '✨ Creating', (count ? ` <span class="count">${esc(count)}</span>` : '') + (waiting ? `<span class="dot" title="${waiting} new to look at" aria-label="${waiting} new to look at"></span>` : ''))
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

  window.PlanNav = { pills, modes, discussions, href };
})();
