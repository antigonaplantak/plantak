import {
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

type ReqWithUser = Request & { user?: unknown };

export class MembershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ReqWithUser>();

    if (!req.user) throw new UnauthorizedException('Authentication required');

    // TODO: enforce business membership (enterprise)
    return true;
  }
}
