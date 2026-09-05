import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { systemSettings } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { refreshSmtpTransporter } from '../../lib/email.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
const adminSettingsModuleDir = dirname(fileURLToPath(import.meta.url));
const envFilePath = resolve(adminSettingsModuleDir, '../../../.env');

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeEnvValue(value: string | number | boolean): string {
  const stringValue = String(value);

  if (stringValue === '') return '""';
  if (/^[A-Za-z0-9._:/@-]+$/.test(stringValue)) return stringValue;

  return JSON.stringify(stringValue);
}

function persistEnvValues(updates: Record<string, string | number | boolean | undefined>) {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;

  const existingContent = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
  const lines = existingContent.split(/\r?\n/);

  for (const [key, rawValue] of entries) {
    const rendered = `${key}=${serializeEnvValue(rawValue as string | number | boolean)}`;
    const matcher = new RegExp(`^\\s*#?\\s*${escapeRegExp(key)}\\s*=`);
    const existingIndex = lines.findIndex((line) => matcher.test(line));

    if (existingIndex >= 0) {
      lines[existingIndex] = rendered;
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
      lines.push(rendered);
    }
  }

  writeFileSync(envFilePath, `${lines.join('\n').replace(/\n*$/, '\n')}`, 'utf8');
}

function patchRuntimeEnv(updates: Record<string, string | number | boolean | undefined>) {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    (env as Record<string, unknown>)[key] = value;
    process.env[key] = String(value);
  }
}

export async function getSettings() {
  const [settings] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID)).limit(1);
  if (!settings) {
    // Return defaults if no row exists
    return {
      id: SETTINGS_ID,
      commissionPercent: 15,
      insurancePercent: 5,
      instantCashoutEnabled: false,
      maxInstantCashoutCents: 50000,
      dispatchRadiusKm: 25,
      refundLimitAdmin: 500,
      refundLimitModerator: 0,
      disputeAutoCloseDays: 14,
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    };
  }
  // Strip sensitive API keys from the general settings response
  const { cloudinaryApiSecret, stripeSecretKey, stripeWebhookSecret, smtpPass, ...safe } = settings;
  return {
    ...safe,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

export async function updateSettings(data: Record<string, any>) {
  // Whitelist only known setting fields and coerce types
  const patch: Record<string, any> = { updatedAt: new Date() };

  if (data.commissionPercent !== undefined)     patch.commissionPercent     = Number(data.commissionPercent);
  if (data.insurancePercent !== undefined)      patch.insurancePercent      = Number(data.insurancePercent);
  if (data.instantCashoutEnabled !== undefined) patch.instantCashoutEnabled = Boolean(data.instantCashoutEnabled);
  if (data.maxInstantCashoutCents !== undefined) {
    patch.maxInstantCashoutCents = Math.max(100, Number(data.maxInstantCashoutCents) || 0);
  }
  if (data.dispatchRadiusKm !== undefined)      patch.dispatchRadiusKm      = Number(data.dispatchRadiusKm);
  if (data.refundLimitAdmin !== undefined)      patch.refundLimitAdmin      = Number(data.refundLimitAdmin);
  if (data.refundLimitModerator !== undefined)  patch.refundLimitModerator  = Number(data.refundLimitModerator);
  if (data.disputeAutoCloseDays !== undefined)  patch.disputeAutoCloseDays  = Number(data.disputeAutoCloseDays);
  if (data.maintenanceMode !== undefined)       patch.maintenanceMode       = Boolean(data.maintenanceMode);

  // Upsert: try UPDATE first, then INSERT if row does not exist
  let [settings] = await db
    .update(systemSettings)
    .set(patch)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .returning();

  if (!settings) {
    [settings] = await db
      .insert(systemSettings)
      .values({ id: SETTINGS_ID, ...patch })
      .returning();
  }

  // Strip sensitive API keys from response
  const { cloudinaryApiSecret, stripeSecretKey, stripeWebhookSecret, smtpPass, ...safe } = settings;
  return { ...safe, updatedAt: settings.updatedAt?.toISOString() ?? null };
}

// ─── API Keys ───

/** Mask a secret, showing only the last 4 characters */
function mask(val: string | null | undefined): string {
  if (!val) return '';
  if (val.length <= 8) return '••••';
  return '••••••••' + val.slice(-4);
}

/**
 * Get current API key configuration.
 * Secrets are masked; only the last 4 chars are revealed.
 * Falls back to env vars if DB values are empty.
 */
export async function getApiKeys() {
  const [settings] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID)).limit(1);

  const cloudName = env.CLOUDINARY_CLOUD_NAME || settings?.cloudinaryCloudName || '';
  const cloudKey  = env.CLOUDINARY_API_KEY || settings?.cloudinaryApiKey || '';
  const cloudSec  = env.CLOUDINARY_API_SECRET || settings?.cloudinaryApiSecret || '';

  const strSec  = env.STRIPE_SECRET_KEY || settings?.stripeSecretKey || '';
  const strPub  = env.STRIPE_PUBLISHABLE_KEY || settings?.stripePublishableKey || '';
  const strWh   = env.STRIPE_WEBHOOK_SECRET || settings?.stripeWebhookSecret || '';

  const smtpHost = env.SMTP_HOST || settings?.smtpHost || '';
  const smtpPort = env.SMTP_PORT || settings?.smtpPort || 465;
  const smtpUser = env.SMTP_USER || settings?.smtpUser || '';
  const smtpPass = env.SMTP_PASS || settings?.smtpPass || '';
  const smtpFrom = env.SMTP_FROM || settings?.smtpFrom || '';

  return {
    cloudinary: {
      cloudName,
      apiKey: cloudKey,
      apiSecret: mask(cloudSec),
      configured: !!(cloudName && cloudKey && cloudSec),
    },
    stripe: {
      publishableKey: strPub,
      secretKey: mask(strSec),
      webhookSecret: mask(strWh),
      configured: !!strSec,
    },
    smtp: {
      host: smtpHost,
      port: Number(smtpPort),
      user: smtpUser,
      pass: mask(smtpPass),
      from: smtpFrom,
      configured: !!(smtpHost && smtpPort && smtpUser && smtpPass && smtpFrom),
    },
  };
}

/**
 * Update API keys. Empty strings are ignored (won't overwrite).
 * Values are saved to both the DB and server/.env, then the runtime
 * env object is patched so the server uses them immediately.
 */
export async function updateApiKeys(data: {
  cloudinaryCloudName?: string;
  cloudinaryApiKey?: string;
  cloudinaryApiSecret?: string;
  stripeSecretKey?: string;
  stripePublishableKey?: string;
  stripeWebhookSecret?: string;
  smtpHost?: string;
  smtpPort?: number | string;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}) {
  // Build only non-empty updates
  const patch: Record<string, any> = { updatedAt: new Date() };
  if (data.cloudinaryCloudName)  patch.cloudinaryCloudName  = data.cloudinaryCloudName;
  if (data.cloudinaryApiKey)     patch.cloudinaryApiKey     = data.cloudinaryApiKey;
  if (data.cloudinaryApiSecret)  patch.cloudinaryApiSecret  = data.cloudinaryApiSecret;
  if (data.stripeSecretKey)      patch.stripeSecretKey      = data.stripeSecretKey;
  if (data.stripePublishableKey) patch.stripePublishableKey = data.stripePublishableKey;
  if (data.stripeWebhookSecret)  patch.stripeWebhookSecret  = data.stripeWebhookSecret;

  if (data.smtpHost) patch.smtpHost = data.smtpHost;
  if (data.smtpPort !== undefined && data.smtpPort !== null && String(data.smtpPort).trim() !== '') {
    patch.smtpPort = Number(data.smtpPort);
  }
  if (data.smtpUser) patch.smtpUser = data.smtpUser;
  if (data.smtpPass) patch.smtpPass = data.smtpPass;
  if (data.smtpFrom) patch.smtpFrom = data.smtpFrom;

  // Upsert into DB
  let [settings] = await db
    .update(systemSettings)
    .set(patch)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .returning();

  if (!settings) {
    [settings] = await db
      .insert(systemSettings)
      .values({ id: SETTINGS_ID, ...patch })
      .returning();
  }

  const envUpdates: Record<string, string | number | boolean | undefined> = {
    CLOUDINARY_CLOUD_NAME: settings.cloudinaryCloudName || undefined,
    CLOUDINARY_API_KEY: settings.cloudinaryApiKey || undefined,
    CLOUDINARY_API_SECRET: settings.cloudinaryApiSecret || undefined,
    STRIPE_SECRET_KEY: settings.stripeSecretKey || undefined,
    STRIPE_PUBLISHABLE_KEY: settings.stripePublishableKey || undefined,
    STRIPE_WEBHOOK_SECRET: settings.stripeWebhookSecret || undefined,
    SMTP_HOST: settings.smtpHost || undefined,
    SMTP_PORT: settings.smtpPort || undefined,
    SMTP_USER: settings.smtpUser || undefined,
    SMTP_PASS: settings.smtpPass || undefined,
    SMTP_FROM: settings.smtpFrom || undefined,
  };

  persistEnvValues(envUpdates);
  patchRuntimeEnv(envUpdates);

  // Recreate transporter immediately when SMTP settings change
  if (
    data.smtpHost !== undefined ||
    data.smtpPort !== undefined ||
    data.smtpUser !== undefined ||
    data.smtpPass !== undefined ||
    data.smtpFrom !== undefined
  ) {
    await refreshSmtpTransporter();
  }

  console.log('🔑 API keys updated in DB, server/.env, and runtime env');

  return getApiKeys();
}
