import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue.constants';
import { QueueSinkService } from '../queue-sink.service';

@Injectable()
@Processor(QUEUE_NAMES.notifications)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly sink: QueueSinkService) {
    super();
  }

  async process(job: Job<any, any, string>) {
    await this.sink.write('notifications', {
      jobId: job.id,
      name: job.name,
      data: job.data,
    });

    this.logger.log(`processed notifications job id=${job.id} name=${job.name}`);

    return {
      ok: true,
      queue: 'notifications',
      jobId: job.id,
    };
  }
}
