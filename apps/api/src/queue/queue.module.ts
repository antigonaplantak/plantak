import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ALL_QUEUE_NAMES } from './queue.constants';
import { QueueService } from './queue.service';

const bullQueueImports = ALL_QUEUE_NAMES.map((name) =>
  BullModule.registerQueue({ name }),
);

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
    ...bullQueueImports,
  ],
  providers: [QueueService],
  exports: [BullModule, QueueService],
})
export class QueueModule {}
