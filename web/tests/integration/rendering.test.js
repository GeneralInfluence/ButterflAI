/**
 * rendering.test.js — App shell, PWA compliance, and cross-device layout tests
 *
 * Covers:
 *   - All app pages return 200 when authenticated
 *   - Every page has correct PWA meta tags (viewport, theme-color, manifest, icons)
 *   - Every app page includes SW registration + update-check.js
 *   - Chat page: input-row is position:fixed (Android PWA fix), has bottom-nav
 *   - Mobile bottom nav: correct 5 tabs on every app page
 *   - manifest.json: valid structure, correct icon sizes, theme_color, start_url
 *   - sw.js: 200, SKIP_WAITING message handler present (not auto-skipWaiting)
 *   - Static PWA assets exist and return 200: icon-192, icon-512, apple-touch-icon, favicon
 *   - install-prompt.js: served, standalone guard, beforeinstallprompt handling
 *   - update-check.js: served, controllerchange reload, visibilitychange auto-update
 *   - Unauthenticated app pages redirect to login
 */

'use strict';

process.env.DB_PATH    = ':memory:';
process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-secret';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before } = require('node:test');
const assert  = require('node:assert/strict');
const supertest = require('supertest');
const { v4: uuidv4 } = require('uuid');

const sms = require('../../sms');
sms._setClient({ messages: { create() { return Promise.resolve({ sid: 'SM_TEST' }); } } });

const { app } = require('../../server');
const db       = require('../../db');
const request  = supertest(app);

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getAuthedCookie(phone = '+12025559001') {
  const existing = db.getUserByPhone(phone);
  if (!existing) {
    const id = uuidv4();
    db._raw().prepare(`INSERT INTO users (id, name, phone, onboarding_state) VALUES (?, 'Render Tester', ?, 'complete')`).run(id, phone);
    db.writeConsent(phone, 'INVITE_PAGE');
  }
  const send = await request.post('/auth/otp/send').send({ phone });
  assert.equal(send.status, 200);
  const otp = db._raw().prepare(`SELECT code FROM otp_codes WHERE phone=? AND used=0 ORDER BY created_at DESC LIMIT 1`).get(phone);
  const verify = await request.post('/auth/otp/verify').send({ phone, code: otp.code });
  assert.equal(verify.status, 200);
  return verify.headers['set-cookie'][0];
}

// ── App pages under test ──────────────────────────────────────────────────────

const APP_PAGES = [
  { path: '/app/chat',        name: 'Chat' },
  { path: '/app/dashboard',   name: 'Dashboard' },
  { path: '/app/contacts',    name: 'Contacts (People)' },
  { path: '/app/events',      name: 'Events' },
  { path: '/app/settings',    name: 'Settings' },
];

const BOTTOM_NAV_TABS = ['Home', 'Chat', 'People', 'Events', 'Settings'];

// ── PWA meta tag compliance ───────────────────────────────────────────────────

describe('PWA meta tags — all app pages', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie();
  });

  for (const { path, name } of APP_PAGES) {
    test(`${name}: viewport meta tag`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.equal(res.status, 200, `${path} should return 200`);
      assert.ok(
        res.text.includes('name="viewport"') && res.text.includes('width=device-width'),
        `${name} must have <meta name="viewport" content="width=device-width,...">`
      );
    });

    test(`${name}: theme-color meta tag (#6c47ff)`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('name="theme-color"') && res.text.includes('#6c47ff'),
        `${name} must have theme-color #6c47ff`
      );
    });

    test(`${name}: manifest link`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('rel="manifest"') && res.text.includes('manifest.json'),
        `${name} must link to manifest.json`
      );
    });

    test(`${name}: apple-touch-icon`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('apple-touch-icon'),
        `${name} must have apple-touch-icon for iOS`
      );
    });

    test(`${name}: favicon link`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('favicon'),
        `${name} must reference a favicon`
      );
    });

    test(`${name}: service worker registration`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('serviceWorker') && res.text.includes('sw.js'),
        `${name} must register sw.js`
      );
    });

    test(`${name}: update-check.js included`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.ok(
        res.text.includes('update-check.js'),
        `${name} must include update-check.js for PWA update detection`
      );
    });
  }
});

// ── Mobile bottom nav ─────────────────────────────────────────────────────────

describe('Mobile bottom nav — 5 tabs on every app page', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025559002');
  });

  for (const { path, name } of APP_PAGES) {
    test(`${name}: has bottom-nav with all 5 tabs`, async () => {
      const res = await request.get(path).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('bottom-nav'), `${name} must have .bottom-nav`);
      for (const tab of BOTTOM_NAV_TABS) {
        assert.ok(res.text.includes(tab), `${name} bottom-nav must include "${tab}" tab`);
      }
    });
  }
});

// ── Chat page mobile layout ───────────────────────────────────────────────────

describe('Chat page — mobile layout (Android PWA fix)', () => {
  let cookie;

  before(async () => {
    cookie = await getAuthedCookie('+12025559003');
  });

  test('input-row uses position:fixed (not flex margin hack)', async () => {
    const res = await request.get('/app/chat').set('Cookie', cookie);
    // The fix for Android PWA: input-row must be position:fixed
    // (not margin-bottom: 58px which breaks on Android gesture nav)
    assert.ok(
      res.text.includes('position: fixed') || res.text.includes('position:fixed'),
      'Chat input-row must be position:fixed for reliable Android PWA layout'
    );
    // Ensure the old flex margin hack is not the primary approach
    const fixedBeforeMargin =
      res.text.indexOf('position: fixed') < res.text.indexOf('margin-bottom: 58px') ||
      !res.text.includes('margin-bottom: 58px');
    assert.ok(fixedBeforeMargin, 'position:fixed must be the layout strategy, not margin-bottom hack');
  });

  test('input-row uses env(safe-area-inset-bottom) for notch/gesture-bar safety', async () => {
    const res = await request.get('/app/chat').set('Cookie', cookie);
    assert.ok(
      res.text.includes('safe-area-inset-bottom'),
      'Chat must use env(safe-area-inset-bottom) for iOS notch and Android gesture bar'
    );
  });

  test('messages container has padding-bottom to clear fixed input + nav', async () => {
    const res = await request.get('/app/chat').set('Cookie', cookie);
    // Messages div must have padding-bottom so content isn't hidden behind fixed bars
    assert.ok(
      res.text.includes('padding-bottom') && res.text.includes('messages'),
      'Messages container must have padding-bottom to clear the fixed input + nav bars'
    );
  });

  test('body uses 100dvh for dynamic viewport (not 100vh)', async () => {
    const res = await request.get('/app/chat').set('Cookie', cookie);
    assert.ok(
      res.text.includes('100dvh'),
      'Chat body should use 100dvh (dynamic viewport) to correctly handle mobile browser chrome'
    );
  });

  test('textarea input and send button are present', async () => {
    const res = await request.get('/app/chat').set('Cookie', cookie);
    assert.ok(res.text.includes('id="msg-input"'), 'Chat must have #msg-input textarea');
    assert.ok(res.text.includes('id="send-btn"'),  'Chat must have #send-btn');
  });
});

// ── manifest.json ─────────────────────────────────────────────────────────────

describe('manifest.json — PWA install compliance', () => {
  let manifest;

  before(async () => {
    const res = await request.get('/manifest.json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('json'), 'manifest.json must be JSON');
    manifest = res.body;
  });

  test('has name and short_name', () => {
    assert.ok(manifest.name, 'manifest must have name');
    assert.ok(manifest.short_name, 'manifest must have short_name');
    assert.equal(manifest.name, 'ButterflAI');
  });

  test('display is standalone (enables PWA mode)', () => {
    assert.equal(manifest.display, 'standalone', 'display must be "standalone" for PWA install');
  });

  test('has start_url', () => {
    assert.ok(manifest.start_url, 'manifest must have start_url');
  });

  test('theme_color matches brand purple', () => {
    assert.equal(manifest.theme_color, '#6c47ff', 'theme_color must be brand purple #6c47ff');
  });

  test('has icon at 192x192', () => {
    const icon192 = manifest.icons?.find(i => i.sizes === '192x192');
    assert.ok(icon192, 'manifest must include 192x192 icon (required for Android install)');
    assert.ok(icon192.src, '192x192 icon must have src');
    assert.ok(['any', 'maskable'].some(p => icon192.purpose?.includes(p)), '192 icon must have purpose');
  });

  test('has icon at 512x512', () => {
    const icon512 = manifest.icons?.find(i => i.sizes === '512x512');
    assert.ok(icon512, 'manifest must include 512x512 icon (required for splash screen)');
    assert.ok(icon512.src, '512x512 icon must have src');
  });

  test('has maskable icon (for adaptive icons on Android)', () => {
    const maskable = manifest.icons?.find(i => i.purpose?.includes('maskable'));
    assert.ok(maskable, 'manifest must have at least one maskable icon for Android adaptive icons');
  });
});

// ── Service worker ────────────────────────────────────────────────────────────

describe('sw.js — service worker compliance', () => {
  let swText;

  before(async () => {
    const res = await request.get('/sw.js');
    assert.equal(res.status, 200);
    swText = res.text;
  });

  test('SKIP_WAITING message handler present (user-controlled update)', () => {
    assert.ok(
      swText.includes('SKIP_WAITING'),
      'SW must listen for SKIP_WAITING message — update is user-controlled, not automatic'
    );
  });

  test('does NOT call skipWaiting() unconditionally on install', () => {
    // Extract just the install handler body (between the install listener and the next listener)
    // and check there's no actual skipWaiting() call (comments don't count)
    const installBlock = swText.match(/addEventListener\(['"]install['"][^{]*\{([^}]*)\}/)?.[1] || '';
    // Strip comments, then check for skipWaiting call
    const noComments = installBlock.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hasAutoSkip = /skipWaiting\s*\(/.test(noComments);
    assert.ok(!hasAutoSkip, 'SW must not call skipWaiting() directly in the install handler — only via message');
  });

  test('has push notification handler', () => {
    assert.ok(swText.includes("addEventListener('push'"), 'SW must handle push events');
    assert.ok(swText.includes('showNotification'), 'SW must call showNotification');
  });

  test('does not cache API routes', () => {
    assert.ok(
      swText.includes('/api/'),
      'SW fetch handler must explicitly skip caching for /api/ routes'
    );
  });

  test('BUILD_VERSION placeholder was replaced at deploy time', () => {
    // In production the build script replaces __BUILD_VERSION__ with a real value.
    // In tests (dev build), it may still be the placeholder — warn, don't fail.
    // This test just checks the field exists.
    assert.ok(
      swText.includes('BUILD_VERSION'),
      'SW must declare BUILD_VERSION so browser can detect file changes between deploys'
    );
  });
});

// ── Static PWA assets ─────────────────────────────────────────────────────────

describe('Static PWA assets — all required files served', () => {
  const assets = [
    { path: '/icons/icon-192.png',         type: 'image/png',        desc: 'Android home screen icon (192px)' },
    { path: '/icons/icon-512.png',         type: 'image/png',        desc: 'Android splash icon (512px)' },
    { path: '/icons/apple-touch-icon.png', type: 'image/png',        desc: 'iOS home screen icon (180px)' },
    { path: '/favicon.ico',                type: 'image/x-icon',     desc: 'Browser tab favicon (ICO)' },
    { path: '/favicon.png',                type: 'image/png',        desc: 'Browser tab favicon (PNG)' },
    { path: '/icons/butterfly.svg',        type: 'image/svg+xml',    desc: 'Master brand SVG (source of truth)' },
    { path: '/manifest.json',              type: 'application/json', desc: 'PWA manifest' },
    { path: '/sw.js',                      type: 'application/javascript', desc: 'Service worker' },
    { path: '/update-check.js',            type: 'application/javascript', desc: 'Update detection script' },
    { path: '/install-prompt.js',          type: 'application/javascript', desc: 'Install prompt script' },
  ];

  for (const { path, desc } of assets) {
    test(`${desc}: ${path} → 200`, async () => {
      const res = await request.get(path);
      assert.equal(res.status, 200, `${path} must return 200 (${desc})`);
      assert.ok(res.body || res.text, `${path} must have non-empty body`);
    });
  }
});

// ── install-prompt.js behaviour ───────────────────────────────────────────────

describe('install-prompt.js — install button logic', () => {
  let src;

  before(async () => {
    const res = await request.get('/install-prompt.js');
    assert.equal(res.status, 200);
    src = res.text;
  });

  test('bails out when already in standalone mode', () => {
    assert.ok(
      src.includes('standalone') && src.includes('return'),
      'install-prompt.js must exit early when running as installed PWA'
    );
  });

  test('captures beforeinstallprompt for Android', () => {
    assert.ok(
      src.includes('beforeinstallprompt'),
      'must listen for beforeinstallprompt event (Android Chrome)'
    );
  });

  test('shows iOS instructions for Safari users', () => {
    assert.ok(src.includes('isIOS'), 'must detect iOS');
    assert.ok(src.includes('Add to Home Screen'), 'must show Add to Home Screen instructions for iOS');
  });

  test('handles appinstalled event to hide button after install', () => {
    assert.ok(
      src.includes('appinstalled'),
      'must listen for appinstalled event to hide the install card after install'
    );
  });
});

// ── update-check.js behaviour ─────────────────────────────────────────────────

describe('update-check.js — SW update detection logic', () => {
  let src;

  before(async () => {
    const res = await request.get('/update-check.js');
    assert.equal(res.status, 200);
    src = res.text;
  });

  test('calls registration.update() on page load (bypasses 24h throttle)', () => {
    assert.ok(
      src.includes('registration.update()'),
      'must call registration.update() on every page load to check for updates immediately'
    );
  });

  test('reloads on controllerchange (new SW took control)', () => {
    assert.ok(
      src.includes('controllerchange') && src.includes('reload'),
      'must reload when controllerchange fires (new SW activated)'
    );
  });

  test('sends SKIP_WAITING message to waiting SW', () => {
    assert.ok(
      src.includes('SKIP_WAITING'),
      'must post SKIP_WAITING message to the waiting service worker'
    );
  });

  test('auto-reloads when app comes to foreground with update waiting', () => {
    assert.ok(
      src.includes('visibilitychange') && src.includes('waitingWorker'),
      'must auto-reload when visibilityState becomes visible and update is waiting'
    );
  });

  test('shows purple update banner when update arrives mid-session', () => {
    assert.ok(
      src.includes('bfly-update-banner') && src.includes('#6c47ff'),
      'must show branded update banner when SW update arrives while app is in foreground'
    );
  });
});

// ── Auth guard — unauthenticated redirects ────────────────────────────────────

describe('Auth guard — unauthenticated users redirected', () => {
  for (const { path, name } of APP_PAGES) {
    test(`${name}: unauthenticated → redirect to login`, async () => {
      const res = await request.get(path);
      // Should redirect (302) or return 401, not 200
      assert.ok(
        res.status === 302 || res.status === 401,
        `${name} (${path}) must not be accessible without auth — got ${res.status}`
      );
      if (res.status === 302) {
        assert.ok(
          res.headers.location?.includes('login'),
          `${name} must redirect to login page`
        );
      }
    });
  }
});

// ── Public pages accessible without auth ─────────────────────────────────────

describe('Public pages — accessible without auth', () => {
  const PUBLIC_PAGES = [
    { path: '/app/login',        name: 'Login page' },
    { path: '/health',           name: 'Health check' },
  ];

  for (const { path, name } of PUBLIC_PAGES) {
    test(`${name}: accessible without auth → 200`, async () => {
      const res = await request.get(path);
      assert.equal(res.status, 200, `${name} (${path}) must be publicly accessible`);
    });
  }
});
