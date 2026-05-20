import { redirect } from 'next/navigation';

// /ask has been moved to / (root). Forward all query params.
export default function AskPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v !== undefined) params.set(k, Array.isArray(v) ? v[0] : v);
  }
  const qs = params.toString();
  redirect(qs ? `/?${qs}` : '/');
}
