/**
 * ogimage.js — the picture a web page offers for sharing (og:image / twitter:image), for Explore's
 * Instagram-style cards (🐛 #39). Fetching pages from our server is risky, so this only:
 *  - follows http(s) links to public addresses (every host, including redirects, is resolved and
 *    refused if it's private, loopback, link-local or otherwise internal),
 *  - reads at most 512 KB of HTML within 6 seconds, and returns only an https image URL.
 * The image itself is never downloaded by us — the person's phone loads it from the site.
 */
'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

// Tests never reach the internet: off under NODE_ENV=test unless a fake fetch is given.
let _enabled = process.env.NODE_ENV !== 'test';
let _fetch = (...a) => fetch(...a);
function _setFetch(f) { _fetch = f; _enabled = !!f; }
let _lookup = (host) => dns.lookup(host, { all: true });
function _setLookup(f) { _lookup = f; }

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}
async function publicUrl(u) {
  let url;
  try { url = new URL(u); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !['80', '443'].includes(url.port)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await _lookup(host);
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
  } catch (_) { return null; }
  return url;
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function pick(html, base) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const want = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];
  const found = {};
  for (const m of metas) {
    const key = (m.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (m.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (key && val && want.includes(key.toLowerCase()) && !found[key.toLowerCase()]) found[key.toLowerCase()] = decode(val.trim());
  }
  for (const k of want) {
    if (!found[k]) continue;
    try {
      const u = new URL(found[k], base);
      if (u.protocol === 'http:') u.protocol = 'https:';   // the app is https; plain http images wouldn't show
      if (u.protocol === 'https:' && u.href.length < 1000) return u.href;
    } catch (_) {}
  }
  return null;
}

/** The share picture for a page, or null. */
async function find(link) {
  if (!_enabled) return null;
  let url = await publicUrl(link);
  for (let hop = 0; url && hop < 4; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await _fetch(url.href, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ButterflAI/1.0; +https://butterflai.social)', Accept: 'text/html' } });
      if (r.status >= 300 && r.status < 400) {
        const next = r.headers.get('location');
        url = next ? await publicUrl(new URL(next, url).href) : null;
        continue;
      }
      if (!r.ok || !/html/i.test(r.headers.get('content-type') || 'text/html')) return null;
      let html = '';
      if (r.body && r.body.getReader) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        while (html.length < 512 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          html += dec.decode(value, { stream: true });
          if (/<\/head>/i.test(html)) break;
        }
        try { reader.cancel(); } catch (_) {}
      } else html = String(await r.text()).slice(0, 512 * 1024);
      return pick(html, url);
    } catch (_) { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

module.exports = { find, pick, privateIp, publicUrl, _setFetch, _setLookup };
