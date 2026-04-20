export interface SSEEvent {
  event: string;
  data: string;
}

export type SSEHandler = (event: SSEEvent) => void;

/**
 * Consume a ReadableStream of UTF-8 SSE bytes and invoke handler per event block.
 * Handles partial chunks across read boundaries.
 */
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  handler: SSEHandler,
  onDone?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseBlock(block);
        if (parsed) handler(parsed);
        boundary = buffer.indexOf('\n\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseBlock(tail);
      if (parsed) handler(parsed);
    }
  } finally {
    onDone?.();
  }
}

function parseBlock(block: string): SSEEvent | null {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0 && event === 'message') return null;
  return { event, data: dataLines.join('\n') };
}
