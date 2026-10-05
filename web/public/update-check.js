/**
 * update-check.js — PWA update detection and banner
 *
 * Include this script in every app page (after the SW registration).
 * It will:
 *   1. Force an SW update check on every page load (so users don't wait 24h)
 *   2. Show a top banner when a new version is waiting
 *   3. On banner tap → tell the waiting SW to activate → reload
 */
(function () {
  if (!('serviceWorker' in navigator)) return;

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
    dismiss.title = 'Dismiss';
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
  // Updates also apply silently (on foreground / on opening a page), which made the
  // banner seem to vanish for no reason. Every update-driven reload now leaves a flag
  // so the next page says so.
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
    // while the banner was up, the worker we remembered is already obsolete and
    // messaging it would do nothing.
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

  // ── Manual check (Settings → "Check for updates") ─────────────────────────
  // Resolves { status: 'updating' | 'latest' | 'unsupported' }. 'updating' means the
  // page is about to reload onto the new version.
  window.bflyCheckForUpdate = async function () {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { status: 'unsupported' };
    if (!reg.waiting) {
      await reg.update();
      const w = reg.installing || reg.waiting;
      if (w && w.state !== 'installed') {
        await new Promise(res => {
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' || w.state === 'redundant') res();
          });
          setTimeout(res, 15000);
        });
      }
    }
    if (reg.waiting) { applyUpdate(); return { status: 'updating' }; }
    return { status: 'latest' };
  };

  // The version the active service worker was deployed as (e.g. "745ec2d-1791225311").
  window.bflyRunningVersion = async function () {
    const reg = await navigator.serviceWorker.getRegistration();
    const sw = navigator.serviceWorker.controller || (reg && reg.active);
    if (!sw) return null;
    return new Promise(res => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => res(e.data && e.data.version || null);
      sw.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
      setTimeout(() => res(null), 2000);
    });
  };

  // ── Auto-update on foreground ─────────────────────────────────────────────
  // When the user brings the app back from background, if a new version is
  // waiting just reload silently — all state is server-side so it's lossless.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (waitingWorker) { applyUpdate(); return; }
    // An installed PWA resumes from the background WITHOUT reloading, so the
    // load-time update() never re-runs and new deploys are never noticed. Re-check
    // every time the app returns to the foreground — this is what stops users from
    // having to uninstall/reinstall to get updates.
    navigator.serviceWorker.ready.then(reg => reg.update().catch(() => {}));
  });

  // ── Registration + update detection ──────────────────────────────────────
  navigator.serviceWorker.ready.then(registration => {
    // 1. Check for a SW waiting right now (e.g. user revisited after update deployed)
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      // A new version was deployed while we were away — apply it now. This is a fresh
      // open, so reloading to the latest is expected, not disruptive.
      applyUpdate();
    }

    // 2. Detect new SW found while page is open
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = newWorker;
          // If app is in background right now, the next foreground will auto-reload.
          // If app is in foreground (user is actively using it), show the banner.
          if (document.visibilityState === 'visible') {
            showUpdateBanner();
          }
          // If invisible, we'll silently reload on next visibilitychange above.
        }
      });
    });

    // 3. Force an update check on every page load — bypasses the 24h throttle
    registration.update().catch(() => {});
  });
})();
