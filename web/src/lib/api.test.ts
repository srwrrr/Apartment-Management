import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onUnauthenticated, setCsrfToken } from './api';

type Reply = { status: number; body?: unknown };

/** A fake server: replies are consumed in order; every request is recorded. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined });
      const r = replies.shift();
      if (!r) throw new Error('unexpected request: ' + url);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  setCsrfToken(null);
  onUnauthenticated(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('GET sends no CSRF token and returns the JSON', async () => {
    const calls = fakeFetch([{ status: 200, body: { hello: 'world' } }]);
    expect(await api.get('/api/x')).toEqual({ hello: 'world' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('a write fetches a CSRF token first and sends it', async () => {
    const calls = fakeFetch([{ status: 200, body: { csrfToken: 'tok1' } }, { status: 200, body: { ok: true } }]);
    await api.post('/api/things', { a: 1 });
    expect(calls[0]!.url).toBe('/api/auth/csrf');
    expect(calls[1]!.headers['X-CSRF-Token']).toBe('tok1');
    expect(calls[1]!.headers['Content-Type']).toBe('application/json');
    expect(calls[1]!.body).toBe('{"a":1}');
  });

  it('reuses a known token without asking again', async () => {
    setCsrfToken('known');
    const calls = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
    await api.post('/api/a');
    await api.patch('/api/b', {});
    expect(calls.map((c) => c.url)).toEqual(['/api/a', '/api/b']);
    expect(calls[1]!.headers['X-CSRF-Token']).toBe('known');
  });

  it('a stale token is replaced and the request retried once', async () => {
    setCsrfToken('stale');
    const calls = fakeFetch([
      { status: 403, body: { error: { code: 'CSRF_INVALID' } } },
      { status: 200, body: { csrfToken: 'fresh' } },
      { status: 200, body: { saved: true } },
    ]);
    expect(await api.post('/api/save', {})).toEqual({ saved: true });
    expect(calls[2]!.headers['X-CSRF-Token']).toBe('fresh');
  });

  it('does not retry forever when the token keeps being rejected', async () => {
    setCsrfToken('stale');
    fakeFetch([
      { status: 403, body: { error: { code: 'CSRF_INVALID' } } },
      { status: 200, body: { csrfToken: 'fresh' } },
      { status: 403, body: { error: { code: 'CSRF_INVALID' } } },
    ]);
    await expect(api.post('/api/save', {})).rejects.toMatchObject({ status: 403, code: 'CSRF_INVALID' });
  });

  it('turns an error response into an ApiError with code and field errors', async () => {
    setCsrfToken('t');
    fakeFetch([{ status: 400, body: { error: { code: 'VALIDATION_FAILED', fields: { phone: { code: 'PHONE_INVALID' } } } } }]);
    const err = await api.post('/api/residents', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', fields: { phone: { code: 'PHONE_INVALID' } } });
  });

  it('treats 204 as success with no body', async () => {
    setCsrfToken('t');
    fakeFetch([{ status: 204 }]);
    expect(await api.post('/api/auth/logout')).toBeUndefined();
  });

  it('reports a network failure as code NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(api.get('/api/x')).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('falls back to INTERNAL when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => Promise.reject(new Error('not json')) }) as unknown as Response),
    );
    await expect(api.get('/api/x')).rejects.toMatchObject({ code: 'INTERNAL', status: 502 });
  });

  it('calls the unauthenticated handler on a 401, except for the login check itself', async () => {
    const handler = vi.fn();
    onUnauthenticated(handler);
    fakeFetch([{ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }]);
    await expect(api.get('/api/units')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    handler.mockClear();
    fakeFetch([{ status: 401, body: { error: { code: 'UNAUTHENTICATED' } } }]);
    await expect(api.get('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });
});
