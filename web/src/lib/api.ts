export type FieldErrors = Record<string, { code: string; params?: Record<string, unknown> }>;

/** An error from the server. `code` is a machine code; the UI translates it (see errors.ts). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fields: FieldErrors = {},
  ) {
    super(code);
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

let unauthenticatedHandler: (() => void) | null = null;
/** Called when a request (other than the login check itself) comes back 401, e.g. the session expired. */
export const onUnauthenticated = (fn: (() => void) | null) => {
  unauthenticatedHandler = fn;
};

async function ensureCsrf(): Promise<string> {
  if (!csrfToken) {
    const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  }
  return csrfToken;
}

async function request<T>(method: string, url: string, body?: unknown, canRetry = true): Promise<T> {
  const headers: Record<string, string> = {};
  // A form with photos is sent as it is: the browser adds the right Content-Type (with its boundary) itself.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    if (method !== 'GET') headers['X-CSRF-Token'] = await ensureCsrf();
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (res.status === 204) return undefined as T;

  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; fields?: FieldErrors };
  } | null;

  if (!res.ok) {
    const code = data?.error?.code ?? 'INTERNAL';
    // The token belongs to one session; if it went stale, fetch a fresh one and retry once.
    if (res.status === 403 && code === 'CSRF_INVALID' && canRetry) {
      csrfToken = null;
      return request<T>(method, url, body, false);
    }
    if (res.status === 401 && url !== '/api/auth/me' && url !== '/api/auth/login') unauthenticatedHandler?.();
    throw new ApiError(res.status, code, data?.error?.fields ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
  /** POST a form (text fields plus photos). */
  postForm: <T>(url: string, form: FormData) => request<T>('POST', url, form),
};
