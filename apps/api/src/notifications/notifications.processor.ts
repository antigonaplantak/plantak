import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

type BookingJobData = { bookingId: string };

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  override async process(
    job: Job<BookingJobData, unknown, string>,
  ): Promise<unknown> {
    // eslint rule: require-await
    await Promise.resolve();

    if (job.name === 'booking-created') {
      this.logger.log(`booking-created -> bookingId=${job.data.bookingId}`);
      return { ok: true };
    }

    if (job.name === 'booking-cancelled') {
      this.logger.log(`booking-cancelled -> bookingId=${job.data.bookingId}`);
      return { ok: true };
    }

    this.logger.warn(`Unknown job: ${job.name}`);
    return { ok: true };
  }
}
