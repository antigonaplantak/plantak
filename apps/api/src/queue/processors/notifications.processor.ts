import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue.constants';
import { QueueDlqService } from '../queue.dlq.service';
import { QueueSinkService } from '../queue-sink.service';

@Processor(QUEUE_NAMES.notifications)
@Injectable()
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly sink: QueueSinkService,
    private readonly dlq: QueueDlqService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<{ ok: true }> {
    const jobId = String(job.id ?? '');
    const attempts = Number(job.opts.attempts ?? 1);
    const currentAttempt = Number(job.attemptsMade ?? 0) + 1;

    if (job.name === 'smoke.notifications.retry-dlq') {
      const message = `forced failure queue=${QUEUE_NAMES.notifications} attempt=${currentAttempt}/${attempts}`;

      this.logger.warn(
        `failed notifications job id=${jobId} name=${job.name} attempt=${currentAttempt}/${attempts}: ${message}`,
      );

      if (currentAttempt >= attempts) {
        await this.dlq.moveToDlq(QUEUE_NAMES.notifications, job.name, {
          originalJobId: jobId,
          source: 'queue-retry-dlq-proof',
          queue: QUEUE_NAMES.notifications,
          name: job.name,
          finalAttempt: currentAttempt,
          attempts,
          failedAt: new Date().toISOString(),
          data: job.data ?? null,
        });
      }

      throw new Error(message);
    }

    if (job.name === 'smoke.notifications.dlq') {
      await this.dlq.moveToDlq(QUEUE_NAMES.notifications, job.name, {
        originalJobId: jobId,
        source: 'queue-dlq-smoke',
        queue: QUEUE_NAMES.notifications,
        name: job.name,
        failedAt: new Date().toISOString(),
        data: job.data ?? null,
      });

      const message = `forced DLQ queue=${QUEUE_NAMES.notifications}`;
      this.logger.warn(
        `failed notifications job id=${jobId} name=${job.name}: ${message}`,
      );
      throw new Error(message);
    }

    await this.sink.write(QUEUE_NAMES.notifications, {
      jobId,
      name: job.name,
      data: job.data ?? null,
    });

    this.logger.log(
      `processed notifications job id=${jobId} name=${job.name}`,
    );

    return { ok: true };
  }
}
