import { vi } from 'vitest';
import { setupVirtueHealthRoutes } from '../routes/virtue-health-routes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export function createTestRoutes(mockQuery: ReturnType<typeof vi.fn>) {
  const handlers = new Map<string, AnyFn>();

  const mockApp = {
    get(path: string, handler: AnyFn) {
      handlers.set(path, handler);
    },
  };

  // Routes now expect query() to return { data: [...] }, but test mocks return
  // plain arrays for readability. Wrap here so individual tests don't need to.
  const wrappedQuery: AnyFn = async (...args: unknown[]) => {
    const result = await (mockQuery as AnyFn)(...args);
    return { data: result };
  };

  setupVirtueHealthRoutes({
    analytics: { query: wrappedQuery },
    server: {
      extend(fn: (app: typeof mockApp) => void) {
        fn(mockApp);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return {
    async get(routePath: string, queryParams: Record<string, string> = {}) {
      const handler = handlers.get(routePath);
      if (!handler) {
        const available = [...handlers.keys()].join(', ');
        throw new Error(`No handler for "${routePath}". Available: ${available}`);
      }
      let statusCode = 200;
      let responseBody: unknown;
      const req = { query: queryParams };
      const res = {
        status(code: number) { statusCode = code; return res; },
        json(body: unknown) { responseBody = body; },
      };
      await handler(req, res);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: statusCode, body: responseBody as any };
    },
  };
}
