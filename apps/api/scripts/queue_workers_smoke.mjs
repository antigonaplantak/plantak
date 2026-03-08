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
      `smoke.${name}`,
      {
        source: 'queue-workers-smoke',
        queue: name,
        stamp,
      },
      {
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    console.log(JSON.stringify({ queue: name, addedJobId: job.id }));
    await q.close();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    connection.disconnect();
  });
