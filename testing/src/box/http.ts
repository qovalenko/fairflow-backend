export interface LocalGatewayFetchInit {
  token?: string;
  projectId?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Call the locally-bootstrapped gateway HTTP API. */
export async function localGatewayFetch(
  apiBase: string,
  path: string,
  init: LocalGatewayFetchInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
  };
  if (init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.projectId) headers['X-Project-Id'] = init.projectId;
  const url = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Poll until an HTTP endpoint returns 2xx (deterministic readiness probe). */
export async function waitForHttpOk(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`HTTP ${url} not ready within ${timeoutMs}ms`);
}

export interface MultipartPart {
  name: string;
  value: string | Blob;
  filename?: string;
}

/** Multipart POST to the locally-bootstrapped gateway (documents/chat uploads). */
export async function localGatewayMultipartFetch(
  apiBase: string,
  path: string,
  init: {
    token?: string;
    projectId?: string;
    parts: MultipartPart[];
    method?: string;
  },
): Promise<Response> {
  const form = new FormData();
  for (const part of init.parts) {
    if (part.value instanceof Blob) {
      form.append(part.name, part.value, part.filename);
    } else {
      form.append(part.name, part.value);
    }
  }
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.projectId) headers['X-Project-Id'] = init.projectId;
  const url = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { method: init.method ?? 'POST', headers, body: form });
}

export interface SseWaitOptions {
  token: string;
  projectId?: string;
  event: string;
  timeoutMs?: number;
  /** Called after the SSE connection is established. */
  trigger?: () => void | Promise<void>;
}

/**
 * Connect to an SSE endpoint and resolve when a named event arrives.
 * Aborts the stream after the first matching event or on timeout.
 */
export async function waitForSseEvent(
  apiBase: string,
  path: string,
  opts: SseWaitOptions,
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const url = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      controller.abort();
      fn();
    };

    void (async () => {
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: 'text/event-stream',
            ...(opts.projectId ? { 'X-Project-Id': opts.projectId } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const errText = await res.text();
          finish(() => reject(new Error(`SSE connect failed: ${res.status} ${errText}`)));
          return;
        }

        if (opts.trigger) {
          await new Promise((r) => setTimeout(r, 300));
          await opts.trigger();
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            if (!block.trim() || block.startsWith(':')) continue;
            const lines = block.split('\n');
            let eventName = 'message';
            let dataLine = '';
            for (const line of lines) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              if (line.startsWith('data:')) dataLine = line.slice(5).trim();
            }
            if (eventName === opts.event && dataLine) {
              finish(() => resolve(JSON.parse(dataLine) as unknown));
              return;
            }
          }
        }
        finish(() => reject(new Error(`SSE event "${opts.event}" not received within ${timeoutMs}ms`)));
      } catch (e) {
        if (settled) return;
        if (e instanceof Error && e.name === 'AbortError') return;
        finish(() => reject(e));
      }
    })();
  });
}
