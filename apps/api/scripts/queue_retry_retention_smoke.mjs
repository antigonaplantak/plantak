import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueName = 'notifications';
const dlqQueueName = 'notifications-dlq';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const queue = new Queue(queueName, { connection });
  const dlq = new Queue(dlqQueueName, { connection });

  await queue.obliterate({ force: true }).catch(() => {});
  await dlq.obliterate({ force: true }).catch(() => {});

  let attemptsSeen = 0;

  const worker = new Worker(
    queueName,
    async (job) => {
      attemptsSeen = job.attemptsMade + 1;
      throw new Error(`forced retry failure attempt=${attemptsSeen}`);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  const job = await queue.add(
    'smoke.retry.retention',
    { source: 'queue-retry-retention-smoke', forceFail: true },
    {
      attempts: 3,
      backoff: { type: 'fixed', delay: 300 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  console.log(JSON.stringify({ queuedJobId: job.id }, null, 2));

  await sleep(2500);

  const failed = await queue.getFailed();
  const completed = await queue.getCompleted();
  const waiting = await queue.getWaiting();
  const active = await queue.getActive();
  const delayed = await queue.getDelayed();
  const dlqWaiting = await dlq.getWaiting();
  const dlqFailed = await dlq.getFailed();
  const dlqCompleted = await dlq.getCompleted();

  console.log('== RETRY CHECK ==');
  console.log(
    JSON.stringify(
      {
        attemptsSeen,
        mainQueue: {
          waiting: waiting.length,
          active: active.length,
          delayed: delayed.length,
          failed: failed.length,
          completed: completed.length,
        },
        dlqQueue: {
          waiting: dlqWaiting.length,
          failed: dlqFailed.length,
          completed: dlqCompleted.length,
        },
      },
      null,
      2,
    ),
  );

  await worker.close();
  await queue.close();
  await dlq.close();
  await connection.quit();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await connection.quit();
  } catch {}
  process.exit(1);
});
