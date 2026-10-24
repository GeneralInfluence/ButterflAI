/**
 * Throw a plan away (Sean, 2026-10-24: "I can't remove past events. I want to be able to swipe left to throw an event
 * away"). Anything with data-plan-id: swipe it left (a card) or press and hold (a pill — pills sit in a row you slide
 * sideways) → 🗑 Remove. A past plan leaves your lists (for you only); a plan still ahead asks first — the host cancels it
 * for everyone, a guest says they're not going.
 */
(function () {
  if (window.__bflySwipe) return; window.__bflySwipe = true;
  const css = document.createElement('style');
  css.textContent = `[data-plan-id].swiping{transition:none!important}[data-plan-id]{touch-action:pan-y}
    .bfly-swipe-wrap{position:relative;overflow:hidden;border-radius:16px}
    .bfly-swipe-del{position:absolute;right:0;top:0;bottom:0;width:96px;display:flex;align-items:center;justify-content:center;background:#ef4444;color:#fff;font-weight:700;font-size:15px;border:none;cursor:pointer;font-family:inherit}`;
  document.head.appendChild(css);

  async function remove(id, el) {
    const post = (confirm) => fetch('/api/plans/' + encodeURIComponent(id) + '/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) }).then((r) => r.json()).catch(() => ({}));
    let r = await post(false);
    if (r.needs_confirm) { if (!window.confirm(r.message)) { reset(el); return; } r = await post(true); }
    if (!r.ok) { reset(el); alert(r.message || 'Couldn’t remove it — try again.'); return; }
    const gone = el.closest('.bfly-swipe-wrap') || el;
    gone.style.transition = 'opacity .2s, max-height .25s'; gone.style.opacity = '0';
    setTimeout(() => {
      gone.remove();
      // Looking at it right now (its pill or details): go to All.
      const here = new URLSearchParams(location.search).get('event');
      if (here === id) location.replace(location.pathname);
    }, 220);
  }
  function reset(el) { el.style.transform = ''; const d = el.parentElement?.querySelector(':scope > .bfly-swipe-del'); if (d) d.remove(); }

  // Swipe a card left: it slides, a red Remove appears behind it.
  let start = null;
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[data-plan-id]');
    if (!el || el.classList.contains('tpill')) return;
    start = { el, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(start.dx) < 10) { start = null; return; }   // scrolling, not swiping
    start.dx = Math.min(0, dx);
    start.el.classList.add('swiping'); start.el.style.transform = `translateX(${Math.max(start.dx, -120)}px)`;
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!start) return;
    const { el, dx } = start; start = null;
    el.classList.remove('swiping');
    if (dx > -60) { el.style.transition = 'transform .2s'; el.style.transform = ''; return; }
    el.style.transition = 'transform .2s'; el.style.transform = 'translateX(-96px)';
    if (!el.parentElement.classList.contains('bfly-swipe-wrap')) {
      const wrap = document.createElement('div'); wrap.className = 'bfly-swipe-wrap'; wrap.style.marginBottom = getComputedStyle(el).marginBottom;
      el.parentElement.insertBefore(wrap, el); wrap.appendChild(el); el.style.marginBottom = '0';
    }
    const del = document.createElement('button'); del.className = 'bfly-swipe-del'; del.textContent = '🗑 Remove';
    del.onclick = (ev) => { ev.stopPropagation(); remove(el.dataset.planId, el); };
    el.parentElement.insertBefore(del, el); el.style.position = 'relative'; el.style.zIndex = '1';
    // Tap elsewhere puts it back.
    setTimeout(() => document.addEventListener('click', function back(ev) { if (ev.target === del) return; reset(el); document.removeEventListener('click', back, true); }, true), 0);
  });

  // Press and hold a pill.
  let hold = null, firedAt = 0;   // letting go after a hold isn't also a tap on the pill
  const holdStart = (e) => {
    const el = e.target.closest('.tpill[data-plan-id]'); if (!el) return;
    hold = setTimeout(() => { hold = 'fired'; firedAt = Date.now(); if (window.confirm(`Remove “${el.title || 'this plan'}”?`)) remove(el.dataset.planId, el); }, 600);
  };
  const holdEnd = (e) => { if (hold === 'fired') { e.preventDefault(); } clearTimeout(hold); hold = null; };
  document.addEventListener('touchstart', holdStart, { passive: true });
  document.addEventListener('mousedown', holdStart);
  ['touchend', 'touchmove', 'mouseup', 'mouseleave'].forEach((t) => document.addEventListener(t, holdEnd, { passive: false }));
  document.addEventListener('click', (e) => { if (Date.now() - firedAt < 1500 && e.target.closest('.tpill')) { e.preventDefault(); e.stopPropagation(); } }, true);
})();
