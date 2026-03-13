import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queues = ['notifications', 'webhooks', 'sync-jobs'];

async function main() {
  const stamp = Date.now();

  for (const name of queues) {
    const q = new Queue(name, { connection });
    const job = await q.add(
      `smoke.${name}.always-fail`,
      {
        source: 'queue-always-fail-smoke',
        queue: name,
        stamp,
        alwaysFail: true,
      },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 500 },
        jobId: `always-fail:${name}:${stamp}`,
      },
    );

    console.log(JSON.stringify({ queue: name, addedJobId: job.id }));
    await q.close();
  }

  await connection.quit();
}

main().catch(async (err) => {
  console.error(err);
  try { await connection.quit(); } catch {}
  process.exit(1);
});
