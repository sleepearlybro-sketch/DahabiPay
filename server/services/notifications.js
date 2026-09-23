import nodemailer from 'nodemailer';
import { config } from '../config.js';
import * as store from '../store.js';

let transport;
let timer;
let running = false;

function mailer() {
  if (!config.mail.host) return null;
  if (!transport) transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure || config.mail.port === 465,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined
  });
  return transport;
}

function message(row) {
  const p = row.payload || {};
  return {
    from: config.mail.from,
    to: row.recipient,
    subject: `New verified request ${p.reference}`,
    text: [
      'A verified Dahabi Pay exchange request is ready.',
      '',
      `Reference: ${p.reference}`,
      `Customer: ${p.fullName}`,
      `Send: ${p.sendUsdt} USDT (TRC20)`,
      `Receive: ${p.receiveUsd} Money Go USD`,
      '',
      `Open the protected admin panel: ${config.origin}/admin/`
    ].join('\n')
  };
}

export async function processOutbox() {
  if (running || !mailer()) return { processed: 0 };
  running = true;
  let processed = 0;
  try {
    for (const row of await store.pendingNotifications()) {
      try {
        await mailer().sendMail(message(row));
        await store.markNotificationDelivered(row.id);
      } catch (error) {
        await store.markNotificationFailed(row, error.message);
      }
      processed += 1;
    }
  } finally {
    running = false;
  }
  return { processed };
}

export function startNotifications() {
  if (timer) return;
  processOutbox().catch((error) => console.error('notification outbox:', error.message));
  timer = setInterval(() => processOutbox().catch((error) => console.error('notification outbox:', error.message)), 30_000);
  timer.unref();
}

export function stopNotifications() {
  if (timer) clearInterval(timer);
  timer = null;
}
