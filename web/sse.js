'use strict';

/**
 * SSE (Server-Sent Events) push hub.
 *
 * Keeps one SSE connection per userId (latest connection wins).
 * Agent calls push(userId, event) after writing a response.
 */

const clients = new Map(); // userId → { res, timer }

function register(userId, res) {
  // Close any existing connection for this user
  const existing = clients.get(userId);
  if (existing) {
    try { existing.res.end(); } catch (_) {}
    clearInterval(existing.timer);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Keepalive ping every 20s
  const timer = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { unregister(userId); }
  }, 20000);

  clients.set(userId, { res, timer });

  res.on('close', () => unregister(userId));
}

function unregister(userId) {
  const c = clients.get(userId);
  if (!c) return;
  clearInterval(c.timer);
  clients.delete(userId);
}

function push(userId, data) {
  const c = clients.get(userId);
  if (!c) return false;
  try {
    c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (_) {
    unregister(userId);
    return false;
  }
}

function isConnected(userId) {
  return clients.has(userId);
}

module.exports = { register, unregister, push, isConnected };
