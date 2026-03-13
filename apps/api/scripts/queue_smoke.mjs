import { Queue } from 'bullmq';

const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const names = ['notifications', 'webhooks', 'sync-jobs'];

for (const name of names) {
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  await queue.waitUntilReady();

  const job = await queue.add('smoke', {
    queue: name,
    at: new Date().toISOString(),
  });

  const before = await queue.getJobCounts(
    'wait',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused',
  );

  await queue.drain(true);

  const after = await queue.getJobCounts(
    'wait',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused',
  );

  console.log(JSON.stringify({ name, addedJobId: job.id, before, after }, null, 2));

  await queue.close();
}
