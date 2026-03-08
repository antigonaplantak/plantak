import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { QUEUE_NAMES } from './queue.constants';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUE_NAMES.notifications)
    private readonly notificationsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.webhooks)
    private readonly webhooksQueue: Queue,
    @InjectQueue(QUEUE_NAMES.syncJobs)
    private readonly syncJobsQueue: Queue,
  ) {}

  addNotification(name: string, data: unknown, opts?: JobsOptions) {
    return this.notificationsQueue.add(name, data, opts);
  }

  addWebhook(name: string, data: unknown, opts?: JobsOptions) {
    return this.webhooksQueue.add(name, data, opts);
  }

  addSyncJob(name: string, data: unknown, opts?: JobsOptions) {
    return this.syncJobsQueue.add(name, data, opts);
  }

  private async inspect(queue: Queue) {
    return {
      name: queue.name,
      ping: await queue.client.then((c) => c.ping()),
      counts: await queue.getJobCounts(
        'wait',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      ),
    };
  }

  async snapshot() {
    return {
      notifications: await this.inspect(this.notificationsQueue),
      webhooks: await this.inspect(this.webhooksQueue),
      syncJobs: await this.inspect(this.syncJobsQueue),
    };
  }
}
