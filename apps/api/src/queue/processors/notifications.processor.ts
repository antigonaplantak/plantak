import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue.constants';
import { QueueDlqService } from '../queue.dlq.service';
import { QueueSinkService } from '../queue-sink.service';

type JobData = Record<string, unknown>;

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

  async process(job: Job<JobData, { ok: true }, string>): Promise<{ ok: true }> {
    const queueName = QUEUE_NAMES.notifications;
    const data = (job.data ?? {}) as JobData;
    const attempt = Number(job.attemptsMade ?? 0) + 1;
    const maxAttempts = Number(job.opts.attempts ?? 1);

    const failMode =
      typeof data.failMode === 'string' ? String(data.failMode) : '';

    const wantsRetryThenDlq =
      failMode === 'retry-then-dlq' || job.name.includes('.retry-dlq');

    const wantsImmediateDlq =
      failMode === 'immediate-dlq' ||
      (job.name.includes('.dlq') && !job.name.includes('.retry-dlq'));

    if (wantsImmediateDlq) {
      await this.dlq.moveToDlq(queueName, job.name, {
        originalJobId: String(job.id ?? ''),
        originalQueue: queueName,
        attemptsMade: attempt,
        maxAttempts,
        data,
      });

      const msg = `forced immediate DLQ queue=${queueName} attempt=${attempt}/${maxAttempts}`;
      this.logger.warn(
        `moved notifications job to immediate DLQ id=${String(job.id ?? '')} name=${job.name} attempt=${attempt}/${maxAttempts}`,
      );
      throw new Error(msg);
    }

    if (wantsRetryThenDlq) {
      if (attempt >= maxAttempts) {
        await this.dlq.moveToDlq(queueName, job.name, {
          originalJobId: String(job.id ?? ''),
          originalQueue: queueName,
          attemptsMade: attempt,
          maxAttempts,
          data,
        });

        const msg = `forced terminal failure queue=${queueName} attempt=${attempt}/${maxAttempts}`;
        this.logger.warn(
          `moved notifications job to final DLQ id=${String(job.id ?? '')} name=${job.name} attempt=${attempt}/${maxAttempts}`,
        );
        throw new Error(msg);
      }

      const msg = `forced failure queue=${queueName} attempt=${attempt}/${maxAttempts}`;
      this.logger.warn(
        `failed notifications job id=${String(job.id ?? '')} name=${job.name} attempt=${attempt}/${maxAttempts}: ${msg}`,
      );
      throw new Error(msg);
    }

    await this.sink.write(queueName, {
      jobId: String(job.id ?? ''),
      name: job.name,
      data,
    });

    this.logger.log(
      `processed notifications job id=${String(job.id ?? '')} name=${job.name}`,
    );

    return { ok: true };
  }
}
