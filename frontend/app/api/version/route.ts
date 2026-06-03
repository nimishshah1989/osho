import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

export async function GET() {
  try {
    const r = await fetch(`${API_BASE}/api/version`, { cache: 'no-store' });
    const body = await r.json().catch(() => null);
    if (!r.ok) return NextResponse.json({ corpus_version: null });
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ corpus_version: null });
  }
}
