import { Module } from '@nestjs/common';
import { QueueModule } from './queue.module';
import { QueueSinkService } from './queue-sink.service';
import { NotificationsProcessor } from './processors/notifications.processor';
import { WebhooksProcessor } from './processors/webhooks.processor';
import { SyncJobsProcessor } from './processors/sync-jobs.processor';

@Module({
  imports: [QueueModule],
  providers: [
    QueueSinkService,
    NotificationsProcessor,
    WebhooksProcessor,
    SyncJobsProcessor,
  ],
})
export class QueueWorkersModule {}
