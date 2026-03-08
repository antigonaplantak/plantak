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

    if (job.data?.forceFail) {
      await this.dlq.moveToDlq(queueName, job.name, {
        jobId: job.id,
        name: job.name,
        data: job.data,
        reason: 'forceFail',
      });
      throw new Error('forced processor failure');
    }

    await this.sink.write(queueName, {
      jobId: job.id,
      name: job.name,
      data: job.data,
    });

    this.logger.log(`processed notifications job id=${job.id} name=${job.name}`);
    return { ok: true };
  }
}
