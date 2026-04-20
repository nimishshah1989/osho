import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://13.206.34.214:8000';

export async function GET() {
  try {
    const response = await fetch(`${API_BASE}/api/engine-status`, { cache: 'no-store' });
    if (!response.ok) {
      return NextResponse.json(
        { error: 'engine-status unavailable', status: response.status },
        { status: response.status },
      );
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Engine-status proxy failed:', error);
    return NextResponse.json({ error: 'engine-status unreachable' }, { status: 502 });
  }
}
