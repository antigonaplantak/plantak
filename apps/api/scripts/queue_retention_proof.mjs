import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { spawn } from 'node:child_process';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueName = 'notifications';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(check, timeoutMs = 10000, stepMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

function runNode(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`${script} exit=${code}`))));
  });
}

async function main() {
  const queue = new Queue(queueName, { connection });
  await queue.obliterate({ force: true }).catch(() => {});

  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name === 'retention.fail') {
        throw new Error('forced retention failure');
      }
      return { ok: true };
    },
    {
      connection,
      concurrency: 1,
    },
  );

  await worker.waitUntilReady();

  await queue.add('retention.ok', { source: 'queue-retention-proof' }, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  await queue.add('retention.fail', { source: 'queue-retention-proof' }, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  const beforeReady = await waitFor(async () => {
    const counts = await queue.getJobCounts('completed', 'failed');
    return (counts.completed || 0) >= 1 && (counts.failed || 0) >= 1;
  });

  if (!beforeReady) {
    throw new Error('retention proof setup timed out');
  }

  const before = await queue.getJobCounts('wait', 'active', 'completed', 'failed');
  console.log('== BEFORE RETENTION ==');
  console.log(JSON.stringify(before, null, 2));

  await runNode('dist/queue/queue-retention.runner.js', {
    QUEUE_RETENTION_COMPLETED_MS: '0',
    QUEUE_RETENTION_FAILED_MS: '0',
  });

  await sleep(500);

  const after = await queue.getJobCounts('wait', 'active', 'completed', 'failed');
  console.log('== AFTER RETENTION ==');
  console.log(JSON.stringify(after, null, 2));

  if ((after.completed || 0) !== 0 || (after.failed || 0) !== 0) {
    throw new Error('retention proof failed: completed/failed jobs were not cleaned');
  }

  await worker.close();
  await queue.close();
  await connection.quit();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await connection.quit();
  } catch {}
  process.exit(1);
});
