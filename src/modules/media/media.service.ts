import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { jobMedia, jobs } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../plugins/error-handler.plugin.js';
import { getIO } from '../../lib/socket.js';

// ─── Cloudinary Signature ───

type UploadContext = 'JOB_PROOF' | 'CHAT' | 'ONBOARDING' | 'REQUEST_MEDIA' | 'DISPUTE_EVIDENCE' | 'SUPPORT_CHAT';

interface SignatureParams {
  context: UploadContext;
  entityId: string;
  resourceType: 'image' | 'video';
}

export function generateCloudinarySignature(params: SignatureParams) {
  const { context, entityId, resourceType } = params;

  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Cloudinary is not configured');
  }

  let folder: string;
  switch (context) {
    case 'JOB_PROOF':
      folder = `jobs/${entityId}/proof`;
      break;
    case 'CHAT':
      folder = `chat/${entityId}`;
      break;
    case 'ONBOARDING':
      folder = `onboarding/${entityId}`;
      break;
    case 'REQUEST_MEDIA':
      folder = `requests/${entityId}`;
      break;
    case 'DISPUTE_EVIDENCE':
      folder = `disputes/${entityId}`;
      break;
    case 'SUPPORT_CHAT':
      folder = `support/${entityId}`;
      break;
    default:
      folder = `misc/${entityId}`;
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Parameters that must be signed (sorted alphabetically)
  const paramsToSign: Record<string, string | number> = {
    folder,
    timestamp,
  };

  // Build the string to sign: key=value&key=value + api_secret
  const sortedKeys = Object.keys(paramsToSign).sort();
  const signString = sortedKeys
    .map((k) => `${k}=${paramsToSign[k]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(signString + apiSecret)
    .digest('hex');

  return {
    cloudName,
    apiKey,
    signature,
    timestamp,
    folder,
    resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
  };
}

// ─── Store media record ───

interface AddMediaInput {
  jobId: string;
  shopId: string;
  type: 'IMAGE' | 'VIDEO';
  url: string;
  publicId: string;
  thumbUrl?: string;
  durationMs?: number;
  sizeBytes?: number;
  mimeType?: string;
}

export async function addJobMedia(input: AddMediaInput) {
  const { jobId, shopId, type, url, publicId, thumbUrl, durationMs, sizeBytes, mimeType } = input;

  // Verify job belongs to shop
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  // Validate publicId belongs to our Cloudinary account
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) {
    throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Cloudinary is not configured');
  }

  // Validate url contains our cloud name
  if (!url.includes(cloudName)) {
    throw new AppError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'Media URL does not belong to the configured Cloudinary account',
    );
  }

  // Insert media record
  const [media] = await db
    .insert(jobMedia)
    .values({
      jobId,
      shopId,
      type,
      url,
      publicId,
      thumbUrl: thumbUrl ?? null,
      durationMs: durationMs ?? null,
      sizeBytes: sizeBytes ?? null,
      mimeType: mimeType ?? null,
    })
    .returning();

  // Also update the job's proofMedia array (for backward compat)
  const existingMedia = await db
    .select({ url: jobMedia.url })
    .from(jobMedia)
    .where(eq(jobMedia.jobId, jobId));
  const urls = existingMedia.map((m) => m.url);

  await db
    .update(jobs)
    .set({
      proofMedia: urls,
      ...(type === 'VIDEO' ? { shopCompletionVideoUrl: url } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  // Emit Socket.IO
  try {
    const io = getIO();
    const payload = {
      id: media.id,
      jobId,
      type: media.type,
      url: media.url,
      thumbUrl: media.thumbUrl,
      durationMs: media.durationMs,
      createdAt: media.createdAt?.toISOString(),
    };
    io.to(`job:${jobId}`).emit('media:uploaded', payload);
  } catch {}

  return {
    id: media.id,
    jobId: media.jobId,
    type: media.type,
    url: media.url,
    publicId: media.publicId,
    thumbUrl: media.thumbUrl,
    durationMs: media.durationMs,
    sizeBytes: media.sizeBytes,
    mimeType: media.mimeType,
    createdAt: media.createdAt?.toISOString() ?? null,
  };
}

// ─── List media for a job ───

export async function listJobMedia(jobId: string, shopId: string) {
  // Verify job belongs to shop
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.shopId, shopId)))
    .limit(1);

  if (!job) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'Job not found');
  }

  const media = await db
    .select()
    .from(jobMedia)
    .where(eq(jobMedia.jobId, jobId))
    .orderBy(jobMedia.createdAt);

  return media.map((m) => ({
    id: m.id,
    type: m.type,
    url: m.url,
    publicId: m.publicId,
    thumbUrl: m.thumbUrl,
    durationMs: m.durationMs,
    sizeBytes: m.sizeBytes,
    mimeType: m.mimeType,
    createdAt: m.createdAt?.toISOString() ?? null,
  }));
}
