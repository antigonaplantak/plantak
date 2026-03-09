import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QueueDlqService } from '../queue.dlq.service';
import { QueueSinkService } from '../queue-sink.service';

@Processor('notifications')
@Injectable()
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);
  private readonly queueName = 'notifications' as const;

  constructor(
    private readonly sink: QueueSinkService,
    private readonly dlq: QueueDlqService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<{ ok: true; movedToDlq?: true }> {
    const attempts = Number(job.opts.attempts ?? 1);
    const currentAttempt = Number(job.attemptsMade ?? 0) + 1;
    const failMode = String(job.data?.failMode ?? '');

    try {
      if (job.name.includes('.dlq')) {
        await this.dlq.moveToDlq(this.queueName, job.name, {
          originalJobId: String(job.id ?? ''),
          originalQueue: this.queueName,
          reason: 'explicit-dlq-smoke',
          data: job.data ?? null,
        });

        return { ok: true, movedToDlq: true };
      }

      if (job.name.includes('.retry-dlq') || failMode === 'retry-then-dlq') {
        if (currentAttempt < attempts) {
          throw new Error(
            `forced failure queue=${this.queueName} attempt=${currentAttempt}/${attempts}`,
          );
        }

        await this.dlq.moveToDlq(this.queueName, job.name, {
          originalJobId: String(job.id ?? ''),
          originalQueue: this.queueName,
          finalAttempt: currentAttempt,
          attempts,
          reason: 'retry-exhausted',
          data: job.data ?? null,
        });

        this.logger.warn(
          `moved notifications job to final DLQ id=${String(job.id ?? '')} name=${job.name} attempt=${currentAttempt}/${attempts}`,
        );

        return { ok: true, movedToDlq: true };
      }

      if (failMode === 'always') {
        throw new Error(`forced failure queue=${this.queueName}`);
      }

      await this.sink.write(this.queueName, {
        jobId: String(job.id ?? ''),
        name: job.name,
        data: job.data ?? null,
      });

      this.logger.log(
        `processed notifications job id=${String(job.id ?? '')} name=${job.name}`,
      );

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `failed notifications job id=${String(job.id ?? '')} name=${job.name} attempt=${currentAttempt}/${attempts}: ${message}`,
      );
      throw error;
    }
  }
}
