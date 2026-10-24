/**
 * A question put to you, asked up front (🐛 #91 — Sean: "frankly there would be just a big modal asking me the question
 * and then bring me to the rest of the app"). On any screen, if someone put you down for something you haven't answered
 * ("Melanie put you down for: Kids at Press Start · 5pm. Are you on it?"), it asks first: I'm on it / Can't / Not now.
 * "Not now" waits until the next time the app opens. Also: a notification tap tells this page where to go (sw.js).
 */
(function () {
  if (window.__bflyAsks) return; window.__bflyAsks = true;
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'OPEN' && e.data.url && new URL(e.data.url).origin === location.origin && e.data.url !== location.href) location.href = e.data.url;
  });
  const later = () => { try { return JSON.parse(sessionStorage.getItem('bfly-asks-later') || '[]'); } catch (_) { return []; } };
  const setLater = (ids) => { try { sessionStorage.setItem('bfly-asks-later', JSON.stringify(ids)); } catch (_) {} };
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = document.createElement('style');
  css.textContent = `#bfly-ask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px}
    #bfly-ask .card{background:#fff;border-radius:20px;padding:22px 20px;max-width:420px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    #bfly-ask .k{font-size:13px;font-weight:700;color:#6c47ff;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
    #bfly-ask .q{font-size:18px;font-weight:600;color:#1c1c1e;line-height:1.35;margin-bottom:6px}
    #bfly-ask .p{font-size:14px;color:#8e8e93;margin-bottom:16px}
    #bfly-ask .row{display:flex;gap:8px;flex-wrap:wrap}
    #bfly-ask button{flex:1;min-width:110px;border:none;border-radius:12px;padding:12px;font:inherit;font-size:16px;font-weight:600;cursor:pointer}
    #bfly-ask .yes{background:#6c47ff;color:#fff}#bfly-ask .no{background:#f2f2f7;color:#1c1c1e}#bfly-ask .later{background:none;color:#6c47ff;flex-basis:100%}`;
  document.head.appendChild(css);
  async function show() {
    let asks = [];
    try { asks = (await fetch('/api/asks').then((r) => (r.ok ? r.json() : { asks: [] }))).asks || []; } catch (_) { return; }
    const want = new URLSearchParams(location.search).get('ask_todo');
    asks = asks.filter((a) => !later().includes(a.todo_id) || a.todo_id === want);
    asks.sort((a, b) => (b.todo_id === want) - (a.todo_id === want));
    const a = asks[0];
    if (!a || document.getElementById('bfly-ask')) return;
    const el = document.createElement('div'); el.id = 'bfly-ask';
    el.innerHTML = `<div class="card" role="dialog" aria-label="A question for you"><div class="k">🙋 ${esc(a.from)} put you down for</div>
      <div class="q">${esc(a.what)}</div><div class="p">${esc(a.plan)}${asks.length > 1 ? ` · ${asks.length - 1} more after this` : ''}</div>
      <div class="row"><button class="yes" data-a="on_it">I'm on it</button><button class="no" data-a="cant">Can't</button><button class="later" data-a="later">Not now</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'later') setLater([...later(), a.todo_id]);
      else await fetch('/api/todos/' + encodeURIComponent(a.todo_id) + '/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: b.dataset.a }) }).catch(() => {});
      el.remove();
      if (b.dataset.a !== 'later' && typeof window.loadTodos === 'function') window.loadTodos();
      show();   // the next one, if any
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
