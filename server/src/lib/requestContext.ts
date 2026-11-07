import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

interface RequestContext {
  actorId: string | null;
  ip: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Who is making this request, for the activity log. Empty outside a request, as in background jobs. */
export const currentRequest = (): RequestContext => storage.getStore() ?? { actorId: null, ip: null };

/** Runs work as this person outside a web request, as the demo data does, so the activity log says who. */
export const runAs = <T>(actorId: string, fn: () => Promise<T>) => storage.run({ actorId, ip: null }, fn);

/** Remembers the logged-in user and their address for the rest of the request. Use after loadUser. */
export const requestContext: RequestHandler = (req, _res, next) => {
  storage.run({ actorId: req.user?.id ?? null, ip: req.ip ?? null }, next);
};
