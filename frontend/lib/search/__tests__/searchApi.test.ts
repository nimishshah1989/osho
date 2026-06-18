import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry, searchApi } from '../searchApi';

/** Minimal Response stand-in for the success path. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchWithRetry', () => {
  it('retries a transient network drop, then succeeds', async () => {
    // The exact failure VPN/mobile users hit: fetch rejects with a TypeError
    // ("Failed to fetch") mid-request, then the retry goes through.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchWithRetry('/api/ask?q=x', {}, { retryDelayMs: 1 });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on a persistent drop', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('/api/ask?q=x', {}, { retries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it('does NOT retry its own timeout (a slow query already had its full window)', async () => {
    // fetch that only settles by rejecting when the abort signal fires.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry('/api/ask?q=x', {}, { timeoutMs: 5, retryDelayMs: 1 }),
    ).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // timeout is not retried
  });

  it('passes init through (e.g. cache: no-store)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithRetry('/api/catalog', { cache: 'no-store' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeDefined(); // timeout signal is attached
  });
});

describe('searchApi (online fallback)', () => {
  it('returns the parsed body on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ total: 1, events: [] }));
    vi.stubGlobal('fetch', fetchMock);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchApi({ q: 'meditation' } as any, null);
    expect(res.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a single transient drop transparently', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ total: 2, events: [] }));
    vi.stubGlobal('fetch', fetchMock);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchApi({ q: 'love' } as any, null);
    expect(res.total).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when a 200 body carries an error (keepalive proxy upstream failure)', async () => {
    // The streaming keepalive proxy returns HTTP 200 with {error} when the
    // backend failed; searchApi must still treat that as a failure.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Empty query.' }));
    vi.stubGlobal('fetch', fetchMock);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(searchApi({ q: 'x' } as any, null)).rejects.toThrow('Empty query.');
  });

  it('uses the offline engine when present (no network at all)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const engine = { search: vi.fn().mockResolvedValue({ total: 7, events: [] }) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await searchApi({ q: 'x' } as any, engine as any);
    expect(res.total).toBe(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
