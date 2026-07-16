const SHARE_CACHE = 'butterflai-share-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(handleShare(event.request));
    return;
  }
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
