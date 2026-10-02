import { del, head, presignPut } from './r2';
import { config } from './config';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

export function uploadPathname(id: string): string {
  return `submissions/${id}.zip`;
}

export function maxZipBytes(): number {
  return config.maxZipMb * 1024 * 1024;
}

/** A one-off presigned URL the browser can PUT this zip to (fixed pathname,
 *  15 minutes). Size and zip header are re-checked in checkUploadedZip. */
export async function presignZipUpload(id: string): Promise<string> {
  return presignPut(uploadPathname(id), UPLOAD_URL_TTL_MS / 1000);
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
