import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue.constants';
import { QueueSinkService } from '../queue-sink.service';
import { QueueDlqService } from '../queue.dlq.service';

@Processor(QUEUE_NAMES.notifications)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly sink: QueueSinkService,
    private readonly dlq: QueueDlqService,
  ) {
    super();
  }

  async process(job: Job<Record<string, unknown>, unknown, string>) {
    const queueName = QUEUE_NAMES.notifications;
    const maxAttempts = Number(job.opts.attempts ?? 1);
    const currentAttempt = Number(job.attemptsMade ?? 0) + 1;

    try {
      if ((job.data as any)?.forceFail === true) {
        throw new Error(
          `forced failure queue=${queueName} attempt=${currentAttempt}/${maxAttempts}`,
        );
      }

      await this.sink.write(queueName, {
        jobId: job.id,
        name: job.name,
        attemptsMade: currentAttempt,
        maxAttempts,
        data: job.data,
      });

      this.logger.log(
        `processed notifications job id=${job.id} name=${job.name} attempt=${currentAttempt}/${maxAttempts}`,
      );

      return { ok: true };
    } catch (error: any) {
      this.logger.warn(
        `failed notifications job id=${job.id} name=${job.name} attempt=${currentAttempt}/${maxAttempts}: ${error?.message || error}`,
      );

      if (currentAttempt >= maxAttempts) {
        await this.dlq.moveToDlq(queueName, job.name, {
          originalQueue: queueName,
          originalJobId: job.id,
          attemptsMade: currentAttempt,
          maxAttempts,
          failedAt: new Date().toISOString(),
          error: error?.message || String(error),
          data: job.data,
        });
      }

      throw error;
    }
  }
}
