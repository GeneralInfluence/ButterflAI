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
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // Fallback: hard reload
      location.reload(true);
    }
  }

  // When the new SW takes control, reload the page to get fresh assets
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    location.reload();
  });

  // ── Registration + update detection ──────────────────────────────────────
  navigator.serviceWorker.ready.then(registration => {
    // 1. Check for a SW waiting right now (e.g. user revisited after update deployed)
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      showUpdateBanner();
    }

    // 2. Detect new SW found while page is open
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New version installed and waiting — existing content still served
          waitingWorker = newWorker;
          showUpdateBanner();
        }
      });
    });

    // 3. Force an update check on every page load — bypasses the 24h throttle
    //    Chrome throttles update() to once per 24h in practice, but this
    //    ensures we at least try on every navigation.
    registration.update().catch(() => {}); // silently ignore if offline
  });
})();
