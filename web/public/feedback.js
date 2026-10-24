/**
 * feedback.js — tell us what you didn't like, from any screen (owner, 2026-10-12).
 *
 * A small tab on the right edge of every app screen. One tap:
 *   1. takes a screenshot of what's on screen (html2canvas, loaded on demand), and
 *   2. collects the screen's state — the page, what it was showing (each page can register
 *      window.bflyFeedbackState()), app version, device,
 * then asks "What didn't you like, or what should change?" The person sees the screenshot
 * and can leave it out before sending. Sent to /api/feedback; read on /admin/feedback.
 */
(function () {
  if (window.__bflyFeedback) return;
  window.__bflyFeedback = true;

  const css = `
    /* ＋ New plan and 🐛 Ideas & bugs share one pill on the right edge (🐛 #34, 2026-10-20). */
    #bfly-side { position: fixed; right: 0; top: 52%; z-index: 9000; display: flex; flex-direction: column; background: #6c47ff;
      border-radius: 12px 0 0 12px; box-shadow: 0 2px 10px rgba(0,0,0,.2); opacity: .9; overflow: hidden; }
    #bfly-side button { border: none; cursor: pointer; background: none; color: #fff; padding: 9px 8px; font-size: 17px; line-height: 1; font-family: inherit; }
    #bfly-new { font-size: 22px !important; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,.35) !important; }
    #bfly-fb-tab { }
    #bfly-new-sheet { position: fixed; inset: 0; z-index: 9500; background: rgba(0,0,0,.35); display: flex; align-items: flex-end; justify-content: center; }
    #bfly-new-sheet[hidden] { display: none; }
    #bfly-new-where button { flex: 1; border: 1.5px solid #e5e5e5; background: #fff; border-radius: 12px; padding: 8px 10px; font-size: 14px; font-family: inherit; cursor: pointer; text-align: center; }
    #bfly-new-where button.on { border-color: #6c47ff; background: #ede9fe; color: #5a38d9; font-weight: 600; }
    #bfly-new-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
    #bfly-new-chips button { border: 1px solid #e5e5e5; background: #fff; border-radius: 999px; padding: 6px 12px; font-size: 14px; font-family: inherit; cursor: pointer; }
    #bfly-fb-sheet { position: fixed; inset: 0; z-index: 9500; background: rgba(0,0,0,.35); display: flex; align-items: flex-end; justify-content: center; }
    #bfly-fb-sheet[hidden] { display: none; }
    #bfly-fb-card { background: #fff; width: 100%; max-width: 520px; border-radius: 18px 18px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1e; box-shadow: 0 -4px 24px rgba(0,0,0,.2); }
    #bfly-fb-label { font-size: 13px; font-weight: 600; color: #6c47ff; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; }
    #bfly-fb-card h3 { margin: 0 0 10px; font-size: 17px; }
    #bfly-fb-card textarea { width: 100%; box-sizing: border-box; min-height: 90px; border: 1.5px solid #e5e5e5; border-radius: 12px;
      padding: 10px 12px; font-family: inherit; font-size: 16px; resize: vertical; }
    #bfly-fb-card textarea:focus { outline: none; border-color: #6c47ff; }
    #bfly-fb-shot { display: flex; gap: 10px; align-items: center; margin: 10px 0; font-size: 13px; color: #3a3a3c; }
    #bfly-fb-shot img { width: 64px; max-height: 120px; object-fit: cover; object-position: top; border: 1px solid #e5e5e5; border-radius: 6px; }
    #bfly-fb-actions { display: flex; gap: 8px; justify-content: flex-end; }
    #bfly-fb-actions button { height: 38px; padding: 0 16px; border-radius: 999px; border: none; font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer; }
    #bfly-fb-send { background: #6c47ff; color: #fff; }
    #bfly-fb-send:disabled { opacity: .6; }
    #bfly-fb-cancel { background: #f2f2f7; color: #1c1c1e; }
    #bfly-fb-done { font-size: 15px; color: #6c47ff; padding: 8px 0; }`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const side = document.createElement('div');
  side.id = 'bfly-side';
  const plus = document.createElement('button');
  plus.id = 'bfly-new'; plus.type = 'button'; plus.textContent = '＋'; plus.title = 'New plan'; plus.setAttribute('aria-label', 'Start a new plan');
  const tab = document.createElement('button');
  tab.id = 'bfly-fb-tab'; tab.type = 'button'; tab.textContent = '🐛';   // a caterpillar on most phones: help it become a butterfly
  tab.title = 'Ideas & bugs'; tab.setAttribute('aria-label', 'Send feedback about this screen');
  side.append(plus, tab);
  // ＋ New plan: say what it is in a line; your ButterflAI makes it (told you tapped ＋ — 🐛 #34).
  const newSheet = document.createElement('div');
  newSheet.id = 'bfly-new-sheet'; newSheet.hidden = true;
  newSheet.innerHTML = `<div id="bfly-fb-card" role="dialog" aria-label="New plan">
      <div id="bfly-fb-label">＋ New plan</div>
      <h3>What's the plan?</h3>
      <div id="bfly-new-where" hidden style="display:flex;gap:6px;margin:0 0 10px"></div>
      <div id="bfly-new-chips">${['🍽️ Dinner', '🍻 Drinks', '🏡 Hangout', '🎉 Party', '🏕️ Trip'].map((c) => `<button type="button">${c}</button>`).join('')}</div>
      <textarea id="bfly-new-text" maxlength="1000" placeholder="e.g. Dinner with Allie and Bam next Friday"></textarea>
      <div id="bfly-fb-actions" style="margin-top:10px"><button type="button" id="bfly-new-cancel">Cancel</button><button type="button" id="bfly-new-go" style="background:#6c47ff;color:#fff">Make it</button></div>
    </div>`;
  const newText = () => newSheet.querySelector('#bfly-new-text');
  // Pages can open it filled in — Explore's "Make it a plan" (🐛 #47: edit it before anything is made).
  let fromSpell = null;
  let partChoice = null;   // the plan the new one is part of, or null for a plan of its own
  window.bflyNewPlan = (text, { spell = null, about = null } = {}) => {
    fromSpell = spell;
    newSheet.querySelector('h3').textContent = spell ? 'Make it yours, then make it' : "What's the plan?";
    let hint = newSheet.querySelector('#bfly-new-from');
    if (!hint) { hint = document.createElement('div'); hint.id = 'bfly-new-from'; hint.style.cssText = 'font-size:13px;color:#8e8e93;margin:-4px 0 8px'; newSheet.querySelector('h3').after(hint); }
    // Tapped while looking at a plan: the new one will be part of it (2026-10-23).
    const inPlan = !spell && new URLSearchParams(location.search).get('event');
    const inPlanTitle = inPlan && inPlan !== 'general' ? (document.querySelector('.tpill.active')?.getAttribute('title') || '').trim() : '';
    hint.textContent = about ? `From ButterflAI’s idea: ${about} — change anything before it’s made` : '';
    // Tapped inside a plan: part of it, or its own plan — their choice (owner, 2026-10-23: "they might just be in another
    // event, hit plus, and be thinking about a general event … they should be able to switch between the two").
    const where = newSheet.querySelector('#bfly-new-where');
    partChoice = inPlan && inPlan !== 'general' ? inPlan : null;
    if (partChoice) {
      const draw = () => {
        where.innerHTML = `<button type="button" data-w="part" class="${partChoice ? 'on' : ''}">🧩 Part of ${inPlanTitle ? inPlanTitle.replace(/</g, '&lt;') : 'this plan'}</button><button type="button" data-w="own" class="${partChoice ? '' : 'on'}">✨ Separate plan</button>`;
        where.title = partChoice ? 'Everyone in it will be in this too' : 'A plan of its own';
      };
      where.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; partChoice = b.dataset.w === 'part' ? inPlan : null; draw(); };
      draw(); where.hidden = false; where.style.display = 'flex';
    } else { where.hidden = true; where.style.display = 'none'; }
    newText().value = text || '';
    newSheet.hidden = false;
    setTimeout(() => { const t = newText(); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 50);
  };
  plus.addEventListener('click', () => { window.bflyNewPlan(''); });
  newSheet.addEventListener('click', (e) => { if (e.target === newSheet) newSheet.hidden = true; });
  newSheet.querySelector('#bfly-new-cancel').addEventListener('click', () => { newSheet.hidden = true; });
  newSheet.querySelector('#bfly-new-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const word = b.textContent.replace(/^\S+\s/, '');
    const t = newText(); t.value = t.value.trim() ? t.value : `${word} with `; t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  });
  newSheet.querySelector('#bfly-new-go').addEventListener('click', async () => {
    const go = newSheet.querySelector('#bfly-new-go');
    const text = newText().value.trim();
    if (!text) { newText().focus(); return; }
    go.disabled = true; go.textContent = 'Making it…';
    try {
      // Tapped from inside a plan: the new one is part of it (2026-10-23).
      const r = await fetch('/api/plans/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(fromSpell ? { spell_id: fromSpell } : {}), ...(partChoice ? { part_of: partChoice } : { separate: true }) }) });
      if (!r.ok) throw new Error();
      const { ts, event_id: made } = await r.json();
      // The plan exists now (made in code) — open its discussion; ButterflAI fills it in there.
      location.href = made ? '/app/chat?event=' + encodeURIComponent(made) : '/app/chat?new=' + encodeURIComponent(ts);
    } catch (_) { go.disabled = false; go.textContent = 'Make it'; }
  });
  const sheet = document.createElement('div');
  sheet.id = 'bfly-fb-sheet'; sheet.hidden = true;
  const TEMPLATE = `<div id="bfly-fb-card" role="dialog" aria-label="Feedback">
      <div id="bfly-fb-label">🐛 Ideas &amp; bugs</div>
      <h3>What didn't you like, or what should change?</h3>
      <textarea id="bfly-fb-note" maxlength="2000" placeholder="e.g. My plan isn't on the calendar"></textarea>
      <div id="bfly-fb-shot" hidden><img alt="Screenshot of this screen"><label><input type="checkbox" id="bfly-fb-include" checked> Include this screenshot</label></div>
      <div id="bfly-fb-actions"><button type="button" id="bfly-fb-cancel">Cancel</button><button type="button" id="bfly-fb-send">Send</button></div>
    </div>`;
  sheet.innerHTML = TEMPLATE;
  document.addEventListener('DOMContentLoaded', () => { document.body.append(side, sheet, newSheet); });
  if (document.readyState !== 'loading') document.body.append(side, sheet, newSheet);

  let shot = null;
  function loadLib() {
    if (window.html2canvas) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement('script'); s.src = '/vendor/html2canvas.min.js'; s.onload = ok; s.onerror = fail; document.head.appendChild(s);
    });
  }
  // Just what's on screen, scaled down and JPEG-compressed (a few hundred KB).
  async function capture() {
    await loadLib();
    const canvas = await window.html2canvas(document.body, {
      x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
      scale: Math.min(1, 720 / window.innerWidth), logging: false, useCORS: true, backgroundColor: '#ffffff',
      ignoreElements: (el) => el.id === 'bfly-side' || el.id === 'bfly-fb-sheet' || el.id === 'bfly-new-sheet',
    });
    return canvas.toDataURL('image/jpeg', 0.6);
  }
  function state() {
    let s = {};
    try { s = (typeof window.bflyFeedbackState === 'function' && window.bflyFeedbackState()) || {}; } catch (_) {}
    return { title: document.title, path: location.pathname, query: location.search, scroll: window.scrollY, ...s };
  }

  tab.addEventListener('click', async () => {
    tab.disabled = true;
    shot = null;
    try { shot = await capture(); } catch (_) { /* send without one */ }
    tab.disabled = false;
    const box = document.getElementById('bfly-fb-shot');
    box.hidden = !shot;
    if (shot) box.querySelector('img').src = shot;
    document.getElementById('bfly-fb-include').checked = true;
    document.getElementById('bfly-fb-note').value = '';
    document.getElementById('bfly-fb-send').disabled = false;
    sheet.hidden = false;
    setTimeout(() => document.getElementById('bfly-fb-note').focus(), 50);
  });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  sheet.addEventListener('click', async (e) => {
    if (e.target.id === 'bfly-fb-cancel') { sheet.hidden = true; return; }
    if (e.target.id !== 'bfly-fb-send') return;
    const send = e.target;
    send.disabled = true;
    let version = null;
    try { version = window.bflyRunningVersion ? await window.bflyRunningVersion() : null; } catch (_) {}
    const body = {
      note: document.getElementById('bfly-fb-note').value.trim(),
      page: location.pathname, state: state(), app_version: version,
      device: `${navigator.userAgent} · ${window.innerWidth}x${window.innerHeight}`,
      screenshot: shot && document.getElementById('bfly-fb-include').checked ? shot : undefined,
    };
    try {
      const r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error();
      document.getElementById('bfly-fb-card').innerHTML = '<div id="bfly-fb-done">✓ Thanks — we\'ll look at this.</div>';
      setTimeout(() => { sheet.hidden = true; sheet.innerHTML = TEMPLATE; }, 1200);
    } catch (_) { send.disabled = false; send.textContent = 'Try again'; }
  });
})();
