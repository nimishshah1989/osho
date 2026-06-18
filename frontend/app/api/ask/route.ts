import { NextResponse } from 'next/server';
import { streamingJsonProxy } from '../../../lib/streamProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// FastAPI runs on the same VPS — the proxy reaches it over loopback.
// `api.oshoarchives.com` would 403 a same-box request (Cloudflare-only
// ingress), so never use the public hostname here.
const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const sortParam = searchParams.get('sort') ?? 'rank';
  const sort = ['rank', 'title', 'date'].includes(sortParam) ? sortParam : 'rank';

  if (!q || typeof q !== 'string' || !q.trim()) {
    return NextResponse.json({ error: 'No query provided' }, { status: 400 });
  }

  const params = new URLSearchParams({
    q,
    sort,
  });

  const language = searchParams.get('language');
  if (language) params.set('language', language);
  const original = searchParams.get('original');
  if (original) params.set('original', original);
  const exact = searchParams.get('exact');
  if (exact) params.set('exact', exact);
  const dateFrom = searchParams.get('date_from');
  if (dateFrom) params.set('date_from', dateFrom);
  const dateTo = searchParams.get('date_to');
  if (dateTo) params.set('date_to', dateTo);

  // Stream a heartbeat while the (sometimes multi-second) search runs so a
  // VPN/mobile link can't drop the idle connection. See lib/streamProxy.
  return streamingJsonProxy(`${API_BASE}/api/search?${params.toString()}`);
}
