// BUILD_VERSION is replaced by the deploy script — forces browser to detect a new SW
const BUILD_VERSION = '__BUILD_VERSION__';

const SHARE_CACHE = 'butterflai-share-v1';

self.addEventListener('install', () => {
  // Do NOT call skipWaiting() here — we wait for the page to signal readiness.
  // This lets us show an "Update available" banner before reloading.
  console.log('[sw] installed version', BUILD_VERSION);
});

self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Page sends { type: 'SKIP_WAITING' } when user taps the update banner.
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: '🦋 ButterflAI', body: 'You have a new update.', url: '/app/chat' };
  try { data = { ...data, ...JSON.parse(event.data.text()) }; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',      // full-colour brand icon (large icon)
      badge: '/icons/badge-96.png',     // white butterfly silhouette for the status bar
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app/chat';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Handle share target POST
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(handleShare(event.request));
    return;
  }

  // Never intercept API calls — let them go straight to the network, no caching
  if (url.pathname.startsWith('/api/')) return;

  // Everything else: network passthrough (no caching)
  event.respondWith(fetch(event.request));
});

async function handleShare(request) {
  try {
    const fd = await request.formData();
    const files = fd.getAll('contacts');
    // A screenshot shared from any app → Quick note, which reads it (2026-10-20).
    const shot = fd.getAll('screenshot').find((f) => f instanceof File && f.size);
    if (shot) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('/pending-shot', new Response(shot, { headers: { 'Content-Type': shot.type || 'image/png' } }));
      const q = new URLSearchParams({ shot: '1' });
      const t = fd.get('text'); if (t) q.set('text', String(t).slice(0, 1500));
      return Response.redirect('/app/quick?' + q.toString(), 303);
    }
    // Text or a link shared from another app (Tinder, Instagram…) → Quick note (2026-10-20).
    if (!files.some((f) => f instanceof File && f.size)) {
      const q = new URLSearchParams();
      for (const k of ['title', 'text', 'url']) { const v = fd.get(k); if (v) q.set(k, String(v).slice(0, 1500)); }
      if ([...q.keys()].length) return Response.redirect('/app/quick?' + q.toString(), 303);
    }
    let vcf = '';
    for (const f of files) { if (f instanceof File) vcf += await f.text() + '\n'; }
    if (vcf.trim()) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('/pending-import', new Response(vcf, { headers: { 'Content-Type': 'text/plain' } }));
    }
  } catch(e) { console.error('[sw] share error', e); }
  return Response.redirect('/app/contacts?import=shared', 303);
}
