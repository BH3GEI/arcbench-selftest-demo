import { del, head, issueSignedToken, presignUrl } from '@vercel/blob';
import { config } from './config';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
// Browsers label .zip files differently (Windows: x-zip-compressed).
const ZIP_CONTENT_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

export function uploadPathname(id: string): string {
  return `submissions/${id}.zip`;
}

export function maxZipBytes(): number {
  return config.maxZipMb * 1024 * 1024;
}

/** A one-off URL the browser can PUT exactly this zip to: fixed pathname, no
 *  overwrite, size and content type enforced by Blob itself. Works with the
 *  project's OIDC Blob credentials (no read-write token needed). */
export async function presignZipUpload(id: string): Promise<string> {
  const pathname = uploadPathname(id);
  const limits = { allowedContentTypes: ZIP_CONTENT_TYPES, maximumSizeInBytes: maxZipBytes() };
  const token = await issueSignedToken({
    pathname,
    operations: ['put'],
    validUntil: Date.now() + UPLOAD_URL_TTL_MS,
    ...limits,
  });
  const { presignedUrl } = await presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    ...limits,
  });
  return presignedUrl;
}

export type UploadCheck = { ok: true; url: string } | { ok: false; error: string; status: number };

/** Re-checks the uploaded object server-side (the browser's checks are only a
 *  convenience): it exists, is within the size cap, and starts like a zip. */
export async function checkUploadedZip(id: string): Promise<UploadCheck> {
  const pathname = uploadPathname(id);
  const meta = await head(pathname).catch(() => null);
  if (!meta) return { ok: false, error: 'upload not found', status: 400 };
  if (meta.size > maxZipBytes()) {
    await del(pathname).catch(() => undefined);
    return { ok: false, error: `zip exceeds ${config.maxZipMb}MB`, status: 400 };
  }
  const res = await fetch(meta.url, { headers: { Range: 'bytes=0-3' }, cache: 'no-store' });
  const first = res.ok ? Buffer.from(await res.arrayBuffer()).subarray(0, 4) : Buffer.alloc(0);
  if (!first.equals(ZIP_MAGIC)) {
    await del(pathname).catch(() => undefined);
    return { ok: false, error: 'not a zip file', status: 400 };
  }
  return { ok: true, url: meta.url };
}
