// Minimal in-memory stand-in for @vercel/blob, just enough to exercise
// lib/store.ts's actual put()/list()/del() usage (including the
// "put() without allowOverwrite rejects an existing path" behaviour the
// store's first-write-wins logic depends on). Shared across a test file via
// the `blobs` map so a global fetch stub can resolve the fake URLs below.
export const blobs = new Map<string, { url: string; uploadedAt: Date; body: string }>();

export function resetFakeBlobStore(): void {
  blobs.clear();
}

function urlFor(path: string): string {
  return `https://fake-blob.test/${path}`;
}

export async function put(
  path: string,
  body: string | Buffer,
  _opts?: Record<string, unknown>,
): Promise<{ url: string }> {
  if (blobs.has(path)) {
    throw new Error(`This blob already exists, use allowOverwrite: true to overwrite it. (${path})`);
  }
  const url = urlFor(path);
  blobs.set(path, { url, uploadedAt: new Date(), body: typeof body === 'string' ? body : body.toString('utf8') });
  return { url };
}

export async function list(opts: {
  prefix?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ blobs: { pathname: string; url: string; uploadedAt: Date }[]; hasMore: boolean; cursor?: string }> {
  const prefix = opts.prefix ?? '';
  const entries = [...blobs.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([pathname, v]) => ({ pathname, url: v.url, uploadedAt: v.uploadedAt }));
  return { blobs: entries, hasMore: false };
}

export async function del(path: string | string[]): Promise<void> {
  for (const p of Array.isArray(path) ? path : [path]) blobs.delete(p);
}

/** Install a global fetch stub that resolves fake-blob.test URLs from this store. */
export function installFakeBlobFetch(): void {
  const realFetch = global.fetch;
  global.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://fake-blob.test/')) {
      const path = url.slice('https://fake-blob.test/'.length);
      const entry = blobs.get(path);
      if (!entry) return new Response(null, { status: 404 });
      return new Response(entry.body, { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
