import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

type ReqWithRequestId = Request & { requestId?: string };

export function requestId(
  req: ReqWithRequestId,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers['x-request-id'];
  const incoming = Array.isArray(header) ? header[0] : header;
  const id = incoming || randomUUID();

  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
