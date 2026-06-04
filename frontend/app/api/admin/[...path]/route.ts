import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// FastAPI runs on the same VPS — the proxy reaches it over loopback.
// `api.oshoarchives.com` would 403 a same-box request (Cloudflare-only
// ingress), so never use the public hostname here.
const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

async function proxy(request: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path.join('/');
  const url = new URL(request.url);
  const target = `${API_BASE}/admin/${path}${url.search}`;

  const contentType = request.headers.get('content-type') ?? '';
  const isMultipart = contentType.startsWith('multipart/form-data');

  const headers: Record<string, string> = {};
  const adminKey = request.headers.get('x-admin-key');
  if (adminKey) headers['x-admin-key'] = adminKey;

  // For multipart uploads, preserve the original Content-Type (it carries the
  // boundary token that the backend needs to parse form fields + file).
  // For everything else, keep the existing JSON behaviour.
  if (isMultipart) {
    headers['content-type'] = contentType;
  } else {
    headers['Content-Type'] = 'application/json';
  }

  // RequestInit extended with duplex which Node fetch requires for streaming bodies.
  const init = { method: request.method, headers } as RequestInit & { duplex?: string };
  if (!['GET', 'HEAD'].includes(request.method)) {
    if (isMultipart) {
      // Stream directly — avoids buffering the entire upload in memory.
      // duplex: 'half' is required by Node.js fetch when body is a ReadableStream.
      init.body = request.body;
      init.duplex = 'half';
    } else {
      init.body = await request.text();
    }
  }

  try {
    const res = await fetch(target, init);
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? {}, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Admin API unreachable' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
