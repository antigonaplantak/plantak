import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

async function main() {
  const queues = ['notifications', 'webhooks', 'sync-jobs'];

  for (const name of queues) {
    const q = new Queue(name, { connection });
    await q.add(`smoke.${name}.dlq`, { source: 'queue-dlq-smoke', queue: name, forceFail: true });
    console.log(JSON.stringify({ queued: name }));
    await q.close();
  }

  await connection.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
