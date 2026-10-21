/**
 * outnow-ui.js — the Out and about panel (🌴 I'm out, outnow.js), the same on Home's Feeling and on
 * Explore (🐛 #40, Sean 2026-10-20: "Out and about should be the same interface. Maybe shorter").
 * Renders into #out-now. With data-compact on it (Explore), it starts as one line that opens the full
 * form; while you're out it shows the same status, people and "around you" either way.
 * Globals (the buttons call them): loadOut, renderOut, toggleOut, goOut, stopOut, reachOut, answerAsk,
 * addOutAct, setOutActs, openOutForm.
 */
'use strict';
function outEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Its own look, so it works on any page (Home's styles win where they exist).
(function () {
  const st = document.createElement('style');
  st.textContent = `#out-now .card { background: #fff; border-radius: 14px; padding: 14px 16px; box-shadow: 0 1px 4px rgba(0,0,0,.06); margin-bottom: 10px; }
#out-now .feed-item { display: flex; gap: 12px; align-items: flex-start; }
#out-now .feed-icon { font-size: 20px; line-height: 1.3; }
#out-now .card-title { font-size: 15px; font-weight: 600; color: #1a1a1a; }
#out-now .card-sub { font-size: 13px; color: #888; margin-top: 2px; }
#out-now .share-row { display: flex; gap: 8px; flex-wrap: wrap; }
#out-now .chip-btn { background: #fff; border: 1.5px solid #e5e5e5; border-radius: 999px; padding: 8px 14px; font: inherit; font-size: 14px; cursor: pointer; color: #1c1c1e; }
#out-now .empty-state { font-size: 14px; color: #aaa; text-align: center; padding: 14px 0; }
#out-now .feed-item.needs-you { border: 2px solid #6c47ff; }`;
  document.head.appendChild(st);
})();
let outFormOpen = /[?&]out=1\b/.test(location.search);   // opened from Home's "Out and about?
function openOutForm() { outFormOpen = true; renderOut(); }
async function outStayIn() { outFormOpen = false; await fetch('/api/out/in', { method: 'POST' }).catch(() => {}); loadOut(false); }
async function outNotIn() { await fetch('/api/out/in', { method: 'DELETE' }).catch(() => {}); outFormOpen = true; loadOut(false); }
// ── 🌴 I'm out: who's near you now (outnow.js, owner 2026-10-20) ──
let outPicks = new Set(['drink']);
let outMinutes = 20;   // how far they'll go (owner: "willing to drive 5–10 minutes")
const OUT_ACTS = { coffee: '☕ Coffee', drink: '🍺 A drink', dinner: '🍽️ Dinner', hang: '🏖️ Hang out' };
let outView = null;
// 🐛 #38: your own activities ("a hike", "skiing", "beer at the park") next to the four presets.
const outLabel = (a) => OUT_ACTS[a] || a;
const pickStyle = 'background:#ede9fe;border-color:#6c47ff;color:#6c47ff';
function outChips(list) {
  return list.map((k) => `<button class="chip-btn" style="${outPicks.has(k) ? pickStyle : ''}" data-act="${outEsc(k)}" onclick="toggleOut(this.dataset.act)">${outEsc(outLabel(k))}</button>`).join('');
}
function addOutAct(inputId, then) {
  const el = document.getElementById(inputId);
  const t = (el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t) { el.focus(); return; }
  el.value = '';
  then(t);
}
async function setOutActs(list) {
  await fetch('/api/out', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ up_for: list }) }).catch(() => {});
  loadOut(false);
}
function hereNow() {
  return new Promise((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => ok(p.coords), no, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }) : no(new Error('no location')));
}
async function loadOut(refreshSpot) {
  try {
    outView = await fetch('/api/out').then((r) => r.json());
    if (outView.me && refreshSpot) {   // still out: update where you are (rounded on the server)
      hereNow().then((c) => fetch('/api/out/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: c.latitude, lng: c.longitude }) }).then(() => loadOut(false))).catch(() => {});
    }
  } catch (_) { outView = null; }
  renderOut();
}
function renderOut() {
  const el = document.getElementById('out-now'); if (!el) return;
  const v = outView || { me: null, friends: [], others: [], asks: [] };
  const asks = (v.asks || []).map((a) => `<div class="card feed-item needs-you"><span class="feed-icon">👋</span><div style="flex:1;min-width:0">
    <div class="card-title">${outEsc(a.name)} is out near you</div><div class="card-sub">Up for ${outEsc(a.activity)}</div>
    <div class="share-row" style="margin:6px 0 0"><button class="chip-btn" onclick="answerAsk('${outEsc(a.id)}', true, this)">I’m in</button><button class="chip-btn" onclick="answerAsk('${outEsc(a.id)}', false, this)">Not now</button></div></div></div>`).join('');
  // Home: one line that leads to Explore — the form and the people nearby are a step away, not on Home (🐛 #80:
  // "the home screen is supposed to be a decision point … Those details should be in a follow-up screen").
  if (el.dataset.summary) {
    const n = (v.friends || []).length + (v.others || []).length;
    const line = v.me ? `🌴 You’re out${n ? ` · ${n} ${n === 1 ? 'person' : 'people'} nearby` : ''}` : v.in_until ? '🏠 You’re in tonight' : '🌴 Out and about?';
    el.innerHTML = asks + `<a class="card feed-item" href="/app/explore${v.me || v.in_until ? '' : '?out=1'}" style="text-decoration:none;color:inherit;padding:12px 16px;align-items:center">
      <div style="flex:1;min-width:0" class="card-title">${line}</div><span style="color:#6c47ff;font-size:18px">›</span></a>`;
    return;
  }
  // 🏠 In tonight (🐛 #62): it stops asking — one quiet line to change your mind.
  if (!v.me && v.in_until && !outFormOpen) {
    el.innerHTML = asks + `<div class="card feed-item" style="padding:10px 14px"><span class="feed-icon">🏠</span><div style="flex:1;min-width:0">
      <div class="card-sub" style="margin:0">You’re in tonight</div></div>
      <button class="chip-btn" style="flex-shrink:0;padding:6px 12px" onclick="outNotIn()">I’m out after all</button></div>`;
    return;
  }
  if (!v.me && el.dataset.compact && !outFormOpen) {   // Explore: one line that opens the form
    el.innerHTML = asks + `<div class="card feed-item"><span class="feed-icon">🌴</span><div style="flex:1;min-width:0">
      <div class="card-title">Out and about?</div><div class="card-sub">See who’s nearby and up for something</div></div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0"><button class="chip-btn" style="background:#6c47ff;color:#fff;border-color:#6c47ff" onclick="openOutForm()">I’m out</button><button class="chip-btn" onclick="outStayIn()">I’m in</button></div></div>`;
    return;
  }
  if (!v.me) {
    el.innerHTML = asks + `<div class="card feed-item"><span class="feed-icon">🌴</span><div style="flex:1;min-width:0">
      <div class="card-title">Out and about?</div><div class="card-sub">See who’s nearby and up for something</div>
      <div class="share-row" style="margin:6px 0 0;flex-wrap:wrap">${outChips([...new Set([...Object.keys(OUT_ACTS), ...(v.choices || []), ...outPicks])])}</div>
      <div class="share-row" style="margin:6px 0 0"><input id="out-own" maxlength="40" placeholder="Something else? a hike, skiing, beer at the park…" style="flex:1;min-width:0;border:1.5px solid #e5e5e5;border-radius:12px;padding:8px 10px;font:inherit;font-size:14px" onkeydown="if(event.key==='Enter'){event.preventDefault();addOutAct('out-own',(t)=>{outPicks.add(t);renderOut();})}"><button class="chip-btn" onclick="addOutAct('out-own',(t)=>{outPicks.add(t);renderOut();})">Add</button></div>
      <div class="card-sub" style="margin-top:6px">How far will you go?</div>
      <div class="share-row" style="margin:4px 0 0">${[5, 10, 20, 30].map((m) => `<button class="chip-btn" style="${m === outMinutes ? 'background:#ede9fe;border-color:#6c47ff;color:#6c47ff' : ''}" onclick="outMinutes = ${m}; renderOut()">${m} min</button>`).join('')}</div>
      <label style="display:block;font-size:13px;color:#3a3a3c;margin-top:6px"><input type="checkbox" id="out-new" onchange="document.getElementById('out-adult-row').style.display = this.checked ? 'block' : 'none'"> Open to meeting new people</label>
      <label id="out-adult-row" style="display:none;font-size:13px;color:#3a3a3c"><input type="checkbox" id="out-adult"> I’m 18 or older</label>
      <button class="chip-btn" style="margin-top:8px;background:#6c47ff;color:#fff;border-color:#6c47ff" onclick="goOut(this)">I’m out</button>
      <button class="chip-btn" style="margin-top:8px" onclick="outStayIn()">I’m in tonight</button>
      <div class="card-sub" id="out-err"></div></div></div>`;
    return;
  }
  const until = new Date(v.me.until * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const friends = v.friends.map((f) => `<div class="card feed-item"><span class="feed-icon">💛</span><div style="flex:1;min-width:0">
    <div class="card-title">${outEsc(f.name)} is out too · ${outEsc(f.distance)}</div><div class="card-sub">Up for ${outEsc(f.up_for)}</div>
    ${f.asked ? '<div class="card-sub">You said hi</div>' : `<button class="chip-btn" style="margin-top:6px" onclick="reachOut('${outEsc(f.id)}', this)">Say hi</button>`}</div></div>`).join('');
  const others = v.others.map((o) => `<div class="card feed-item"><span class="feed-icon">✨</span><div style="flex:1;min-width:0">
    <div class="card-title">Someone ${outEsc(o.distance)} away</div><div class="card-sub">Up for ${outEsc(o.up_for)} too</div>
    ${o.asked ? '<div class="card-sub">You’re interested — they’ll only know if they are too</div>' : `<button class="chip-btn" style="margin-top:6px" onclick="reachOut('${outEsc(o.id)}', this)">I’m interested</button>`}</div></div>`).join('');
  el.innerHTML = asks + `<div class="card feed-item"><span class="feed-icon">🌴</span><div style="flex:1;min-width:0">
    <div class="card-title">You’re out · up for ${outEsc((v.me.labels || v.me.up_for).join(', '))}</div>
    <div class="card-sub">Until ${until}${v.me.minutes ? ` · up to ${v.me.minutes} min away` : ''}${v.me.open_to_new ? ' · open to new people' : ''} · nobody sees where you are, only roughly how far</div>
    <div class="share-row" style="margin:6px 0 0"><input id="out-more" maxlength="40" placeholder="Up for something else too?" style="flex:1;min-width:0;border:1.5px solid #e5e5e5;border-radius:12px;padding:8px 10px;font:inherit;font-size:14px" onkeydown="if(event.key==='Enter'){event.preventDefault();addOutAct('out-more',(t)=>setOutActs([...outView.me.up_for, t]))}"><button class="chip-btn" onclick="addOutAct('out-more',(t)=>setOutActs([...outView.me.up_for, t]))">Add</button></div>
    <button class="chip-btn" style="margin-top:6px" onclick="stopOut()">Stop</button></div></div>`
    + ((v.around || []).length ? `<div class="card feed-item"><span class="feed-icon">📍</span><div style="flex:1;min-width:0">
      <div class="card-title">Around you, people are up for</div>
      <div class="share-row" style="margin:6px 0 0;flex-wrap:wrap">${v.around.map((x) => x.yours
        ? `<span class="chip-btn" style="${pickStyle}">${outEsc(x.label)}${x.count > 1 ? ' · ' + x.count : ''}</span>`
        : `<button class="chip-btn" data-act="${outEsc(x.value)}" onclick="setOutActs([...outView.me.up_for, this.dataset.act])">${outEsc(x.label)}${x.count > 1 ? ' · ' + x.count : ''} · ＋ me too</button>`).join('')}</div></div></div>` : '')
    + (friends || others ? friends + others : '<div class="empty-state">Nobody else nearby is out right now — I’ll show them as they are.</div>');
}
function toggleOut(k) { outPicks.has(k) ? outPicks.delete(k) : outPicks.add(k); renderOut(); }
async function goOut(btn) {
  const err = document.getElementById('out-err');
  const open = document.getElementById('out-new').checked, adult = document.getElementById('out-adult').checked;
  if (!outPicks.size) { err.textContent = 'Pick what you’re up for'; return; }
  if (open && !adult) { err.textContent = 'Meeting new people is for 18 and over'; return; }
  btn.disabled = true; btn.textContent = 'Finding where you are…';
  try {
    const c = await hereNow();
    const r = await fetch('/api/out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ up_for: [...outPicks], lat: c.latitude, lng: c.longitude, open_to_new: open, adult, minutes: outMinutes }) });
    if (!r.ok) { err.textContent = (await r.json()).message || 'Couldn’t start'; btn.disabled = false; btn.textContent = 'I’m out'; return; }
    loadOut(false);
  } catch (_) { err.textContent = 'Allow location for ButterflAI to see who’s nearby'; btn.disabled = false; btn.textContent = 'I’m out'; }
}
async function stopOut() { await fetch('/api/out', { method: 'DELETE' }).catch(() => {}); loadOut(false); }
async function reachOut(id, btn) {
  btn.disabled = true;
  const r = await fetch('/api/out/reach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then((x) => x.json()).catch(() => ({}));
  if (r.event_id) { location.href = '/app/chat?event=' + encodeURIComponent(r.event_id); return; }
  loadOut(false);
}
async function answerAsk(id, yes, btn) {
  btn.disabled = true;
  const r = await fetch('/api/out/asks/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yes }) }).then((x) => x.json()).catch(() => ({}));
  if (r.event_id) { location.href = '/app/chat?event=' + encodeURIComponent(r.event_id); return; }
  loadOut(false);
}

