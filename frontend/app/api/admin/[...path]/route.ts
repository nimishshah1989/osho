import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://13.206.34.214:8000';

async function proxy(request: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path.join('/');
  const url = new URL(request.url);
  const target = `${API_BASE}/admin/${path}${url.search}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const adminKey = request.headers.get('x-admin-key');
  if (adminKey) headers['x-admin-key'] = adminKey;

  const init: RequestInit = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.text();
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
