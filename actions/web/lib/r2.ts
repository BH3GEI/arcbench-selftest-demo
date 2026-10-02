// Cloudflare R2 storage with the small subset of the @vercel/blob API this app
// uses (put / list / del / head). Objects are private; every `url` handed out
// is a short-lived presigned GET, so callers can keep doing fetch(blob.url).
import { createHash, createHmac } from 'node:crypto';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const BUCKET = process.env.R2_BUCKET || 'arcbench-selftest-uploads';
const HOST = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const ENDPOINT = `https://${HOST}/${BUCKET}`;
const GET_URL_TTL_S = 6 * 60 * 60;

const sha256 = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// AWS SigV4 (service s3, region auto). Returns the signed URL when query
// signing, otherwise the headers to send.
function sign(method: string, url: URL, opts: { query?: number; headers?: Record<string, string>; payloadHash?: string } = {}) {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const keyId = process.env.R2_ACCESS_KEY_ID || '';
  const headers: Record<string, string> = { host: url.host, ...(opts.headers || {}) };
  const payloadHash = opts.query ? 'UNSIGNED-PAYLOAD' : opts.payloadHash || 'UNSIGNED-PAYLOAD';
  if (!opts.query) {
    headers['x-amz-date'] = now;
    headers['x-amz-content-sha256'] = payloadHash;
  }
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const signedHeaders = names.join(';');
  if (opts.query) {
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', `${keyId}/${scope}`);
    url.searchParams.set('X-Amz-Date', now);
    url.searchParams.set('X-Amz-Expires', String(opts.query));
    url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);
  }
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [method, url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  let k = hmac('AWS4' + (process.env.R2_SECRET_ACCESS_KEY || ''), day);
  k = hmac(hmac(hmac(k, 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', k).update(toSign).digest('hex');
  if (opts.query) {
    url.searchParams.set('X-Amz-Signature', signature);
    return { url: url.toString(), headers: {} as Record<string, string> };
  }
  const out = { ...headers };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: url.toString(), headers: out };
}

async function r2fetch(method: string, url: string, headers: Record<string, string> = {}, body?: Buffer) {
  const u = new URL(url);
  const s = sign(method, u, { headers, payloadHash: body ? sha256(body) : undefined });
  return fetch(s.url, { method, headers: s.headers, body, cache: 'no-store' });
}

function objectUrl(pathname: string): string {
  return `${ENDPOINT}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}

async function presign(pathname: string, method: 'GET' | 'PUT', ttlSeconds: number): Promise<string> {
  return sign(method, new URL(objectUrl(pathname)), { query: ttlSeconds }).url;
}

export function presignGet(pathname: string, ttlSeconds = GET_URL_TTL_S): Promise<string> {
  return presign(pathname, 'GET', ttlSeconds);
}

export function presignPut(pathname: string, ttlSeconds: number): Promise<string> {
  return presign(pathname, 'PUT', ttlSeconds);
}

type PutBody = string | Buffer | Uint8Array | ArrayBuffer | Blob;
type PutOptions = { contentType?: string; access?: string; addRandomSuffix?: boolean; allowOverwrite?: boolean };

export async function put(pathname: string, body: PutBody, opts: PutOptions = {}): Promise<{ url: string; pathname: string }> {
  const headers: Record<string, string> = {};
  if (opts.contentType) headers['content-type'] = opts.contentType;
  if (opts.allowOverwrite === false) headers['if-none-match'] = '*';
  const data =
    body instanceof Blob ? Buffer.from(await body.arrayBuffer())
    : typeof body === 'string' ? Buffer.from(body)
    : body instanceof ArrayBuffer ? Buffer.from(body)
    : Buffer.from(body);
  const res = await r2fetch('PUT', objectUrl(pathname), headers, data);
  if (!res.ok) throw new Error(`R2 put ${pathname} failed: ${res.status}`);
  return { url: await presignGet(pathname), pathname };
}

export type ListedBlob = { pathname: string; url: string; uploadedAt: Date; size: number };

function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export async function list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{
  blobs: ListedBlob[];
  cursor?: string;
  hasMore: boolean;
}> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('list-type', '2');
  if (opts.prefix) url.searchParams.set('prefix', opts.prefix);
  if (opts.cursor) url.searchParams.set('continuation-token', opts.cursor);
  url.searchParams.set('max-keys', String(Math.min(opts.limit ?? 1000, 1000)));
  const res = await r2fetch('GET', url.toString());
  if (!res.ok) throw new Error(`R2 list failed: ${res.status}`);
  const xml = await res.text();
  const blobs = await Promise.all(
    xmlAll(xml, 'Contents').map(async (c) => {
      const pathname = unescapeXml(xmlAll(c, 'Key')[0] || '');
      return {
        pathname,
        url: await presignGet(pathname),
        uploadedAt: new Date(xmlAll(c, 'LastModified')[0] || 0),
        size: Number(xmlAll(c, 'Size')[0] || 0),
      };
    }),
  );
  const truncated = (xmlAll(xml, 'IsTruncated')[0] || 'false') === 'true';
  const next = xmlAll(xml, 'NextContinuationToken')[0];
  return { blobs, cursor: next ? unescapeXml(next) : undefined, hasMore: truncated };
}

export async function del(pathname: string | string[]): Promise<void> {
  for (const p of Array.isArray(pathname) ? pathname : [pathname]) {
    const res = await r2fetch('DELETE', objectUrl(p));
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${p} failed: ${res.status}`);
  }
}

export async function head(pathname: string): Promise<{ pathname: string; url: string; size: number; contentType: string }> {
  const res = await r2fetch('HEAD', objectUrl(pathname));
  if (!res.ok) throw new Error(`R2 head ${pathname} failed: ${res.status}`);
  return {
    pathname,
    url: await presignGet(pathname),
    size: Number(res.headers.get('content-length') || 0),
    contentType: res.headers.get('content-type') || '',
  };
}
