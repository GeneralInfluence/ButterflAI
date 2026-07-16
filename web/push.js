/**
 * push.js — Web Push notification helper
 *
 * Sends browser push notifications to all subscribed devices for a user.
 * Falls back silently if VAPID keys are not configured (dev/test).
 */
'use strict';

const webpush = require('web-push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:hello@butterflai.social';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

/**
 * Send a push notification to all subscribed devices for a user.
 * @param {object} db         - db module
 * @param {string} userId     - recipient user id
 * @param {object} payload    - { title, body, url? }
 */
async function notifyUser(db, userId, { title, body, url = '/app/chat' }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // not configured

  const subs = db.getPushSubscriptions(userId);
  if (!subs || !subs.length) return;

  const data = JSON.stringify({ title, body, url });

  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        data
      );
    } catch (err) {
      // 410 Gone = subscription expired/unsubscribed — clean up
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.deletePushSubscription(sub.endpoint);
      }
    }
  }));
}

module.exports = { notifyUser, VAPID_PUBLIC };
