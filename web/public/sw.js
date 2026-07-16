const SHARE_CACHE = 'butterflai-share-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: '🦋 ButterflAI', body: 'You have a new update.', url: '/app/chat' };
  try { data = { ...data, ...JSON.parse(event.data.text()) }; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
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
    let vcf = '';
    for (const f of files) { if (f instanceof File) vcf += await f.text() + '\n'; }
    if (vcf.trim()) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put('/pending-import', new Response(vcf, { headers: { 'Content-Type': 'text/plain' } }));
    }
  } catch(e) { console.error('[sw] share error', e); }
  return Response.redirect('/app/contacts?import=shared', 303);
}
