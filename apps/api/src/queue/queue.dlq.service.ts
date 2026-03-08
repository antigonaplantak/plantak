import { Injectable, Logger } from '@nestjs/common';
import { type QueueName } from './queue.constants';
import { QueueService } from './queue.service';
import { dlqName } from './queue.policy';

@Injectable()
export class QueueDlqService {
  private readonly logger = new Logger(QueueDlqService.name);

  constructor(private readonly queues: QueueService) {}

  async moveToDlq(
    queueName: QueueName,
    jobName: string,
    payload: Record<string, unknown>,
  ) {
    const target = dlqName(queueName);

    await this.queues.addRaw(target, `dlq.${jobName}`, payload, {
      removeOnComplete: 5000,
      removeOnFail: 5000,
    });

    this.logger.warn(
      `moved job to DLQ queue=${queueName} target=${target} name=${jobName}`,
    );
  }
}
