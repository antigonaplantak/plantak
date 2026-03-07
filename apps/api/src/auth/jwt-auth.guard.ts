import { Injectable } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (process.env.E2E_BYPASS_AUTH === '1') {
      const req = context
        .switchToHttp()
        .getRequest<Request & { user?: { id: string } }>();
      req.user = { id: process.env.E2E_USER_ID ?? 'e2e-user' };
      return true;
    }

    return super.canActivate(context) as unknown as boolean | Promise<boolean>;
  }
}
