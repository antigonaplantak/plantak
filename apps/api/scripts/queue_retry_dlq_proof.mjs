import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const QUEUE_NAME = 'notifications';
const DLQ_NAME = 'notifications-dlq';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const queue = new Queue(QUEUE_NAME, { connection });
  const dlq = new Queue(DLQ_NAME, { connection });

  await queue.obliterate({ force: true }).catch(() => {});
  await dlq.obliterate({ force: true }).catch(() => {});

  const job = await queue.add(
    'smoke.notifications.retry-dlq',
    {
      source: 'queue-retry-dlq-proof',
      stamp: Date.now(),
    },
    {
      attempts: 3,
      backoff: { type: 'fixed', delay: 200 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  );

  console.log(JSON.stringify({ queuedJobId: String(job.id) }, null, 2));

  const startedAt = Date.now();
  const timeoutMs = 15000;

  while (Date.now() - startedAt < timeoutMs) {
    const current = await queue.getJob(job.id);
    const dlqJobs = await dlq.getJobs(
      ['wait', 'delayed', 'active', 'completed', 'failed'],
      0,
      10,
      false,
    );

    if (dlqJobs.length > 0) {
      const mainCounts = await queue.getJobCounts(
        'wait',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      const dlqCounts = await dlq.getJobCounts(
        'wait',
        'active',
        'delayed',
        'failed',
        'completed',
      );

      const firstDlq = dlqJobs[0];
      console.log('== RETRY DLQ PROOF ==');
      console.log(
        JSON.stringify(
          {
            attemptsMade: current?.attemptsMade ?? null,
            mainQueue: mainCounts,
            dlqQueue: dlqCounts,
            dlqJobId: String(firstDlq.id ?? ''),
            dlqJobName: firstDlq.name,
            dlqPayload: firstDlq.data ?? null,
          },
          null,
          2,
        ),
      );

      await queue.close();
      await dlq.close();
      await connection.quit();
      return;
    }

    await sleep(250);
  }

  const current = await queue.getJob(job.id);
  const mainCounts = await queue.getJobCounts(
    'wait',
    'active',
    'delayed',
    'failed',
    'completed',
  );
  const dlqCounts = await dlq.getJobCounts(
    'wait',
    'active',
    'delayed',
    'failed',
    'completed',
  );

  console.log('== RETRY DLQ PROOF TIMEOUT ==');
  console.log(
    JSON.stringify(
      {
        attemptsMade: current?.attemptsMade ?? null,
        mainQueue: mainCounts,
        dlqQueue: dlqCounts,
      },
      null,
      2,
    ),
  );

  await queue.close();
  await dlq.close();
  await connection.quit();
  throw new Error('retry/dlq proof timed out');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
