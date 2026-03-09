import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueName = 'notifications';
const dlqQueueName = 'notifications-dlq';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCounts(queue) {
  return queue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed');
}

async function main() {
  const queue = new Queue(queueName, { connection });
  const dlq = new Queue(dlqQueueName, { connection });

  const proofId = `proof:notifications:retry-dlq:${Date.now()}`;
  const expectedDlqId = `dlq:${queueName}:${proofId}`;

  const job = await queue.add(
    'smoke.notifications.retry-dlq',
    {
      source: 'queue-retry-dlq-proof',
      failMode: 'retry-then-dlq',
      stamp: Date.now(),
    },
    {
      jobId: proofId,
      attempts: 3,
      backoff: { type: 'fixed', delay: 1000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  console.log(JSON.stringify({ queuedJobId: String(job.id) }, null, 2));

  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const mainJob = await queue.getJob(proofId);
    const dlqJob = await dlq.getJob(expectedDlqId);

    const mainState = mainJob ? await mainJob.getState() : 'missing';
    const dlqState = dlqJob ? await dlqJob.getState() : 'missing';
    const attemptsMade = mainJob ? Number(mainJob.attemptsMade ?? 0) : -1;

    if (
      mainState === 'failed' &&
      attemptsMade >= 3 &&
      dlqJob &&
      ['waiting', 'delayed', 'completed'].includes(dlqState)
    ) {
      console.log('== RETRY DLQ PROOF OK ==');
      console.log(
        JSON.stringify(
          {
            mainState,
            attemptsMade,
            dlqState,
            dlqJobId: String(dlqJob.id),
          },
          null,
          2,
        ),
      );
      await queue.close();
      await dlq.close();
      await connection.quit();
      process.exit(0);
    }

    await sleep(500);
  }

  const mainJob = await queue.getJob(proofId);
  const dlqJob = await dlq.getJob(expectedDlqId);

  console.log('== RETRY DLQ PROOF TIMEOUT ==');
  console.log(
    JSON.stringify(
      {
        attemptsMade: mainJob ? Number(mainJob.attemptsMade ?? 0) : null,
        mainState: mainJob ? await mainJob.getState() : 'missing',
        mainQueue: await getCounts(queue),
        dlqState: dlqJob ? await dlqJob.getState() : 'missing',
        dlqQueue: await getCounts(dlq),
        expectedDlqId,
      },
      null,
      2,
    ),
  );

  await queue.close();
  await dlq.close();
  await connection.quit();
  process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await connection.quit();
  } catch {}
  process.exit(1);
});
