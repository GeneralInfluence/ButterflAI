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
    #bfly-fb-tab { position: fixed; right: 0; top: 58%; z-index: 9000; border: none; cursor: pointer;
      background: #6c47ff; color: #fff; border-radius: 12px 0 0 12px; padding: 10px 7px; font-size: 17px; line-height: 1;
      box-shadow: 0 2px 10px rgba(0,0,0,.2); opacity: .85; }
    #bfly-fb-sheet { position: fixed; inset: 0; z-index: 9500; background: rgba(0,0,0,.35); display: flex; align-items: flex-end; justify-content: center; }
    #bfly-fb-sheet[hidden] { display: none; }
    #bfly-fb-card { background: #fff; width: 100%; max-width: 520px; border-radius: 18px 18px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1e; box-shadow: 0 -4px 24px rgba(0,0,0,.2); }
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

  const tab = document.createElement('button');
  tab.id = 'bfly-fb-tab'; tab.type = 'button'; tab.textContent = '👎';
  tab.title = 'Something wrong? Tell us'; tab.setAttribute('aria-label', 'Send feedback about this screen');
  const sheet = document.createElement('div');
  sheet.id = 'bfly-fb-sheet'; sheet.hidden = true;
  const TEMPLATE = `<div id="bfly-fb-card" role="dialog" aria-label="Feedback">
      <h3>What didn't you like, or what should change?</h3>
      <textarea id="bfly-fb-note" maxlength="2000" placeholder="e.g. My plan isn't on the calendar"></textarea>
      <div id="bfly-fb-shot" hidden><img alt="Screenshot of this screen"><label><input type="checkbox" id="bfly-fb-include" checked> Include this screenshot</label></div>
      <div id="bfly-fb-actions"><button type="button" id="bfly-fb-cancel">Cancel</button><button type="button" id="bfly-fb-send">Send</button></div>
    </div>`;
  sheet.innerHTML = TEMPLATE;
  document.addEventListener('DOMContentLoaded', () => { document.body.append(tab, sheet); });
  if (document.readyState !== 'loading') document.body.append(tab, sheet);

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
      ignoreElements: (el) => el.id === 'bfly-fb-tab' || el.id === 'bfly-fb-sheet',
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
