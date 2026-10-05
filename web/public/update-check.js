/**
 * update-check.js — keep the open app on the latest deploy.
 *
 * Include this script in every app page (after the SW registration).
 *
 * Staleness is decided by VERSION COMPARISON, not service-worker events:
 *   - PAGE_VERSION is stamped into this file at deploy (Dockerfile), and this file is
 *     served no-store with its page, so it is the version of the page you're looking at.
 *   - GET /api/version is the version being served right now.
 *   - Different → this open page is stale.
 * The SW only proxies to the network (it caches nothing), so a reload always gets the
 * latest. SW lifecycle events alone missed cases (an already-activated SW with an
 * un-reloaded page; a banner pointing at a worker a newer deploy replaced), which is how
 * the banner could vanish with the page still on the old version.
 *
 * It will:
 *   1. Check on load, whenever the app returns to the foreground, and every 10 minutes
 *      while visible (an installed PWA can stay open for hours without reloading)
 *   2. Foreground + stale → reload silently (all state is server-side, so it's lossless);
 *      visible + stale → show the banner
 *   3. Banner "Update now" → activate any waiting SW → reload
 *   4. After any update-driven reload, confirm it ("ButterflAI updated")
 *   5. Expose window.bflyCheckForUpdate / bflyRunningVersion for Settings
 */
(function () {
  if (!('serviceWorker' in navigator)) return;

  const PAGE_VERSION = '__BUILD_VERSION__';
  const STAMPED = PAGE_VERSION.indexOf('__') !== 0; // unstamped in local dev
  const POLL_MS = 10 * 60 * 1000;

  // ── Version comparison ────────────────────────────────────────────────────
  async function serverVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()).version || null;
    } catch (_) { return null; }
  }

  async function isStale() {
    if (!STAMPED) return false;
    const v = await serverVersion();
    return !!v && v !== 'dev' && v !== PAGE_VERSION;
  }

  // ── Banner UI ─────────────────────────────────────────────────────────────
  function showUpdateBanner() {
    if (document.getElementById('bfly-update-banner')) return; // already shown
    const banner = document.createElement('div');
    banner.id = 'bfly-update-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#6c47ff', 'color:#fff',
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:10px 16px', 'gap:12px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:14px', 'font-weight:500',
      'box-shadow:0 2px 12px rgba(0,0,0,.25)',
    ].join(';');

    const msg = document.createElement('span');
    msg.textContent = '🦋 A new version is ready';
    banner.appendChild(msg);

    const btn = document.createElement('button');
    btn.textContent = 'Update now';
    btn.style.cssText = [
      'background:#fff', 'color:#6c47ff', 'border:none', 'border-radius:8px',
      'padding:6px 14px', 'font-size:13px', 'font-weight:700', 'cursor:pointer',
      'flex-shrink:0',
    ].join(';');
    btn.onclick = applyUpdate;
    banner.appendChild(btn);

    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.title = 'Dismiss — the update applies next time you open the app, or from Settings';
    dismiss.style.cssText = [
      'background:none', 'border:none', 'color:rgba(255,255,255,.7)',
      'font-size:18px', 'cursor:pointer', 'padding:0 2px', 'flex-shrink:0',
    ].join(';');
    dismiss.onclick = () => banner.remove();
    banner.appendChild(dismiss);

    // Push sticky header + main content down to clear the fixed banner
    const header = document.querySelector('header');
    if (header && getComputedStyle(header).position === 'sticky') {
      header.style.top = '44px';
    }
    const main = document.querySelector('main');
    if (main) main.style.paddingTop = `calc(44px + ${getComputedStyle(main).paddingTop})`;

    document.body.prepend(banner);
  }

  // ── "Updated" confirmation ────────────────────────────────────────────────
  // Updates also apply silently (on foreground / on opening a page). Every
  // update-driven reload leaves a flag so the next page says so.
  const JUST_UPDATED_KEY = 'bfly-just-updated';

  function reloadForUpdate() {
    try { sessionStorage.setItem(JUST_UPDATED_KEY, '1'); } catch (_) {}
    location.reload();
  }

  function showUpdatedToast() {
    const t = document.createElement('div');
    t.id = 'bfly-updated-toast';
    t.setAttribute('role', 'status');
    t.textContent = '✓ ButterflAI updated to the latest version';
    t.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'z-index:9999',
      'bottom:calc(76px + env(safe-area-inset-bottom))',
      'background:#1c1c1e', 'color:#fff', 'border-radius:12px', 'padding:10px 16px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:14px', 'font-weight:500', 'box-shadow:0 2px 12px rgba(0,0,0,.25)',
      'max-width:calc(100% - 32px)', 'text-align:center',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  try {
    if (sessionStorage.getItem(JUST_UPDATED_KEY)) {
      sessionStorage.removeItem(JUST_UPDATED_KEY);
      if (document.body) showUpdatedToast();
      else document.addEventListener('DOMContentLoaded', showUpdatedToast);
    }
  } catch (_) {}

  // ── Apply update ──────────────────────────────────────────────────────────
  let waitingWorker = null;

  async function applyUpdate() {
    // Always use the registration's CURRENT waiting worker: if another deploy landed
    // while the banner was up, the worker we remembered is already obsolete.
    let reg = null;
    try { reg = await navigator.serviceWorker.getRegistration(); } catch (_) {}
    const worker = (reg && reg.waiting) || waitingWorker;
    if (!worker) { reloadForUpdate(); return; }
    // Tell the waiting SW to take over — controllerchange fires → reload below.
    worker.postMessage({ type: 'SKIP_WAITING' });
    // Fallback: a page that wasn't controlled by the SW (e.g. after a hard reload)
    // never gets controllerchange, so reload anyway.
    setTimeout(reloadForUpdate, 4000);
  }

  // controllerchange is the authoritative signal — reload when the new SW takes over.
  // Guard against the first-ever install (no prior controller) so we don't reload the
  // very first visit.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    reloadForUpdate();
  });

  // ── Periodic + foreground checks ──────────────────────────────────────────
  async function checkWhileVisible() {
    if (document.visibilityState !== 'visible') return;
    if (await isStale()) showUpdateBanner();
  }
  setInterval(checkWhileVisible, POLL_MS);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    // An installed PWA resumes from the background WITHOUT reloading. Returning to the
    // app is a natural moment to move to the latest version — reload silently (the
    // "updated" toast confirms it).
    if (waitingWorker || await isStale()) { applyUpdate(); return; }
    navigator.serviceWorker.ready.then(reg => reg.update().catch(() => {}));
  });

  // ── Registration + SW update detection ────────────────────────────────────
  navigator.serviceWorker.ready.then(registration => {
    // 1. A SW waiting right now (deployed while we were away) — fresh open, apply it.
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      applyUpdate();
      return;
    }

    // 2. Detect new SW found while page is open
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = newWorker;
          if (document.visibilityState === 'visible') showUpdateBanner();
          // If invisible, the next visibilitychange applies it.
        }
      });
    });

    // 3. Force an update check on every page load — bypasses the 24h throttle
    registration.update().catch(() => {});
  });

  // 4. A deploy can land between this page being served and loading — check once now.
  checkWhileVisible();

  // ── Manual check (Settings → "Check for updates") ─────────────────────────
  // Resolves { status: 'updating' | 'latest' }. 'updating' means the page is about to
  // reload onto the new version.
  window.bflyCheckForUpdate = async function () {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && !reg.waiting) {
      try { await reg.update(); } catch (_) {}
      const w = reg.installing;
      if (w) {
        await new Promise(res => {
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' || w.state === 'redundant') res();
          });
          setTimeout(res, 15000);
        });
      }
    }
    if ((reg && reg.waiting) || await isStale()) { applyUpdate(); return { status: 'updating' }; }
    return { status: 'latest' };
  };

  // The deploy this open page came from (e.g. "7d1d3e8-1791227000"), or null in dev.
  window.bflyRunningVersion = async function () {
    return STAMPED ? PAGE_VERSION : null;
  };
})();
