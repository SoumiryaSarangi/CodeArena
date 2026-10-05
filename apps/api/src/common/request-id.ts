import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // Express's documented extension point for adding request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

const SAFE = /^[A-Za-z0-9._-]{8,64}$/;

/** Reuses a well-formed inbound X-Request-Id, otherwise mints one. Echoed on the response. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const inbound = req.header('x-request-id');
  req.id = inbound && SAFE.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
