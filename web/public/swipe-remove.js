/**
 * Throw a plan away (Sean, 2026-10-24: "I want to be able to swipe left to throw an event away"; then: "the modal that
 * came up looked like some kind of error … I just wanted to archive it. There should be options when I go to remove an
 * event … I also can't swipe left on the event, which is supposed to bring up the modal").
 *
 * Anything with data-plan-id — a plan's card (Home, Events lists, a calendar day, its Details) or its pill: swipe it left,
 * or press and hold it, and a sheet in the app's own style offers what fits this plan (plan.removeOptions):
 * 📦 Archive (off your lists only — restorable) · 🙅 I'm not going · 🚫 Cancel it for everyone · Never mind.
 */
(function () {
  if (window.__bflySwipe) return; window.__bflySwipe = true;
  const css = document.createElement('style');
  css.textContent = `[data-plan-id]{touch-action:pan-y}
    #bfly-rm{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10001;display:flex;align-items:flex-end;justify-content:center}
    #bfly-rm .sheet{background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:520px;padding:18px 16px calc(16px + env(safe-area-inset-bottom));font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 -6px 30px rgba(0,0,0,.15)}
    #bfly-rm .k{font-size:13px;font-weight:700;color:#6c47ff;letter-spacing:.04em;text-transform:uppercase;margin:0 4px 4px}
    #bfly-rm .t{font-size:18px;font-weight:700;color:#1c1c1e;margin:0 4px 12px}
    #bfly-rm button{display:block;width:100%;text-align:left;border:none;background:#f2f2f7;border-radius:14px;padding:12px 14px;margin:0 0 8px;font:inherit;cursor:pointer}
    #bfly-rm button b{display:block;font-size:16px;color:#1c1c1e}
    #bfly-rm button span{display:block;font-size:13px;color:#8e8e93;margin-top:2px}
    #bfly-rm button.danger b{color:#ef4444}
    #bfly-rm button.never{background:none;text-align:center;color:#6c47ff;font-weight:600;font-size:16px;margin:4px 0 0}
    .bfly-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#1c1c1e;color:#fff;border-radius:999px;padding:10px 16px;font:500 14px -apple-system,sans-serif;z-index:10002}
    .bfly-toast button{background:none;border:none;color:#a78bfa;font:600 14px -apple-system,sans-serif;margin-left:10px;cursor:pointer}`;
  document.head.appendChild(css);
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(text, undoId) {
    const t = document.createElement('div'); t.className = 'bfly-toast';
    t.innerHTML = esc(text) + (undoId ? '<button type="button">Undo</button>' : '');
    document.body.appendChild(t);
    if (undoId) t.querySelector('button').onclick = async () => { await fetch('/api/plans/' + encodeURIComponent(undoId) + '/unarchive', { method: 'POST' }).catch(() => {}); location.reload(); };
    setTimeout(() => t.remove(), 4000);
  }

  async function openSheet(id, el) {
    if (document.getElementById('bfly-rm')) return;
    const o = await fetch('/api/plans/' + encodeURIComponent(id) + '/remove-options').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!o) return;
    const box = document.createElement('div'); box.id = 'bfly-rm';
    box.innerHTML = `<div class="sheet" role="dialog" aria-label="Remove ${esc(o.title)}"><div class="k">Remove</div><div class="t">${esc(o.title)}</div>`
      + o.options.map((x) => `<button type="button" data-a="${x.action}" class="${x.danger ? 'danger' : ''}"><b>${esc(x.label)}</b><span>${esc(x.note)}</span></button>`).join('')
      + '<button type="button" class="never" data-a="never">Never mind</button></div>';
    document.body.appendChild(box);
    const openedAt = Date.now();
    box.addEventListener('click', async (e) => {
      // Lifting the finger after a hold sends a tap that lands here — it isn't a choice (it closed the sheet at once).
      if (Date.now() - openedAt < 700) { e.preventDefault(); return; }
      if (e.target === box) { box.remove(); return; }
      const b = e.target.closest('button'); if (!b) return;
      const action = b.dataset.a;
      if (action === 'never') { box.remove(); return; }
      b.disabled = true;
      const r = await fetch('/api/plans/' + encodeURIComponent(id) + '/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then((x) => x.json()).catch(() => ({}));
      box.remove();
      if (!r.ok) { toast(r.message || 'Couldn’t do that — try again.'); return; }
      toast(action === 'archive' ? 'Archived' : action === 'cancel' ? 'Cancelled for everyone' : 'Told them you’re not going', action === 'archive' ? id : null);
      document.querySelectorAll(`[data-plan-id="${CSS.escape(id)}"]`).forEach((n) => { n.style.transition = 'opacity .2s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 220); });
      if (new URLSearchParams(location.search).get('event') === id) setTimeout(() => location.replace(location.pathname), 600);
    });
  }
  window.bflyRemovePlan = openSheet;

  // Swipe left on a card (or a pill): it slides with your finger; far enough and the sheet opens.
  let start = null, swipedAt = 0;
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[data-plan-id]');
    if (!el) return;
    start = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, horiz: null };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
    if (start.horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) start.horiz = Math.abs(dx) > Math.abs(dy) * 1.3 && dx < 0;
    if (!start.horiz) { if (start.horiz === false) start = null; return; }
    // A pill in a row that slides sideways: only a long, deliberate swipe counts, the row still scrolls.
    if (start.el.classList.contains('tpill')) { start.dx = dx; return; }
    start.dx = Math.min(0, dx);
    start.el.style.transition = 'none'; start.el.style.transform = `translateX(${Math.max(start.dx, -140)}px)`;
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!start) return;
    const { el, dx } = start; start = null;
    el.style.transition = 'transform .2s'; el.style.transform = '';
    if (dx < (el.classList.contains('tpill') ? -140 : -70)) { swipedAt = Date.now(); openSheet(el.dataset.planId, el); }
  });

  // Press and hold (pills and cards) — also with a mouse.
  // Cancelled by letting go or by moving the finger more than a little — not by stray mouse/scroll events (phones send
  // "mouseleave" for other elements around a touch, which cancelled every hold).
  let hold = null, heldAt = 0, holdAt = null, holdKind = null;   // a touch hold ignores mouse events and vice versa
  const point = (e) => (e.touches && e.touches[0]) || e;
  const holdStart = (e) => {
    const el = e.target.closest('[data-plan-id]'); if (!el) return;
    if (e.type === 'mousedown' && holdKind === 'touch' && hold) return;   // the mouse event a touch makes
    clearTimeout(hold); holdAt = { x: point(e).clientX, y: point(e).clientY }; holdKind = e.type.startsWith('touch') ? 'touch' : 'mouse';
    hold = setTimeout(() => { heldAt = Date.now(); hold = null; openSheet(el.dataset.planId, el); }, 600);
  };
  const kindOf = (e) => (e.type.startsWith('touch') ? 'touch' : 'mouse');
  const holdEnd = (e) => { if (e && kindOf(e) !== holdKind) return; clearTimeout(hold); hold = null; };
  const holdMove = (e) => { if (!hold || !holdAt || kindOf(e) !== holdKind) return; const q = point(e); if (Math.hypot(q.clientX - holdAt.x, q.clientY - holdAt.y) > 10) holdEnd(); };
  document.addEventListener('touchstart', holdStart, { passive: true });
  document.addEventListener('mousedown', holdStart);
  ['touchend', 'touchcancel', 'mouseup'].forEach((t) => document.addEventListener(t, holdEnd, { passive: true, capture: true }));
  ['touchmove', 'mousemove'].forEach((t) => document.addEventListener(t, holdMove, { passive: true, capture: true }));
  // Letting go after a hold or a swipe isn't also a tap that opens the plan.
  document.addEventListener('click', (e) => { if (Date.now() - Math.max(heldAt, swipedAt) < 1200 && e.target.closest('[data-plan-id]')) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-plan-id]')) e.preventDefault(); });
})();
