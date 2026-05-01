import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://13.206.34.214:8000';

export async function GET() {
  try {
    const response = await fetch(`${API_BASE}/api/catalog`, { cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(body ?? { error: 'Catalog fetch failed' }, { status: response.status });
    }
    return NextResponse.json(body);
  } catch (error) {
    console.error('Catalog proxy failed:', error);
    return NextResponse.json(
      { error: 'The archive is unreachable. Please retry shortly.' },
      { status: 500 },
    );
  }
}
