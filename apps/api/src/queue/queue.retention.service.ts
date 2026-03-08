import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from './queue.service';
import { ALL_QUEUE_NAMES } from './queue.constants';
import { dlqName } from './queue.policy';

@Injectable()
export class QueueRetentionService {
  private readonly logger = new Logger(QueueRetentionService.name);

  constructor(private readonly queues: QueueService) {}

  async cleanup() {
    const completedMs = Number(
      process.env.QUEUE_RETENTION_COMPLETED_MS || 24 * 60 * 60 * 1000,
    );
    const failedMs = Number(
      process.env.QUEUE_RETENTION_FAILED_MS || 7 * 24 * 60 * 60 * 1000,
    );

    const names = [
      ...ALL_QUEUE_NAMES,
      ...ALL_QUEUE_NAMES.map((q) => dlqName(q)),
    ];

    for (const name of names) {
      const q = this.queues.getQueueByName(name);
      if (!q) continue;

      await q.clean(completedMs, 1000, 'completed');
      await q.clean(failedMs, 1000, 'failed');

      this.logger.log(
        `cleaned queue=${name} completedMs=${completedMs} failedMs=${failedMs}`,
      );
    }
  }
}
