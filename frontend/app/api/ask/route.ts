import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://13.206.34.214:8000';

export async function POST(req: Request) {
  try {
    const { query } = await req.json();

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'No query provided' }, { status: 400 });
    }

    const upstream = await fetch(`${API_BASE}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      cache: 'no-store',
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: 'A cloud has obscured the moon. Synthesis failed.', detail },
        { status: upstream.status || 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('Ask proxy failed:', error);
    return NextResponse.json(
      { error: 'A cloud has obscured the moon. Synthesis failed.' },
      { status: 500 },
    );
  }
}
