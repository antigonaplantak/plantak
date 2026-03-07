import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class NotificationsService {
  constructor(@InjectQueue('notifications') private readonly queue: Queue) {}

  async enqueueBookingCreated(bookingId: string) {
    await this.queue.add(
      'booking-created',
      { bookingId },
      {
        jobId: `booking-created:${bookingId}`, // idempotency
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }

  async enqueueBookingCancelled(bookingId: string) {
    await this.queue.add(
      'booking-cancelled',
      { bookingId },
      {
        jobId: `booking-cancelled:${bookingId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }
}
