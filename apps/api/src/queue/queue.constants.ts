export const QUEUE_NAMES = {
  notifications: 'notifications',
  webhooks: 'webhooks',
  syncJobs: 'sync-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: QueueName[] = [
  QUEUE_NAMES.notifications,
  QUEUE_NAMES.webhooks,
  QUEUE_NAMES.syncJobs,
];
