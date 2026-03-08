import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from './queue.constants';
import { DLQ_SUFFIX } from './queue.policy';
import { QueueService } from './queue.service';
import { QueueDlqService } from './queue.dlq.service';
import { QueueRetentionService } from './queue.retention.service';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = { url: REDIS_URL };

@Module({
  imports: [
    BullModule.forRoot({ connection }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.notifications },
      { name: QUEUE_NAMES.webhooks },
      { name: QUEUE_NAMES.syncJobs },
      { name: `${QUEUE_NAMES.notifications}${DLQ_SUFFIX}` },
      { name: `${QUEUE_NAMES.webhooks}${DLQ_SUFFIX}` },
      { name: `${QUEUE_NAMES.syncJobs}${DLQ_SUFFIX}` },
    ),
  ],
  providers: [QueueService, QueueDlqService, QueueRetentionService],
  exports: [QueueService, QueueDlqService, QueueRetentionService, BullModule],
})
export class QueueModule {}
