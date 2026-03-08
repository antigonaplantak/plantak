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
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, timeoutMs = 12000, stepMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function main() {
  const queue = new Queue(queueName, { connection });
  const dlq = new Queue(dlqQueueName, { connection });

  await queue.obliterate({ force: true }).catch(() => {});
  await dlq.obliterate({ force: true }).catch(() => {});

  const job = await queue.add(
    'smoke.notifications.retry-dlq',
    { source: 'queue-retry-dlq-proof', forceFail: true },
    {
      attempts: 3,
      backoff: { type: 'fixed', delay: 200 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  console.log(JSON.stringify({ queuedJobId: job.id }, null, 2));

  const ok = await waitFor(async () => {
    const main = await queue.getJobCounts('failed');
    const dlqCounts = await dlq.getJobCounts('wait', 'completed');
    return (main.failed || 0) >= 1 && ((dlqCounts.wait || 0) + (dlqCounts.completed || 0)) >= 1;
  });

  if (!ok) {
    throw new Error('retry/dlq proof timed out');
  }

  const failedJobs = await queue.getJobs(['failed']);
  const failedJob =
    failedJobs.find((x) => x.name === 'smoke.notifications.retry-dlq') || failedJobs[0];

  const dlqJobs = await dlq.getJobs(['wait', 'completed', 'failed', 'active', 'delayed']);

  const summary = {
    mainJobId: failedJob?.id || null,
    mainJobAttemptsMade: failedJob?.attemptsMade || 0,
    mainJobFailedReason: failedJob?.failedReason || null,
    dlqJobs: dlqJobs.length,
    dlqFirstName: dlqJobs[0]?.name || null,
    dlqFirstPayload: dlqJobs[0]?.data || null,
  };

  console.log('== RETRY DLQ CHECK ==');
  console.log(JSON.stringify(summary, null, 2));

  if ((summary.mainJobAttemptsMade || 0) < 3) {
    throw new Error('retry proof failed: attemptsMade < 3');
  }

  if ((summary.dlqJobs || 0) < 1) {
    throw new Error('dlq proof failed: no dlq job created');
  }

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
