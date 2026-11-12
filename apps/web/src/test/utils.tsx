import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { AuthUserDto } from '@teachgrow/shared';
import { AuthProvider } from '../lib/auth';
import { ToastProvider } from '../components/ui/toast';

/**
 * Test helpers. Everything here is test-only: the people and codes are invented, and `fetch` is
 * replaced by a table of canned answers so no network is involved.
 */

export const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export interface RecordedRequest {
  method: string;
  path: string;
  /** The path with its query string, as the server saw it. */
  url: string;
  body: unknown;
  headers: Headers;
}

type Handler = Response | ((request: RecordedRequest) => Response | Promise<Response> | undefined);

/**
 * Replaces `fetch`. Routes are keyed "METHOD /path" (query string ignored). A handler may return
 * undefined to fall through to the next one registered for the same key, so a test can queue
 * "fail once, then succeed". Anything unmatched is a 404 that fails the test loudly.
 */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedRequest[] = [];
  const queues = new Map<string, Handler[]>(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      url: url.pathname + url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(request);
    const key = `${method} ${url.pathname}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) {
      return json(404, { error: { code: 'NOT_FOUND', message: `No test answer for ${key}` } });
    }
    // The last handler stays in place so it can answer any number of further requests.
    const handler = queue.length > 1 ? queue.shift()! : queue[0]!;
    const answer = typeof handler === 'function' ? await handler(request) : handler;
    return (
      answer ?? json(500, { error: { code: 'INTERNAL', message: 'handler gave no answer' } })
    ).clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    called: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
    /** Every request made so far, with its query string. */
    urls: () => calls.map((c) => c.url),
  };
}

export const person = (over: Partial<AuthUserDto> = {}): AuthUserDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  employeeCode: 'E-1001',
  fullName: 'Priya Sharma',
  email: 'priya@demo.test',
  phone: null,
  role: 'employee',
  department: { id: '22222222-2222-4222-8222-222222222222', name: 'Academics' },
  designation: 'Maths Teacher',
  joiningDate: '2026-01-01',
  avatarUrl: null,
  attendanceRequired: true,
  isActive: true,
  mustChangePassword: false,
  ...over,
});

export const session = (user: AuthUserDto) => ({
  accessToken: 'test-access-token',
  tokenType: 'bearer' as const,
  expiresIn: 900,
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  user,
});

export function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

/** The app's providers around a page, with the router pointed at `route`. */
export function renderApp(
  ui: ReactElement,
  { route = '/', auth = false }: { route?: string; auth?: boolean } = {},
) {
  const queryClient = newQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => {
    const inner = auth ? <AuthProvider>{children}</AuthProvider> : children;
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[route]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <ToastProvider>{inner}</ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
  return { queryClient, ...render(ui, { wrapper: Wrapper }) };
}
