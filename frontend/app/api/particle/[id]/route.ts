import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://13.206.34.214:8000';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const upstream = await fetch(`${API_BASE}/api/particle/${encodeURIComponent(params.id)}`, {
      cache: 'no-store',
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: 'particle not found' }, { status: upstream.status });
    }
    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Particle proxy failed:', error);
    return NextResponse.json({ error: 'particle fetch failed' }, { status: 500 });
  }
}
