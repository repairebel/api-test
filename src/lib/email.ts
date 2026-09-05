import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env.js';

// ── SMTP transporter (singleton) ──

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // true for 465 (SSL), false for 587 (STARTTLS)
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function refreshSmtpTransporter(): Promise<void> {
  if (transporter) {
    try {
      transporter.close();
    } catch {}
  }
  transporter = null;
  await verifySmtp();
}

/** Verify the SMTP connection works. Call during app startup. */
export async function verifySmtp(): Promise<void> {
  try {
    await getTransporter().verify();
    console.log('✅ SMTP connection verified');
  } catch (err) {
    console.error('⚠️  SMTP verification failed — emails will not be sent:', err);
  }
}

// ── Generic send helper ──

interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface EmailAttachment {
  filename: string;
  path: string;
  cid: string;
}

export async function sendMail({ to, subject, text, html }: SendMailOptions): Promise<void> {
  const logoAttachment = getEmailLogoAttachment();

  await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text,
    html,
    attachments: logoAttachment ? [logoAttachment] : [],
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface BrandedEmailOptions {
  title: string;
  previewText?: string;
  intro: string;
  bodyHtml?: string;
  footerNote?: string;
}

const emailModuleDir = dirname(fileURLToPath(import.meta.url));
const emailLogoCandidates = [
  resolve(emailModuleDir, '../../../admin/src/assets/logo.png'),
  resolve(emailModuleDir, '../../../webpage/public/images/logo.png'),
];

const EMAIL_LOGO_CID = 'repairrebel-logo';

function getEmailLogoAttachment(): EmailAttachment | null {
  for (const filePath of emailLogoCandidates) {
    if (!existsSync(filePath)) continue;

    return {
      filename: 'repairrebel-logo.png',
      path: filePath,
      cid: EMAIL_LOGO_CID,
    };
  }

  return null;
}

function nl2brHtml(input: string): string {
  return escapeHtml(input).replace(/\n/g, '<br />');
}

type DetailTone = 'default' | 'success' | 'warning' | 'danger';

function getToneColor(tone: DetailTone): string {
  if (tone === 'success') return '#22c55e';
  if (tone === 'warning') return '#f59e0b';
  if (tone === 'danger') return '#ef4444';
  return '#f5f5f5';
}

function buildDetailRowsHtml(
  rows: Array<{ label: string; value: string; tone?: DetailTone }>,
): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;border-collapse:separate;border-spacing:0 10px;">
      ${rows
        .map((row) => {
          const color = getToneColor(row.tone ?? 'default');
          return `
            <tr>
              <td style="padding:14px 16px;background:#16171c;border:1px solid #24252c;border-radius:14px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#8f9098;font-weight:700;padding-bottom:6px;">
                      ${escapeHtml(row.label)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;line-height:1.45;color:${color};font-weight:700;">
                      ${escapeHtml(row.value)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          `;
        })
        .join('')}
    </table>
  `.trim();
}

function buildMessagePanelHtml(message: string): string {
  return `
    <div style="margin-top:22px;padding:18px 18px 16px;background:#16171c;border:1px solid #24252c;border-radius:18px;">
      <p style="margin:0;font-size:15px;line-height:1.8;color:#d8d9df;">${nl2brHtml(message)}</p>
    </div>
  `.trim();
}

function buildStatusPillHtml(label: string, tone: DetailTone = 'default'): string {
  const color = getToneColor(tone);
  const bg =
    tone === 'success'
      ? 'rgba(34,197,94,0.12)'
      : tone === 'warning'
        ? 'rgba(245,158,11,0.14)'
        : tone === 'danger'
          ? 'rgba(239,68,68,0.14)'
          : 'rgba(225,29,72,0.12)';

  return `
    <span style="display:inline-block;padding:9px 12px;border-radius:999px;background:${bg};border:1px solid rgba(255,255,255,0.06);color:${color};font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;">
      ${escapeHtml(label)}
    </span>
  `.trim();
}

function buildCodePanelHtml(code: string, caption: string): string {
  return `
    <div style="margin:22px 0 0;padding:22px;background:linear-gradient(180deg,#191218 0%,#121317 100%);border:1px solid rgba(225,29,72,0.28);border-radius:20px;">
      <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#f87171;font-weight:800;margin-bottom:12px;">Verification Code</div>
      <div style="font-family:'SFMono-Regular','Roboto Mono','Courier New',monospace;font-size:30px;line-height:1.2;letter-spacing:0.32em;color:#ffffff;font-weight:800;text-align:center;padding:14px 10px;border-radius:16px;background:#0b0b0d;border:1px solid rgba(255,255,255,0.08);">
        ${escapeHtml(code)}
      </div>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.7;color:#a5a7b1;text-align:center;">
        ${escapeHtml(caption)}
      </p>
    </div>
  `.trim();
}

function buildBrandedEmailHtml({
  title,
  previewText,
  intro,
  bodyHtml = '',
  footerNote = '— The RepairRebel Team',
}: BrandedEmailOptions): string {
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeFooter = escapeHtml(footerNote);
  const safePreview = escapeHtml(previewText ?? intro);
  const logoAttachment = getEmailLogoAttachment();
  const logoMarkup = logoAttachment
    ? `<img src="cid:${EMAIL_LOGO_CID}" alt="RepairRebel logo" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:18px;" />`
    : `<div style="display:inline-block;width:56px;height:56px;line-height:56px;text-align:center;background:#e11d48;border-radius:18px;color:#ffffff;font-weight:900;font-size:22px;">RR</div>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#060607;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${safePreview}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#060607;">
    <tr>
      <td align="center" style="padding:28px 14px 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;border-collapse:separate;border-spacing:0;">
          <tr>
            <td style="padding:0 0 14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;border:1px solid #1f2026;border-radius:28px;overflow:hidden;">
                <tr>
                  <td style="padding:0;height:4px;background:#e11d48;"></td>
                </tr>
                <tr>
                  <td style="padding:24px 24px 14px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="vertical-align:middle;width:72px;">
                          ${logoMarkup}
                        </td>
                        <td style="vertical-align:middle;padding-left:14px;">
                          <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#f87171;font-weight:800;margin-bottom:6px;">RepairRebel Network</div>
                          <div style="font-size:24px;line-height:1.2;color:#ffffff;font-weight:800;">${safeTitle}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#101114;border:1px solid #212229;border-radius:28px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.34);">
                <tr>
                  <td style="padding:28px 24px 14px;">
                    <div style="margin-bottom:18px;">
                      ${buildStatusPillHtml('Official RepairRebel Email')}
                    </div>
                    <p style="margin:0;font-size:16px;line-height:1.85;color:#e5e7eb;">
                      ${safeIntro}
                    </p>
                    ${bodyHtml}
                  </td>
                </tr>
                <tr>
                  <td style="padding:6px 24px 22px;">
                    <div style="padding:18px 18px 16px;background:#15161b;border:1px solid #24252c;border-radius:18px;">
                      <p style="margin:0 0 6px;font-size:13px;line-height:1.7;color:#ffffff;font-weight:700;">Need help?</p>
                      <p style="margin:0;font-size:13px;line-height:1.7;color:#a5a7b1;">
                        Reply to this email or contact <span style="color:#ffffff;">support@repairebel.com</span>.
                      </p>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 24px 24px;">
                    <hr style="border:none;border-top:1px solid #24252c;margin:0 0 16px;" />
                    <p style="margin:0;color:#ffffff;font-size:12px;line-height:1.7;font-weight:700;">${safeFooter}</p>
                    <p style="margin:8px 0 0;color:#8f9098;font-size:11px;line-height:1.7;">
                      © ${new Date().getFullYear()} RepairRebel. Black, bold, and built for faster repairs.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:12px;text-align:center;">
              <p style="margin:0;font-size:11px;line-height:1.7;color:#666872;">
                This email was sent from RepairRebel system services for your account activity.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ── Password reset email ──

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  expiresInMinutes: number = 15,
): Promise<void> {
  const subject = 'Reset your RepairRebel password';

  const text = [
    'Hi,',
    '',
    'You requested to reset your password for RepairRebel.',
    '',
    `Your password reset code is: ${resetToken}`,
    '',
    `This code expires in ${expiresInMinutes} minutes.`,
    '',
    'If you did not request this, please ignore this email.',
    '',
    '— The RepairRebel Team',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: 'Reset Your Password',
    previewText: `Use ${resetToken} to reset your RepairRebel password.`,
    intro: 'We received a request to reset the password for your RepairRebel account.',
    bodyHtml: `
      ${buildCodePanelHtml(resetToken, `This reset code expires in ${expiresInMinutes} minutes.`)}
      ${buildMessagePanelHtml('If you did not request this reset, you can ignore this email safely and your account will stay protected.')}
    `,
  });

  await sendMail({ to, subject, text, html });
}

export async function sendOrderBookingConfirmationEmail(
  to: string,
  data: { customerName?: string | null; shopName: string; jobId: string; amountCents: number; deviceLabel: string },
): Promise<void> {
  const subject = 'Your repair booking is confirmed';
  const text = [
    `Hi ${data.customerName ?? 'there'},`,
    '',
    `Your booking has been confirmed with ${data.shopName}.`,
    `Device: ${data.deviceLabel}`,
    `Amount held: ${formatUsd(data.amountCents)}`,
    `Job ID: ${data.jobId}`,
    '',
    'You can track progress in the app.',
    '',
    '— The RepairRebel Team',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: 'Booking Confirmed',
    previewText: `${data.shopName} confirmed your repair booking.`,
    intro: `Your repair request has been booked with ${data.shopName}.`,
    bodyHtml: buildDetailRowsHtml([
      { label: 'Device', value: data.deviceLabel },
      { label: 'Amount Held', value: formatUsd(data.amountCents), tone: 'warning' },
      { label: 'Job ID', value: data.jobId },
    ]),
  });

  await sendMail({ to, subject, text, html });
}

export async function sendProfileUpdatedEmail(
  to: string,
  data: { customerName?: string | null; changedFields: string[] },
): Promise<void> {
  const changed = data.changedFields.length > 0 ? data.changedFields.join(', ') : 'Profile details';
  const subject = 'Your profile was updated';
  const text = [
    `Hi ${data.customerName ?? 'there'},`,
    '',
    'Your RepairRebel profile was updated successfully.',
    `Updated fields: ${changed}`,
    '',
    'If this was not you, please secure your account immediately.',
    '',
    '— The RepairRebel Team',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: 'Profile Updated',
    previewText: 'Your RepairRebel account details were updated.',
    intro: 'Your account profile was updated successfully.',
    bodyHtml: `
      ${buildDetailRowsHtml([{ label: 'Updated Fields', value: changed }])}
      ${buildMessagePanelHtml('If you did not make this change, reset your password immediately and contact support so we can help secure your account.')}
    `,
  });

  await sendMail({ to, subject, text, html });
}

export async function sendPayoutCompletedEmail(
  to: string,
  data: { shopName: string; payoutId: string; netAmountCents: number; platformFeeCents: number },
): Promise<void> {
  const subject = 'Your payout has been completed';
  const text = [
    `Hi ${data.shopName},`,
    '',
    'A payout for your shop has been marked as completed.',
    `Payout ID: ${data.payoutId}`,
    `Net amount: ${formatUsd(data.netAmountCents)}`,
    `Platform fee: ${formatUsd(data.platformFeeCents)}`,
    '',
    '— The RepairRebel Team',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: 'Payout Completed',
    previewText: `A payout for ${data.shopName} has been completed.`,
    intro: `A payout for ${data.shopName} has been confirmed.`,
    bodyHtml: buildDetailRowsHtml([
      { label: 'Payout ID', value: data.payoutId },
      { label: 'Net Amount', value: formatUsd(data.netAmountCents), tone: 'success' },
      { label: 'Platform Fee', value: formatUsd(data.platformFeeCents) },
    ]),
  });

  await sendMail({ to, subject, text, html });
}

export async function sendProtectionNewSubscriberEmail(
  to: string,
  data: {
    shopName: string;
    planName: string;
    customerName: string;
    billingType: 'MONTHLY' | 'ONE_TIME';
    priceCents: number;
    status: 'ACTIVE' | 'PAST_DUE';
  },
): Promise<void> {
  const subject = `New protection subscriber for ${data.shopName}`;
  const billingLabel = data.billingType === 'MONTHLY' ? 'Monthly' : 'One-time';
  const text = [
    `Hi ${data.shopName},`,
    '',
    `You have a new protection subscriber: ${data.customerName}`,
    `Plan: ${data.planName}`,
    `Billing: ${billingLabel}`,
    `Price: ${formatUsd(data.priceCents)}`,
    `Status: ${data.status}`,
    '',
    '— The RepairRebel Team',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: 'New Protection Subscriber',
    previewText: `${data.customerName} subscribed to your protection plan.`,
    intro: `${data.customerName} subscribed to one of your protection plans.`,
    bodyHtml: `
      ${buildDetailRowsHtml([
        { label: 'Plan', value: data.planName },
        { label: 'Billing', value: billingLabel },
        { label: 'Price', value: formatUsd(data.priceCents), tone: 'success' },
        { label: 'Status', value: data.status, tone: data.status === 'ACTIVE' ? 'success' : 'warning' },
      ])}
    `,
  });

  await sendMail({ to, subject, text, html });
}

export async function sendAdminBroadcastEmail(
  to: string,
  data: { title: string; body: string; category?: string },
): Promise<void> {
  const subject = data.title;
  const text = [
    data.title,
    '',
    data.body,
    '',
    '— RepairRebel Admin',
  ].join('\n');

  const html = buildBrandedEmailHtml({
    title: data.title,
    previewText: data.body,
    intro: 'This is an official update from the RepairRebel admin team.',
    bodyHtml: `
      ${data.category ? `<div style="margin-top:22px;">${buildStatusPillHtml(data.category, 'danger')}</div>` : ''}
      ${buildMessagePanelHtml(data.body)}
    `,
    footerNote: '— RepairRebel Admin',
  });

  await sendMail({ to, subject, text, html });
}
