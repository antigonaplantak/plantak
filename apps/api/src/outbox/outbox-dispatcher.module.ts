import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Module({
  imports: [PrismaModule, QueueModule],
  providers: [OutboxDispatcherService],
  exports: [OutboxDispatcherService],
})
export class OutboxDispatcherModule {}
