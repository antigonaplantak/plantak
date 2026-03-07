import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const bypass = process.env.THROTTLE_BYPASS_TOKEN ?? '';
    const header = req?.headers?.['x-internal-load-key'];

    if (header) {
      console.log(
        '[THROTTLE_DEBUG]',
        JSON.stringify({
          header: String(header),
          bypassSet: !!bypass,
          matched: String(header) === String(bypass),
          nodeEnv: process.env.NODE_ENV ?? '',
          url: req?.url ?? '',
        }),
      );
    }

    if (
      bypass &&
      header &&
      String(header) === String(bypass) &&
      process.env.NODE_ENV !== 'production'
    ) {
      console.log('[THROTTLE_BYPASS_HIT]', req?.url ?? '');
      return true;
    }

    return super.canActivate(context);
  }
}
