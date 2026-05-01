import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://13.206.34.214:8000';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const sort = searchParams.get('sort') ?? 'rank';

  if (!q || typeof q !== 'string' || !q.trim()) {
    return NextResponse.json({ error: 'No query provided' }, { status: 400 });
  }

  const params = new URLSearchParams({
    q,
    sort,
  });

  const language = searchParams.get('language');
  if (language) params.set('language', language);
  const dateFrom = searchParams.get('date_from');
  if (dateFrom) params.set('date_from', dateFrom);
  const dateTo = searchParams.get('date_to');
  if (dateTo) params.set('date_to', dateTo);

  try {
    const upstream = await fetch(
      `${API_BASE}/api/search?${params.toString()}`,
      { cache: 'no-store' },
    );
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: (body && body.detail) || 'Archive unreachable.' },
        { status: upstream.status || 502 },
      );
    }
    return NextResponse.json(body);
  } catch (error) {
    console.error('Ask proxy failed:', error);
    return NextResponse.json({ error: 'Archive unreachable.' }, { status: 502 });
  }
}
