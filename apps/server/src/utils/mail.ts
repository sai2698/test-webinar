import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProd } from '../config/env.js';
import { createLogger } from './logger.js';

const log = createLogger('mail');

/**
 * Outbound email.
 *
 * Three transports, chosen by what is configured:
 *   - SMTP_* set        → real SMTP (works with SES, Postmark, Mailtrap, …)
 *   - RESEND_API_KEY    → Resend's SMTP bridge
 *   - neither           → console transport, which logs the message instead
 *
 * The console fallback matters: local development and CI have no mail server,
 * and a registration flow that throws because it cannot send a receipt is
 * worse than one that quietly prints it.
 */

let transporter: Transporter | null = null;
let transportKind: 'smtp' | 'resend' | 'console' = 'console';

function build(): Transporter {
  if (transporter) return transporter;

  if (env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
    transportKind = 'smtp';
  } else if (env.RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: env.RESEND_API_KEY },
    });
    transportKind = 'resend';
  } else {
    // jsonTransport serialises the message instead of sending it, which is
    // exactly what we want to log.
    transporter = nodemailer.createTransport({ jsonTransport: true });
    transportKind = 'console';
  }

  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Sends one message. Never throws — a failed email must not roll back a
 * payment or a registration that already succeeded.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const tx = build();

  try {
    const info = await tx.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text ?? stripHtml(message.html),
    });

    if (transportKind === 'console') {
      log.info(`[mail:console] to=${message.to} subject="${message.subject}"`);
      if (!isProd) log.debug(String((info as { message?: string }).message ?? ''));
    } else {
      log.info(`[mail:${transportKind}] to=${message.to} id=${info.messageId}`);
    }
    return true;
  } catch (err) {
    log.error(`[mail] failed to ${message.to}`, err);
    return false;
  }
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── templates ─────────────────────────────────────────────── */

function shell(heading: string, body: string, cta?: { label: string; url: string }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0b0f19;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0f19;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#131a2a;border-radius:16px;padding:32px">
        <tr><td>
          <h1 style="margin:0 0 16px;font-size:20px;color:#ffffff">${heading}</h1>
          <div style="font-size:14px;line-height:1.6;color:#a8b3c7">${body}</div>
          ${
            cta
              ? `<div style="margin-top:24px"><a href="${cta.url}" style="display:inline-block;background:#4f7cff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:14px">${cta.label}</a></div>`
              : ''
          }
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function registrationEmail(opts: {
  name: string;
  webinarTitle: string;
  startsAt: Date;
  timezone: string;
  joinUrl: string;
}) {
  const when = opts.startsAt.toLocaleString('en-IN', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: opts.timezone,
  });

  return {
    subject: `You're registered: ${opts.webinarTitle}`,
    html: shell(
      `You're in, ${opts.name.split(' ')[0]}!`,
      `<p style="margin:0 0 12px">Your seat for <strong style="color:#fff">${opts.webinarTitle}</strong> is confirmed.</p>
       <p style="margin:0 0 12px"><strong style="color:#fff">When:</strong> ${when}</p>
       <p style="margin:0">Keep this link private — it is your personal entry pass.</p>`,
      { label: 'Join the webinar', url: opts.joinUrl }
    ),
  };
}

export function reminderEmail(opts: {
  name: string;
  webinarTitle: string;
  startsAt: Date;
  timezone: string;
  joinUrl: string;
  leadLabel: string;
}) {
  const when = opts.startsAt.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: opts.timezone,
  });

  return {
    subject: `${opts.leadLabel}: ${opts.webinarTitle}`,
    html: shell(
      `Starting ${opts.leadLabel.toLowerCase()}`,
      `<p style="margin:0 0 12px">Hi ${opts.name.split(' ')[0]}, <strong style="color:#fff">${opts.webinarTitle}</strong> begins ${opts.leadLabel.toLowerCase()}.</p>
       <p style="margin:0 0 12px"><strong style="color:#fff">When:</strong> ${when}</p>
       <p style="margin:0">Your personal join link is below.</p>`,
      { label: 'Join now', url: opts.joinUrl }
    ),
  };
}

export function enrollmentEmail(opts: {
  name: string;
  courseTitle: string;
  amountPaise: number;
  currency: string;
}) {
  const amount = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: opts.currency,
    maximumFractionDigits: 0,
  }).format(opts.amountPaise / 100);

  return {
    subject: `Enrolled: ${opts.courseTitle}`,
    html: shell(
      `You're enrolled, ${opts.name.split(' ')[0]}!`,
      `<p style="margin:0 0 12px">Your enrolment in <strong style="color:#fff">${opts.courseTitle}</strong> is confirmed.</p>
       <p style="margin:0"><strong style="color:#fff">Amount paid:</strong> ${amount}</p>`,
    ),
  };
}
