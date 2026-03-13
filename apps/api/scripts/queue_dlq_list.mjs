import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const LIMIT = Math.max(1, Number(process.env.LIMIT || 20));
const ONLY_QUEUE = process.env.QUEUE || '';

const BASE_QUEUES = ['notifications', 'webhooks', 'sync-jobs'];
const TARGETS = ONLY_QUEUE
  ? [ONLY_QUEUE.endsWith('-dlq') ? ONLY_QUEUE : `${ONLY_QUEUE}-dlq`]
  : BASE_QUEUES.map((q) => `${q}-dlq`);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function short(value, max = 220) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

async function readQueue(name) {
  const queue = new Queue(name, { connection });

  try {
    const counts = await queue.getJobCounts(
      'wait',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children',
    );

    const jobs = await queue.getJobs(
      ['wait', 'delayed', 'active', 'failed', 'completed', 'paused'],
      0,
      LIMIT - 1,
      true,
    );

    const rows = await Promise.all(
      jobs.map(async (job) => ({
        id: String(job.id ?? ''),
        name: job.name,
        state: await job.getState(),
        attemptsMade: Number(job.attemptsMade ?? 0),
        maxAttempts: Number(job.opts?.attempts ?? 1),
        originalJobId:
          typeof job.data?.originalJobId === 'string' ? job.data.originalJobId : '',
        originalQueue:
          typeof job.data?.originalQueue === 'string' ? job.data.originalQueue : '',
        marker: typeof job.data?.marker === 'string'
          ? job.data.marker
          : typeof job.data?.data?.marker === 'string'
            ? job.data.data.marker
            : '',
        payloadPreview: short(job.data),
        failedReason: short(job.failedReason ?? ''),
        timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : '',
        finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : '',
      })),
    );

    console.log(`== ${name} COUNTS ==`);
    console.log(JSON.stringify(counts, null, 2));

    console.log(`== ${name} JOBS ==`);
    if (!rows.length) {
      console.log('empty');
    } else {
      console.table(rows);
    }
  } finally {
    await queue.close();
  }
}

async function main() {
  for (const name of TARGETS) {
    await readQueue(name);
    console.log();
  }
}

main()
  .catch((err) => {
    console.error('QUEUE_DLQ_LIST_FAIL');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await connection.quit();
  });
