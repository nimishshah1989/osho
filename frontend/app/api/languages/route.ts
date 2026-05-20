import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// FastAPI runs on the same VPS — the proxy reaches it over loopback.
// `api.oshoarchives.com` would 403 a same-box request (Cloudflare-only
// ingress), so never use the public hostname here.
const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

export async function GET() {
  try {
    const r = await fetch(`${API_BASE}/api/languages`, { cache: 'no-store' });
    const body = await r.json().catch(() => null);
    if (!r.ok) return NextResponse.json({ languages: [] });
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ languages: [] });
  }
}
