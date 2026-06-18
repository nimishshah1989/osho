import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamingJsonProxy } from '../../streamProxy';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('streamingJsonProxy', () => {
  it('passes a successful JSON body through unchanged (parseable despite heartbeats)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ total: 3, total_hits: 9, events: [] }),
    }));
    const res = streamingJsonProxy('http://127.0.0.1:8000/api/search?q=a');
    expect(res.status).toBe(200);
    // Response.text() drains the whole stream (heartbeat whitespace + body);
    // JSON.parse tolerates the leading whitespace, so the client is unaffected.
    const parsed = JSON.parse(await res.text());
    expect(parsed).toEqual({ total: 3, total_hits: 9, events: [] });
  });

  it('surfaces an upstream HTTP error as a body-level {error} on a 200 stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ detail: 'Empty query.' }),
    }));
    const res = streamingJsonProxy('http://127.0.0.1:8000/api/search?q=');
    expect(res.status).toBe(200); // status is fixed when the stream opens
    expect(JSON.parse(await res.text())).toEqual({ error: 'Empty query.' });
  });

  it('surfaces a transport failure as a body-level {error}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const res = streamingJsonProxy('http://127.0.0.1:8000/api/search?q=a');
    const parsed = JSON.parse(await res.text());
    expect(parsed.error).toBeTruthy();
  });
});
