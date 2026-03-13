import { JobsOptions } from 'bullmq';
import { QUEUE_NAMES, type QueueName } from './queue.constants';

export const QUEUE_DEFAULTS: Record<QueueName, JobsOptions> = {
  [QUEUE_NAMES.notifications]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
  [QUEUE_NAMES.webhooks]: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
  [QUEUE_NAMES.syncJobs]: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 500,
    removeOnFail: 1500,
  },
};

export const DLQ_SUFFIX = '-dlq';

export function dlqName(queueName: QueueName): string {
  return `${queueName}${DLQ_SUFFIX}`;
}
