import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue.constants';
import { QueueSinkService } from '../queue-sink.service';

@Injectable()
@Processor(QUEUE_NAMES.webhooks)
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(private readonly sink: QueueSinkService) {
    super();
  }

  async process(job: Job<any, any, string>) {
    await this.sink.write('webhooks', {
      jobId: job.id,
      name: job.name,
      data: job.data,
    });

    this.logger.log(`processed webhooks job id=${job.id} name=${job.name}`);

    return {
      ok: true,
      queue: 'webhooks',
      jobId: job.id,
    };
  }
}
