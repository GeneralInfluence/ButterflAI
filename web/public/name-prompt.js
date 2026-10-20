/**
 * name-prompt.js — the one thing a new account is asked: your name (owner, 2026-10-20).
 *
 * Alexandria used the app for a week as "New user": logging in with a phone code created an
 * account with that placeholder, and the only way to change it was an old "Finish setup"
 * wizard (name + 3 contacts + how often) nobody went through. Now any account still on a
 * placeholder name is asked once, here, on whatever screen they open — that's all sign-up is.
 */
(function () {
  if (window.__bflyNamePrompt) return; window.__bflyNamePrompt = true;
  fetch('/api/user/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    if (!me || !me.needs_name) return;
    var wrap = document.createElement('div');
    wrap.id = 'bfly-name-prompt';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Your name');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9999;display:flex;align-items:flex-end;justify-content:center';
    wrap.innerHTML = '<form style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">'
      + '<div style="font-size:18px;font-weight:700;color:#1c1c1e;margin-bottom:4px">What’s your name?</div>'
      + '<div style="font-size:14px;color:#3a3a3c;margin-bottom:12px">It’s how your friends’ ButterflAIs will know you.</div>'
      + '<input id="bfly-name-input" autocomplete="name" maxlength="60" placeholder="Your name" style="width:100%;box-sizing:border-box;height:44px;border:1.5px solid #e5e5e5;border-radius:12px;padding:0 12px;font-size:16px;font-family:inherit">'
      + '<div id="bfly-name-err" style="color:#ef4444;font-size:13px;min-height:18px;margin-top:4px"></div>'
      + '<button type="submit" style="width:100%;height:44px;border:none;border-radius:12px;background:#6c47ff;color:#fff;font-size:16px;font-weight:600;font-family:inherit;cursor:pointer">Save</button></form>';
    document.body.appendChild(wrap);
    var input = wrap.querySelector('#bfly-name-input');
    setTimeout(function () { input.focus(); }, 50);
    wrap.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) { wrap.querySelector('#bfly-name-err').textContent = 'Type your name'; return; }
      fetch('/api/user/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { if (x.ok) wrap.remove(); else wrap.querySelector('#bfly-name-err').textContent = x.j.error || 'Couldn’t save — try again'; })
        .catch(function () { wrap.querySelector('#bfly-name-err').textContent = 'Couldn’t save — try again'; });
    });
  }).catch(function () {});
})();
