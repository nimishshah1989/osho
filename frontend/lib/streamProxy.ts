// Heartbeat-keepalive proxy for slow JSON endpoints.
//
// A broad search ("within N words", common stemmed terms) can take the backend
// several seconds of SILENT computation — the whole response then arrives in
// one shot at the end (measured: time-to-first-byte == total). Over a VPN or
// flaky mobile link that drops connections idle for more than a few seconds,
// the browser's fetch is killed before the response arrives, surfacing as
// "NetworkError" / "Failed to fetch". A retry can't help: every attempt hits
// the same idle-drop.
//
// The fix is to never let the connection go idle: stream a single whitespace
// byte every second while awaiting the upstream, then the JSON body. Leading
// whitespace is valid JSON and ignored by JSON.parse, so clients are
// unaffected. Because the HTTP status line is sent when the stream opens, an
// upstream error comes back as HTTP 200 with an `{ "error": ... }` body — the
// data layer (searchApi / discourseApi) treats a body-level `error` as a
// failure, preserving the previous error behaviour.
//
// NOTE: this only helps if Cloudflare forwards the streamed chunks to the
// client without buffering (it streams by default). Verify on deploy with a
// real VPN client.

const HEARTBEAT_MS = 1000;
// Hard ceiling so a wedged backend can't make us heartbeat forever.
const UPSTREAM_TIMEOUT_MS = 90_000;
const UNREACHABLE = 'The archive is unreachable. Please retry shortly.';

export function streamingJsonProxy(upstreamUrl: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(' '));
        } catch {
          /* stream already closed */
        }
      }, HEARTBEAT_MS);
      const ac = new AbortController();
      const killSwitch = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const upstream = await fetch(upstreamUrl, { cache: 'no-store', signal: ac.signal });
        const text = await upstream.text();
        if (!upstream.ok) {
          let detail = UNREACHABLE;
          try {
            const parsed = JSON.parse(text);
            detail = parsed?.detail || parsed?.error || detail;
          } catch {
            /* upstream sent non-JSON; keep the generic message */
          }
          controller.enqueue(encoder.encode(JSON.stringify({ error: detail })));
        } else {
          controller.enqueue(encoder.encode(text));
        }
      } catch {
        controller.enqueue(encoder.encode(JSON.stringify({ error: UNREACHABLE })));
      } finally {
        clearInterval(beat);
        clearTimeout(killSwitch);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // Hint to any intermediary nginx not to buffer the streamed heartbeats.
      'X-Accel-Buffering': 'no',
    },
  });
}
