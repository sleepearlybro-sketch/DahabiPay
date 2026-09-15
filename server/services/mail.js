/* ==========================================================================
   Outbound email.

   With SMTP_HOST unset, messages are written to the log instead of sent -
   which is what you want in development, and means verification and reset
   flows are testable with no mail account. A real SMTP transport drops in
   at sendSmtp() without touching any caller.
   ========================================================================== */

import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';

const enabled = () => !!config.mail.host;

/* ------------------------------------------------------------- templates */
const shell = (title, body) => `${title}

${body}

--
Dahabi Pay
${config.origin}
`;

export const templates = {
  verify: (link) => ({
    subject: 'Confirm your Dahabi Pay email',
    text: shell('Confirm your email',
      `Open this link to activate your account:\n${link}\n\nThe link is valid for 24 hours. If you did not create an account, ignore this message.`)
  }),

  reset: (link) => ({
    subject: 'Reset your Dahabi Pay password',
    text: shell('Password reset',
      `Open this link to choose a new password:\n${link}\n\nThe link is valid for 1 hour and can be used once. If you did not request this, ignore this message - your password has not changed.`)
  }),

  orderCreated: (order, from, to, link) => ({
    subject: `Application ${order.id} created`,
    text: shell(`Application ${order.id}`,
      `Send ${order.send_amount} ${from.code} to receive ${order.recv_amount} ${to.code}.\n` +
      `Pay to: ${order.deposit_address || 'see the order page'}\n` +
      `The quoted rate is held until ${order.lock_expires_at}.\n\nTrack it here:\n${link}`)
  }),

  orderStatus: (order, label, link) => ({
    subject: `Application ${order.id}: ${label}`,
    text: shell(`Application ${order.id}`,
      `Status is now: ${label}.\n\nView the order:\n${link}`)
  })
};

/* ----------------------------------------------------------------- send */
/**
 * Minimal SMTP over TLS. Enough for transactional mail; swap for nodemailer
 * if you need attachments, pooling or DKIM signing.
 */
function sendSmtp({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const { host, port, user, pass, from } = config.mail;
    const useTls = port === 465;
    const socket = useTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let step = 0;
    const script = [
      `EHLO dahabipay`,
      user ? `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}` : null,
      `MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '')}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '', text, '.'
      ].join('\r\n'),
      'QUIT'
    ].filter(Boolean);

    const done = (err) => {
      socket.removeAllListeners();
      try { socket.end(); } catch { /* already gone */ }
      err ? reject(err) : resolve({ sent: true });
    };

    socket.setTimeout(15_000, () => done(new Error('SMTP timeout')));
    socket.on('error', done);
    socket.on('data', (buf) => {
      const line = buf.toString();
      if (/^[45]\d\d/.test(line)) return done(new Error(`SMTP refused: ${line.trim()}`));
      if (step >= script.length) return done(null);
      socket.write(script[step++] + '\r\n');
    });
  });
}

/**
 * Send a message. Never throws into a request: a mail outage must not fail
 * an order or a registration, so failures are logged and reported back.
 */
export async function send({ to, subject, text }) {
  if (!enabled()) {
    console.log('\n--- email (not sent, SMTP_HOST unset) ---');
    console.log('to:      %s', to);
    console.log('subject: %s', subject);
    console.log('%s', text.trim());
    console.log('--- end email ---\n');
    return { sent: false, logged: true };
  }
  try {
    await sendSmtp({ to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error('email to %s failed: %s', to, err.message);
    return { sent: false, error: err.message };
  }
}

export const sendTemplate = (to, tpl) => send({ to, ...tpl });
