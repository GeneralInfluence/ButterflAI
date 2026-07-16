/**
 * install-prompt.js — "Install app" button for Android and iOS
 *
 * Injects an install card into #install-prompt-slot (if present on the page)
 * and/or a floating bottom button that appears on eligible pages.
 *
 * - Android Chrome: uses native beforeinstallprompt API
 * - iOS Safari:     shows manual Add-to-Home-Screen instructions
 * - Already installed (standalone): hides everything
 */
(function () {
  // Already running as installed PWA — do nothing
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  const isSupportedBrowser = isIOS || isAndroid ||
    ('BeforeInstallPromptEvent' in window); // desktop Chrome too

  if (!isSupportedBrowser) return;

  let deferredPrompt = null; // Android native install prompt

  // ── Android: capture the beforeinstallprompt event ───────────────────────
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    renderInstallUI();
  });

  // ── Detect already-installed after the fact ───────────────────────────────
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const el = document.getElementById('bfly-install-card');
    if (el) el.remove();
    const btn = document.getElementById('bfly-install-fab');
    if (btn) btn.remove();
  });

  // ── Build the install UI ──────────────────────────────────────────────────
  function renderInstallUI() {
    if (document.getElementById('bfly-install-card')) return;

    // ── Slot card (for dashboard / settings pages) ─────────────────────────
    const slot = document.getElementById('install-prompt-slot');
    if (slot) {
      const card = document.createElement('div');
      card.id = 'bfly-install-card';
      card.style.cssText = [
        'background:linear-gradient(135deg,#7c3aed,#6c47ff)',
        'border-radius:16px', 'padding:18px 20px',
        'display:flex', 'align-items:center', 'gap:14px',
        'margin-bottom:12px', 'cursor:pointer',
      ].join(';');

      const icon = document.createElement('div');
      icon.style.cssText = 'font-size:36px;flex-shrink:0';
      icon.textContent = '🦋';
      card.appendChild(icon);

      const text = document.createElement('div');
      text.style.flex = '1';
      text.innerHTML = `
        <div style="color:#fff;font-weight:700;font-size:15px;margin-bottom:3px">Install ButterflAI</div>
        <div style="color:rgba(255,255,255,.8);font-size:13px">${isIOS ? 'Add to your Home Screen for the full app experience' : 'Add to your Home Screen — works offline, faster'}</div>
      `;
      card.appendChild(text);

      const chevron = document.createElement('div');
      chevron.style.cssText = 'color:rgba(255,255,255,.7);font-size:20px;flex-shrink:0';
      chevron.textContent = '›';
      card.appendChild(chevron);

      card.addEventListener('click', triggerInstall);
      slot.appendChild(card);
    }
  }

  // ── Trigger install ───────────────────────────────────────────────────────
  async function triggerInstall() {
    if (isIOS) {
      showIOSInstructions();
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome === 'accepted') {
        const el = document.getElementById('bfly-install-card');
        if (el) el.remove();
      }
    }
  }

  // ── iOS modal instructions ────────────────────────────────────────────────
  function showIOSInstructions() {
    if (document.getElementById('bfly-ios-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'bfly-ios-modal';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,.55)', 'display:flex',
      'align-items:flex-end', 'justify-content:center',
    ].join(';');

    const sheet = document.createElement('div');
    sheet.style.cssText = [
      'background:#fff', 'border-radius:20px 20px 0 0',
      'padding:24px 24px 40px', 'width:100%', 'max-width:480px',
      'box-shadow:0 -4px 24px rgba(0,0,0,.15)',
    ].join(';');

    sheet.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div style="font-size:18px;font-weight:700;color:#1c1c1e">Install ButterflAI</div>
        <button id="bfly-ios-close" style="background:none;border:none;font-size:24px;color:#8e8e93;cursor:pointer;padding:0">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:36px;height:36px;border-radius:50%;background:#6c47ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">1</div>
          <div style="font-size:14px;color:#3a3a3c">Tap the <strong>Share</strong> button <span style="font-size:18px">⎋</span> at the bottom of Safari</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:36px;height:36px;border-radius:50%;background:#6c47ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">2</div>
          <div style="font-size:14px;color:#3a3a3c">Scroll down and tap <strong>"Add to Home Screen"</strong></div>
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:36px;height:36px;border-radius:50%;background:#6c47ff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">3</div>
          <div style="font-size:14px;color:#3a3a3c">Tap <strong>"Add"</strong> — the 🦋 butterfly appears on your home screen</div>
        </div>
      </div>
      <div style="margin-top:24px;text-align:center">
        <div style="font-size:48px">🦋</div>
        <div style="font-size:13px;color:#8e8e93;margin-top:6px">ButterflAI will appear on your home screen</div>
      </div>
    `;

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    document.getElementById('bfly-ios-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ── On iOS, show install UI immediately (no beforeinstallprompt event) ────
  if (isIOS) {
    // Small delay so the page renders first
    setTimeout(renderInstallUI, 500);
  }
})();
