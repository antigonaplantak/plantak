import { Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/node';

@Catch()
export class SentryFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
