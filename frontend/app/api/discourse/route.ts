import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://13.206.34.214:8000';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = searchParams.get('title');
  const eventId = searchParams.get('event_id');

  if (!title && !eventId) {
    return NextResponse.json({ error: 'Provide title or event_id' }, { status: 400 });
  }

  const upstream = new URL(`${API_BASE}/api/discourse`);
  if (title) upstream.searchParams.set('title', title);
  if (eventId) upstream.searchParams.set('event_id', eventId);

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
