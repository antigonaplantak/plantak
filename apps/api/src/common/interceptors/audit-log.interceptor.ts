import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap } from 'rxjs/operators';
import type { Request } from 'express';
import { AUDIT_KEY } from '../audit/audit.decorator';

// ⚠️ This import will be auto-patched to your real PrismaService path below.
import { PrismaService } from '../../prisma/prisma.service';

type AuthedRequest = Request & { user?: { id: string }; id?: string };

function firstString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const action = this.reflector.get<string>(AUDIT_KEY, context.getHandler());
    if (!action) return next.handle();

    const actorUserId = req.user?.id ?? null;

    const q = req.query as unknown as Record<string, unknown>;
    const businessId =
      firstString(q?.businessId) ?? firstString(req.headers['x-business-id']);

    const requestId = req.id ?? null;
    const ip = typeof req.ip === 'string' ? req.ip : null;
    const userAgent =
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : null;

    return next.handle().pipe(
      tap(() => {
        void this.prisma.auditLog.create({
          data: {
            action,
            entityType: action,
            entityId: requestId ?? 'unknown',
            actorUserId,
            businessId,
            requestId,
            ip,
            userAgent,
          },
        });
      }),
    );
  }
}
