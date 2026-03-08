import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { ALL_QUEUE_NAMES, QUEUE_NAMES, type QueueName } from './queue.constants';
import { QUEUE_DEFAULTS } from './queue.policy';

type QueuePayload = Record<string, unknown>;

@Injectable()
export class QueueService {
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    @InjectQueue(QUEUE_NAMES.notifications)
    private readonly notificationsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.webhooks)
    private readonly webhooksQueue: Queue,
    @InjectQueue(QUEUE_NAMES.syncJobs)
    private readonly syncJobsQueue: Queue,
  ) {
    this.queues = {
      [QUEUE_NAMES.notifications]: this.notificationsQueue,
      [QUEUE_NAMES.webhooks]: this.webhooksQueue,
      [QUEUE_NAMES.syncJobs]: this.syncJobsQueue,
    };
  }

  async add(
    queueName: QueueName,
    jobName: string,
    data: QueuePayload,
    opts: JobsOptions = {},
  ) {
    const queue = this.queues[queueName];
    if (!queue) {
      throw new Error(`Unknown queue: ${queueName}`);
    }

    return queue.add(jobName, data, {
      ...QUEUE_DEFAULTS[queueName],
      ...opts,
    });
  }

  async addNotification(
    jobName: string,
    data: QueuePayload,
    opts: JobsOptions = {},
  ) {
    return this.add(QUEUE_NAMES.notifications, jobName, data, opts);
  }

  async addWebhook(
    jobName: string,
    data: QueuePayload,
    opts: JobsOptions = {},
  ) {
    return this.add(QUEUE_NAMES.webhooks, jobName, data, opts);
  }

  async addSyncJob(
    jobName: string,
    data: QueuePayload,
    opts: JobsOptions = {},
  ) {
    return this.add(QUEUE_NAMES.syncJobs, jobName, data, opts);
  }

  async counts() {
    const result = await Promise.all(
      ALL_QUEUE_NAMES.map(async (name) => {
        const counts = await this.queues[name].getJobCounts(
          'wait',
          'active',
          'completed',
          'failed',
          'delayed',
          'paused',
          'prioritized',
          'waiting-children',
        );
        return [name, counts] as const;
      }),
    );

    return Object.fromEntries(result);
  }
}
