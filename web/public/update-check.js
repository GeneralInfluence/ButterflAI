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

    // Push existing fixed header down (if present)
    const header = document.querySelector('header');
    if (header) header.style.top = '44px';

    document.body.prepend(banner);
  }

  // ── Apply update ──────────────────────────────────────────────────────────
  let waitingWorker = null;

  function applyUpdate() {
    if (waitingWorker) {
      // Tell the waiting SW to take over — controllerchange fires → reload below
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      location.reload(true);
    }
  }

  // controllerchange is the authoritative signal — always reload here
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // ── Auto-update on foreground ─────────────────────────────────────────────
  // When the user brings the app back from background, if a new version is
  // waiting just reload silently — all state is server-side so it's lossless.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && waitingWorker) {
      applyUpdate();
    }
  });

  // ── Registration + update detection ──────────────────────────────────────
  navigator.serviceWorker.ready.then(registration => {
    // 1. Check for a SW waiting right now (e.g. user revisited after update deployed)
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      showUpdateBanner(); // show banner in case they're actively using it
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
