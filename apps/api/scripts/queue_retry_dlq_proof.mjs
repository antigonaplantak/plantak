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

async function findDlqJob(dlq, expectedDlqId, proofId) {
  const direct = await dlq.getJob(expectedDlqId);
  if (direct) return direct;

  const jobs = await dlq.getJobs(
    ['wait', 'active', 'delayed', 'completed', 'failed'],
    0,
    20,
    true,
  );

  return (
    jobs.find((job) => {
      const originalJobId =
        typeof job?.data?.originalJobId === 'string' ? job.data.originalJobId : '';
      return originalJobId === proofId;
    }) || null
  );
}

async function main() {
  const queue = new Queue(queueName, { connection });
  const dlq = new Queue(dlqQueueName, { connection });

  await queue.obliterate({ force: true }).catch(() => {});
  await dlq.obliterate({ force: true }).catch(() => {});

  const proofId = `proof_notifications_retry_dlq_${Date.now()}`;
  const expectedDlqId = `dlq__${queueName}__${proofId}`;

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
      backoff: { type: 'fixed', delay: 500 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  console.log(JSON.stringify({ queuedJobId: String(job.id), proofId, expectedDlqId }, null, 2));

  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const mainJob = await queue.getJob(proofId);
    const dlqJob = await findDlqJob(dlq, expectedDlqId, proofId);

    const mainState = mainJob ? await mainJob.getState() : 'missing';
    const dlqState = dlqJob ? await dlqJob.getState() : 'missing';
    const attemptsMade = mainJob ? Number(mainJob.attemptsMade ?? 0) : -1;

    if (
      mainJob &&
      mainState === 'completed' &&
      attemptsMade >= 2 &&
      dlqJob &&
      ['waiting', 'delayed', 'active', 'completed'].includes(dlqState)
    ) {
      console.log('== RETRY DLQ PROOF OK ==');
      console.log(
        JSON.stringify(
          {
            proofId,
            expectedDlqId,
            mainState,
            attemptsMade,
            dlqState,
            dlqJobId: String(dlqJob.id),
            dlqName: dlqJob.name,
            dlqPayload: dlqJob.data ?? null,
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

    await sleep(300);
  }

  const mainJob = await queue.getJob(proofId);
  const dlqJob = await findDlqJob(dlq, expectedDlqId, proofId);

  console.log('== RETRY DLQ PROOF TIMEOUT ==');
  console.log(
    JSON.stringify(
      {
        proofId,
        expectedDlqId,
        mainState: mainJob ? await mainJob.getState() : 'missing',
        attemptsMade: mainJob ? Number(mainJob.attemptsMade ?? 0) : null,
        mainQueue: await getCounts(queue),
        dlqFound: Boolean(dlqJob),
        dlqState: dlqJob ? await dlqJob.getState() : 'missing',
        dlqQueue: await getCounts(dlq),
        dlqPayload: dlqJob ? dlqJob.data ?? null : null,
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
