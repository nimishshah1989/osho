import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// FastAPI runs on the same VPS — the proxy reaches it over loopback.
// `api.oshoarchives.com` would 403 a same-box request (Cloudflare-only
// ingress), so never use the public hostname here.
const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get('title');
  const eventId = searchParams.get('event_id');

  if (!title && !eventId) {
    return NextResponse.json({ error: 'Provide title or event_id' }, { status: 400 });
  }

  const q = searchParams.get('q');
  const exact = searchParams.get('exact');

  const upstream = new URL(`${API_BASE}/api/discourse`);
  if (title) upstream.searchParams.set('title', title);
  if (eventId) upstream.searchParams.set('event_id', eventId);
  if (q) upstream.searchParams.set('q', q);
  if (exact === 'true') upstream.searchParams.set('exact', 'true');

  try {
    const response = await fetch(upstream.toString(), { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        body ?? { error: 'Discourse fetch failed' },
        { status: response.status },
      );
    }
    return NextResponse.json(body);
  } catch (error) {
    console.error('Discourse proxy failed:', error);
    return NextResponse.json(
      { error: 'The archive is unreachable. Please retry shortly.' },
      { status: 500 },
    );
  }
}
