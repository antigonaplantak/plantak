import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private getHeader(req: any, name: string): string {
    const v = req?.headers?.[name];
    if (Array.isArray(v)) return String(v[0] || '');
    return String(v || '');
  }

  private isTrustedBypass(req: any): boolean {
    const headerToken =
      this.getHeader(req, 'x-load-bypass-token') ||
      this.getHeader(req, 'x-throttle-bypass-token');

    const envToken =
      process.env.LOAD_BYPASS_TOKEN || process.env.THROTTLE_BYPASS_TOKEN || '';

    return !!headerToken && !!envToken && headerToken === envToken;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      if (this.isTrustedBypass(req)) {
        return true;
      }
    }

    return super.canActivate(context);
  }
}
