/**
 * Unified data layer.
 *
 * Every page in the app talks to this module instead of `fetch('/api/...')`.
 * Internally it routes through one of two backends:
 *
 *   - Local engine — when the PWA's offline DB is downloaded and open,
 *     queries run in-process via the worker. No network. Microsecond
 *     latency for cached queries, near-instant cold queries.
 *
 *   - FastAPI proxy — fallback while the local DB is downloading, or
 *     when the browser doesn't support OPFS at all (older Safari,
 *     in-app webviews, etc.). Same JSON shape as the local engine,
 *     so callers don't care which one served the request.
 *
 * The `OfflineEngine | null` parameter is passed in explicitly from
 * the React provider (`OfflineProvider`) rather than read from a
 * module-level singleton — keeps the layer testable and avoids stale
 * closures on engine swap.
 */
import type {
  CatalogResponse,
  DateRangeResponse,
  DiscourseOptions,
  LanguagesResponse,
} from './engine';
import type {
  OfflineEngine,
} from './worker/client';
import type {
  SearchOptions,
  SearchResponse,
  DiscourseResponse,
} from './types';


// ─── Search ─────────────────────────────────────────────────────────────


export async function searchApi(
  opts: SearchOptions,
  engine: OfflineEngine | null,
): Promise<SearchResponse> {
  if (engine) return engine.search(opts);

  const params = new URLSearchParams({ q: opts.q });
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.language) params.set('language', opts.language);
  if (opts.original) params.set('original', 'true');
  if (opts.exact)    params.set('exact',    'true');
  if (opts.dateFrom) params.set('date_from', opts.dateFrom);
  if (opts.dateTo)   params.set('date_to',   opts.dateTo);
  const r = await fetch(`/api/ask?${params.toString()}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((body && body.error) || `Archive unreachable (HTTP ${r.status})`);
  }
  if (!body) {
    throw new Error('Archive returned an empty response.');
  }
  return body as SearchResponse;
}


// ─── Discourse ──────────────────────────────────────────────────────────


export async function discourseApi(
  opts: DiscourseOptions,
  engine: OfflineEngine | null,
): Promise<DiscourseResponse> {
  if (engine) return engine.discourse(opts);

  const params = new URLSearchParams();
  if (opts.title)   params.set('title',   opts.title);
  if (opts.eventId) params.set('event_id', opts.eventId);
  if (opts.q)       params.set('q', opts.q);
  if (opts.exact)   params.set('exact',   'true');
  const r = await fetch(`/api/discourse?${params.toString()}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((body && body.error) || `Discourse unavailable (HTTP ${r.status})`);
  }
  return body as DiscourseResponse;
}


// ─── Catalog ────────────────────────────────────────────────────────────


export async function catalogApi(engine: OfflineEngine | null): Promise<CatalogResponse> {
  if (engine) return engine.catalog();
  const r = await fetch('/api/catalog', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Catalog unreachable (HTTP ${r.status})`);
  return body as CatalogResponse;
}


// ─── Languages ──────────────────────────────────────────────────────────


export async function languagesApi(engine: OfflineEngine | null): Promise<LanguagesResponse> {
  if (engine) return engine.languages();
  const r = await fetch('/api/languages', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Languages unreachable (HTTP ${r.status})`);
  return body as LanguagesResponse;
}


// ─── Date range ────────────────────────────────────────────────────────


export async function dateRangeApi(engine: OfflineEngine | null): Promise<DateRangeResponse> {
  if (engine) return engine.dateRange();
  const r = await fetch('/api/date-range', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Date range unreachable (HTTP ${r.status})`);
  return body as DateRangeResponse;
}
