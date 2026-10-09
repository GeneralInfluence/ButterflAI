/**
 * notify-prompt.js — ask people to turn on notifications when they open the app.
 *
 * Owner rule (2026-10-09): someone WITHOUT ButterflAI notifications is texted right away
 * (texts cost money and pull people out of the app), so the app asks them to turn
 * notifications on. Shown when THIS browser isn't subscribed for the logged-in account.
 *
 * - Supported browser: one tap → permission → subscribe (same flow as Settings).
 * - iPhone/iPad not installed to the Home Screen: Safari can't do web push there, so it
 *   explains Share → Add to Home Screen instead.
 * - Permission blocked: explains how to allow it in settings.
 * - "Not now" hides it for 3 days on this device.
 */
(function () {
  var SNOOZE_KEY = 'bfly-notify-snooze-until';
  var SNOOZE_MS = 3 * 24 * 3600 * 1000;

  function snoozed() {
    try { return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now(); } catch (_) { return false; }
  }
  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch (_) {}
  }
  if (snoozed()) return;

  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToUint8(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([].map.call(raw, function (c) { return c.charCodeAt(0); }));
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  // A card under the page header: message, optional action button, "Not now".
  function show(opts) {
    if (document.getElementById('bfly-notify-card')) return;
    var card = el('div', [
      'position:fixed', 'left:12px', 'right:12px', 'z-index:9000',
      'top:calc(env(safe-area-inset-top, 0px) + 64px)', 'max-width:520px', 'margin:0 auto',
      'background:#fff', 'border:2px solid #6c47ff', 'border-radius:16px', 'padding:14px 16px',
      'box-shadow:0 6px 24px rgba(0,0,0,.15)', 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    ].join(';'));
    card.id = 'bfly-notify-card';
    card.setAttribute('role', 'dialog');
    card.appendChild(el('div', 'font-size:15px;font-weight:700;color:#1c1c1e;margin-bottom:4px', opts.title));
    var body = el('div', 'font-size:13px;color:#3a3a3c;line-height:1.4', opts.body);
    card.appendChild(body);
    var row = el('div', 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end');
    var later = el('button', 'border:none;background:#f2f2f7;color:#1c1c1e;border-radius:12px;padding:9px 14px;font-weight:600;font-size:14px', 'Not now');
    later.type = 'button';
    later.onclick = function () { snooze(); card.remove(); };
    row.appendChild(later);
    if (opts.action) {
      var go = el('button', 'border:none;background:#6c47ff;color:#fff;border-radius:12px;padding:9px 14px;font-weight:600;font-size:14px', opts.actionLabel);
      go.type = 'button';
      go.onclick = function () { opts.action(go, body, card); };
      row.appendChild(go);
    }
    card.appendChild(row);
    document.body.appendChild(card);
  }

  var WHY = 'Turn on notifications so messages from your friends’ ButterflAIs reach you here. Otherwise they come by text.';

  function blockedHelp() {
    if (navigator.brave) {
      return 'Brave blocks notifications by default. Open brave://settings/privacy, turn on “Use Google services for push messaging”, restart Brave, then allow notifications for butterflai.social.';
    }
    if (isIOS) return 'Notifications are blocked. Open the iPhone Settings app → Notifications → ButterflAI, and turn on Allow Notifications.';
    return 'Notifications are blocked for this site. Tap the lock icon next to the address (or open site settings), allow Notifications, then reload.';
  }

  async function enable(btn, body, card) {
    btn.disabled = true; btn.textContent = 'Setting up…';
    try {
      var reg = await navigator.serviceWorker.register('/sw.js');
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { body.textContent = blockedHelp(); btn.remove(); return; }
      var vk = await fetch('/api/push/vapid-key').then(function (r) { return r.json(); });
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vk.publicKey) });
      var r = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
      if (!r.ok) throw new Error('save failed');
      body.textContent = 'You’re all set — you’ll get a notification here instead of a text.';
      btn.remove();
      setTimeout(function () { card.remove(); }, 2500);
    } catch (e) {
      body.textContent = (e && e.name === 'NotAllowedError') ? blockedHelp()
        : (navigator.brave ? blockedHelp() : 'Couldn’t turn notifications on (' + ((e && (e.message || e.name)) || 'error') + '). You can try again from Settings.');
      btn.disabled = false; btn.textContent = 'Try again';
    }
  }

  async function check() {
    var vk = await fetch('/api/push/vapid-key').then(function (r) { return r.json(); }).catch(function () { return {}; });
    if (!vk || !vk.publicKey) return;                       // server push not configured

    if (!supported) {
      // iPhone Safari only supports web push once the app is on the Home Screen.
      if (isIOS && !isStandalone) {
        show({ title: 'Get notifications on your iPhone',
          body: WHY + ' On iPhone: tap the Share button (□↑), choose “Add to Home Screen”, then open ButterflAI from your Home Screen and turn notifications on.' });
      }
      return;
    }
    if (Notification.permission === 'denied') {
      show({ title: 'Notifications are off', body: WHY + ' ' + blockedHelp() });
      return;
    }
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      var st = await fetch('/api/push/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      if (!st || st.mine) return;                            // all set (or can't tell — don't nag)
    }
    show({ title: 'Turn on notifications?', body: WHY, actionLabel: 'Turn on', action: enable });
  }

  function start() { setTimeout(function () { check().catch(function () {}); }, 1200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
