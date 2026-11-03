// The only place that talks to the server. Personal links go in the
// Authorization header, never in a query string.

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Changes in flight from this page. A live update (live.ts) about our own
// change can arrive before its reply; the app holds such updates until the
// reply is in ('api-idle' on window, after the caller has used the reply).
let writes = 0;
export const writing = (): boolean => writes > 0;

// T is what the endpoint answers with (see the list in src/worker/index.ts).
export async function api<T>(method: string, path: string, { token, body }: { token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const write = method !== 'GET';
  if (write) writes++;
  try {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'network');
    }
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || 'server');
    return data as T;
  } finally {
    if (write && --writes === 0) setTimeout(() => window.dispatchEvent(new Event('api-idle')));
  }
}
