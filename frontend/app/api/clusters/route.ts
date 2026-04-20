import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://13.206.34.214:8000';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lens = url.searchParams.get('lens') ?? 'themes';
  const limit = url.searchParams.get('limit') ?? '20';
  try {
    const upstream = await fetch(`${API_BASE}/api/clusters?lens=${encodeURIComponent(lens)}&limit=${encodeURIComponent(limit)}`, {
      cache: 'no-store',
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: 'cluster fetch failed' }, { status: upstream.status });
    }
    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Clusters proxy failed:', error);
    return NextResponse.json({ error: 'cluster fetch failed' }, { status: 500 });
  }
}
