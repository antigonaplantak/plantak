import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queues = ['notifications', 'webhooks', 'sync-jobs'];

async function readSink(name) {
  const file = join(process.cwd(), '_queue_runs', `${name}.jsonl`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const rows = raw.trim().split('\n').filter(Boolean).slice(-5).map((x) => JSON.parse(x));
    return rows;
  } catch {
    return null;
  }
}

async function main() {
  for (const name of queues) {
    const q = new Queue(name, { connection });

    const counts = await q.getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children',
    );

    const completed = await q.getCompleted(0, 5);
    const failed = await q.getFailed(0, 5);
    const sink = await readSink(name);

    console.log(`== ${name} ==`);
    console.log(JSON.stringify({
      counts,
      completed: completed.map((j) => ({
        id: j.id,
        name: j.name,
        attemptsMade: j.attemptsMade,
        finishedOn: j.finishedOn,
      })),
      failed: failed.map((j) => ({
        id: j.id,
        name: j.name,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason,
        finishedOn: j.finishedOn,
      })),
      sink,
    }, null, 2));

    await q.close();
  }

  await connection.quit();
}

main().catch(async (err) => {
  console.error(err);
  try { await connection.quit(); } catch {}
  process.exit(1);
});
