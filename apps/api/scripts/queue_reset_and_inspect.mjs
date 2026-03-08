import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queues = ['notifications', 'webhooks', 'sync-jobs'];

async function main() {
  for (const name of queues) {
    const q = new Queue(name, { connection });

    const before = await q.getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children',
    );

    console.log(`== BEFORE ${name} ==`);
    console.log(JSON.stringify(before, null, 2));

    await q.drain(true);
    await q.clean(0, 1000, 'completed');
    await q.clean(0, 1000, 'failed');
    await q.clean(0, 1000, 'delayed');
    await q.clean(0, 1000, 'wait');
    await q.clean(0, 1000, 'paused');
    try {
      await q.clean(0, 1000, 'active');
    } catch {}

    const after = await q.getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children',
    );

    console.log(`== AFTER ${name} ==`);
    console.log(JSON.stringify(after, null, 2));

    await q.close();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => connection.disconnect());
