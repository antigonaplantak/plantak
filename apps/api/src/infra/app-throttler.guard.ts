import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private getHeader(req: Request, name: string): string {
    const v = req.headers[name.toLowerCase()];
    if (Array.isArray(v)) return String(v[0] || '');
    return typeof v === 'string' ? v : '';
  }

  private isTrustedBypass(req: Request): boolean {
    const headerToken =
      this.getHeader(req, 'x-load-bypass-token') ||
      this.getHeader(req, 'x-throttle-bypass-token');

    const envToken =
      process.env.LOAD_BYPASS_TOKEN || process.env.THROTTLE_BYPASS_TOKEN || '';

    return !!headerToken && !!envToken && headerToken === envToken;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<Request>();
      if (this.isTrustedBypass(req)) {
        return true;
      }
    }

    return super.canActivate(context);
  }
}
