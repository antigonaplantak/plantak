import { Injectable, Logger } from '@nestjs/common';
import { type QueueName } from './queue.constants';
import { QueueService } from './queue.service';
import { dlqName } from './queue.policy';

@Injectable()
export class QueueDlqService {
  private readonly logger = new Logger(QueueDlqService.name);

  constructor(private readonly queues: QueueService) {}

  private sanitizeJobIdPart(value: string) {
    const cleaned = value
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);

    return cleaned || 'x';
  }

  private buildDlqJobId(queueName: QueueName, originalJobId?: string) {
    if (!originalJobId) return undefined;

    return `dlq-${this.sanitizeJobIdPart(queueName)}-${this.sanitizeJobIdPart(originalJobId)}`;
  }

  async moveToDlq(
    queueName: QueueName,
    jobName: string,
    payload: Record<string, unknown>,
  ) {
    const target = dlqName(queueName);
    const originalJobId =
      typeof payload.originalJobId === 'string'
        ? payload.originalJobId
        : undefined;

    await this.queues.addRaw(target, `dlq.${jobName}`, payload, {
      jobId: this.buildDlqJobId(queueName, originalJobId),
      removeOnComplete: 5000,
      removeOnFail: 5000,
    });

    this.logger.warn(
      `moved job to DLQ queue=${queueName} target=${target} name=${jobName}`,
    );
  }
}
