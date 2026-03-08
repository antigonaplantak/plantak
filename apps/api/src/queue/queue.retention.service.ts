import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from './queue.service';
import { ALL_QUEUE_NAMES } from './queue.constants';
import { dlqName } from './queue.policy';

@Injectable()
export class QueueRetentionService {
  private readonly logger = new Logger(QueueRetentionService.name);

  constructor(private readonly queues: QueueService) {}

  async cleanup() {
    const names = [
      ...ALL_QUEUE_NAMES,
      ...ALL_QUEUE_NAMES.map((q) => dlqName(q)),
    ];

    for (const name of names) {
      const q = this.queues.getQueueByName(name);
      if (!q) continue;

      await q.clean(24 * 60 * 60 * 1000, 1000, 'completed');
      await q.clean(7 * 24 * 60 * 60 * 1000, 1000, 'failed');
      this.logger.log(`cleaned queue=${name}`);
    }
  }
}
