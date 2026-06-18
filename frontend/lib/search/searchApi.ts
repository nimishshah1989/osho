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


// ─── Resilient fetch ──────────────────────────────────────────────────────
//
// Browsers reject fetch() with a TypeError ("Failed to fetch" / "NetworkError")
// when a connection drops mid-request — common on VPNs and flaky mobile links,
// where a slow or large /api response is the first thing to get cut while the
// (small) page itself loads fine. Cloudflare firewall-event logs confirmed the
// origin is NOT blocking these requests, so the failure is purely transport
// level. Every /api read here is an idempotent GET, so a transient drop is safe
// to re-issue: one or two quiet retries turn an intermittent "network error"
// into a success the user never sees. A generous timeout bounds a truly stuck
// connection without cutting off a legitimately slow broad query (which can run
// ~25s) and stays well under Cloudflare's 100s edge limit.
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { retries = 2, timeoutMs = 60_000, retryDelayMs = 600 }: {
    retries?: number; timeoutMs?: number; retryDelayMs?: number;
  } = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastErr = err;
      // Our own timeout fired: the request already had its full window, so
      // don't hammer the origin with an identical slow query — surface it.
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        throw new Error('The request timed out. Please try again.');
      }
      // Transport-level drop (VPN / mobile blip). Retry the idempotent GET.
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Network request failed. Please check your connection and try again.');
}


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
  const r = await fetchWithRetry(`/api/ask?${params.toString()}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((body && body.error) || `Archive unreachable (HTTP ${r.status})`);
  }
  if (!body) {
    throw new Error('Archive returned an empty response.');
  }
  // The keepalive proxy streams HTTP 200 even for upstream failures (the
  // status line is sent before the upstream result is known), surfacing the
  // failure as a body-level `error`. Treat it the same as an HTTP error.
  if (body.error) {
    throw new Error(body.error);
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
  const r = await fetchWithRetry(`/api/discourse?${params.toString()}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error((body && body.error) || `Discourse unavailable (HTTP ${r.status})`);
  }
  if (!body) {
    throw new Error('Discourse returned an empty response.');
  }
  // Keepalive proxy returns 200 + body-level `error` on upstream failure.
  if (body.error) {
    throw new Error(body.error);
  }
  return body as DiscourseResponse;
}


// ─── Catalog ────────────────────────────────────────────────────────────


export async function catalogApi(engine: OfflineEngine | null): Promise<CatalogResponse> {
  if (engine) return engine.catalog();
  const r = await fetchWithRetry('/api/catalog', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Catalog unreachable (HTTP ${r.status})`);
  return body as CatalogResponse;
}


// ─── Languages ──────────────────────────────────────────────────────────


export async function languagesApi(engine: OfflineEngine | null): Promise<LanguagesResponse> {
  if (engine) return engine.languages();
  const r = await fetchWithRetry('/api/languages', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Languages unreachable (HTTP ${r.status})`);
  return body as LanguagesResponse;
}


// ─── Date range ────────────────────────────────────────────────────────


export async function dateRangeApi(engine: OfflineEngine | null): Promise<DateRangeResponse> {
  if (engine) return engine.dateRange();
  const r = await fetchWithRetry('/api/date-range', { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body && body.error) || `Date range unreachable (HTTP ${r.status})`);
  return body as DateRangeResponse;
}
