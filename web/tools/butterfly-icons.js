/**
 * tools/butterfly-icons.js — make every butterfly the app shows from ONE chosen design
 * (owner, 2026-10-21: "every butterfly in the app should be consistent" — and keep all the options to experiment with).
 *
 *   node tools/butterfly-icons.js [public/icons/butterflies/<design>.png|svg]
 *
 * Writes public/icons/butterfly-current.<ext> (what every page shows) and the app's icons: icon-192.png, icon-512.png
 * (home screen, maskable — the butterfly on pale purple), apple-touch-icon.png, favicon-32.png, ../favicon.png,
 * ../favicon.ico. The design options live in public/icons/butterflies/ and side by side at /app/butterflies.
 * Needs a browser to draw: run with playwright available (e.g. `npx -y -p playwright node tools/butterfly-icons.js …`).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ICONS = path.join(__dirname, '../public/icons');
const src = path.resolve(process.argv[2] || path.join(ICONS, 'butterflies/cyborg-steampunk-purple.png'));
const BG = '#EDE9FE';   // BRANDING.md "Purple Pale" — the butterfly is purple, so it sits on pale purple, not brand purple

(async () => {
  const { chromium } = require('playwright');
  const ext = path.extname(src).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : 'image/png';
  const data = fs.readFileSync(src).toString('base64');
  fs.copyFileSync(src, path.join(ICONS, `butterfly-current.${ext}`));
  for (const other of ['png', 'svg']) if (other !== ext) { try { fs.unlinkSync(path.join(ICONS, `butterfly-current.${other}`)); } catch (_) {} }
  const b = await chromium.launch();
  const p = await b.newPage();
  const out = await p.evaluate(async ({ data, mime, BG }) => {
    const img = new Image(); img.src = `data:${mime};base64,${data}`; await img.decode();
    const draw = (size, { bg = null, scale = 1, round = 0 } = {}) => {
      const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      if (bg) { x.fillStyle = bg; if (round) { x.beginPath(); x.roundRect(0, 0, size, size, size * round); x.fill(); } else x.fillRect(0, 0, size, size); }
      const w = img.naturalWidth || 512, h = img.naturalHeight || 512, k = (size * scale) / Math.max(w, h);
      x.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
      return c.toDataURL('image/png').split(',')[1];
    };
    return { i192: draw(192, { bg: BG, scale: 0.72 }), i512: draw(512, { bg: BG, scale: 0.72 }), apple: draw(180, { bg: BG, scale: 0.78 }),
      f32: draw(32, { scale: 1 }), f64: draw(64, { scale: 1 }), plain128: draw(128) };
  }, { data, mime, BG });
  await b.close();
  const w = (f, b64) => fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  w(path.join(ICONS, 'icon-192.png'), out.i192);
  w(path.join(ICONS, 'icon-512.png'), out.i512);
  w(path.join(ICONS, 'apple-touch-icon.png'), out.apple);
  w(path.join(ICONS, 'favicon-32.png'), out.f32);
  w(path.join(ICONS, '../favicon.png'), out.f64);
  w(path.join(ICONS, 'butterfly-128.png'), out.plain128);
  // favicon.ico: one 32px PNG inside an ICO header (browsers accept PNG-in-ICO).
  const png = Buffer.from(out.f32, 'base64');
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(32, 6); head.writeUInt8(32, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(ICONS, '../favicon.ico'), Buffer.concat([head, png]));
  console.log(`butterfly: ${path.relative(path.join(ICONS, '..'), src)} → butterfly-current.${ext}, butterfly-128.png, app icons, favicons`);
})();
