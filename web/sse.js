'use strict';

/**
 * SSE (Server-Sent Events) push hub.
 *
 * Every open screen of a user gets the push (phone + laptop, two tabs). Each connection is
 * removed only when IT closes.
 *
 * 2026-10-12 (Sean sent a message inside a plan pill and saw no reply until he left and
 * came back): this used to keep ONE connection per user, and a reconnect raced — the old
 * connection's 'close' fired after the new one was saved and removed the NEW one, so the
 * page looked connected but nothing reached it.
 */

const clients = new Map(); // userId → Set<{ res, timer }>

function register(userId, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const conn = { res, timer: null };
  const drop = () => {
    clearInterval(conn.timer);
    const set = clients.get(userId);
    if (!set) return;
    set.delete(conn);
    if (!set.size) clients.delete(userId);
  };
  // Keepalive ping every 20s
  conn.timer = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { drop(); }
  }, 20000);

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(conn);
  res.on('close', drop);
  return drop;
}

/** Close every connection of a user (e.g. logout). */
function unregister(userId) {
  const set = clients.get(userId);
  if (!set) return;
  for (const c of set) { clearInterval(c.timer); try { c.res.end(); } catch (_) {} }
  clients.delete(userId);
}

/** Send to every open screen of this user. True if at least one got it. */
function push(userId, data) {
  const set = clients.get(userId);
  if (!set || !set.size) return false;
  let delivered = false;
  for (const c of [...set]) {
    try { c.res.write(`data: ${JSON.stringify(data)}\n\n`); delivered = true; }
    catch (_) { clearInterval(c.timer); set.delete(c); }
  }
  if (!set.size) clients.delete(userId);
  return delivered;
}

function isConnected(userId) {
  return !!clients.get(userId)?.size;
}

module.exports = { register, unregister, push, isConnected };
