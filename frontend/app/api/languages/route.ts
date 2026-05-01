import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://13.206.34.214:8000';

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
