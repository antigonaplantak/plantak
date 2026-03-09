import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SOURCE_INPUT = process.env.QUEUE || '';
const JOB_ID = process.env.JOB_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const REMOVE_SOURCE = process.env.REMOVE_SOURCE !== '0';
const PRESERVE_JOB_ID = process.env.PRESERVE_JOB_ID === '1';

if (!SOURCE_INPUT) {
  console.error('QUEUE_DLQ_REDRIVE_FAIL');
  console.error('QUEUE env is required, e.g. QUEUE=notifications');
  process.exit(1);
}

if (!JOB_ID) {
  console.error('QUEUE_DLQ_REDRIVE_FAIL');
  console.error('JOB_ID env is required');
  process.exit(1);
}

const SOURCE_DLQ = SOURCE_INPUT.endsWith('-dlq')
  ? SOURCE_INPUT
  : `${SOURCE_INPUT}-dlq`;

const DEFAULTS = {
  notifications: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
  webhooks: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
  'sync-jobs': {
    attempts: 6,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 500,
    removeOnFail: 1500,
  },
};

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function sanitizeJobIdPart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'x';
}

function stripDlqPrefix(name) {
  return String(name || '').startsWith('dlq.')
    ? String(name).slice(4)
    : String(name || '');
}

function resolveTargetQueue(job) {
  const payload = job.data ?? {};

  if (typeof payload.originalQueue === 'string' && payload.originalQueue) {
    return payload.originalQueue;
  }

  if (SOURCE_DLQ.endsWith('-dlq')) {
    return SOURCE_DLQ.slice(0, -4);
  }

  if (typeof payload.queue === 'string' && payload.queue) {
    return payload.queue;
  }

  throw new Error(`Cannot resolve original queue for DLQ job ${String(job.id ?? '')}`);
}

function resolveTargetName(job) {
  const payload = job.data ?? {};

  if (typeof payload.originalName === 'string' && payload.originalName) {
    return payload.originalName;
  }

  return stripDlqPrefix(job.name);
}

function baseTargetData(job) {
  const payload = job.data ?? {};

  if (payload && typeof payload.data === 'object' && payload.data !== null) {
    return { ...payload.data };
  }

  if (payload && typeof payload === 'object' && payload !== null) {
    return { ...payload };
  }

  return { value: payload };
}

function readPriorRedriveCount(job) {
  const payload = job.data ?? {};
  const nested = payload?.data?.redriveCount;
  const top = payload?.redriveCount;

  if (Number.isFinite(Number(nested))) return Number(nested);
  if (Number.isFinite(Number(top))) return Number(top);
  return 0;
}

function resolveTargetData(job) {
  const target = baseTargetData(job);
  const nextCount = readPriorRedriveCount(job) + 1;

  return {
    ...target,
    redrivenFromDlqJobId: String(job.id ?? ''),
    redrivenAt: new Date().toISOString(),
    redriveCount: nextCount,
  };
}

function buildTargetJobId(job, targetName) {
  const payload = job.data ?? {};
  const originalJobId =
    typeof payload.originalJobId === 'string' ? payload.originalJobId : '';

  if (PRESERVE_JOB_ID && originalJobId) {
    return originalJobId;
  }

  return [
    'redrive',
    Date.now(),
    sanitizeJobIdPart(targetName),
    sanitizeJobIdPart(originalJobId || String(job.id ?? '')),
  ].join('_');
}

function buildTargetOptions(targetQueue, job, targetName) {
  const payload = job.data ?? {};
  const defaults = DEFAULTS[targetQueue] || {};
  const maxAttemptsRaw =
    payload.maxAttempts ?? payload.attempts ?? defaults.attempts ?? 1;
  const maxAttempts = Math.max(1, Number(maxAttemptsRaw || 1));

  return {
    ...defaults,
    attempts: maxAttempts,
    jobId: buildTargetJobId(job, targetName),
  };
}

async function main() {
  const sourceQueue = new Queue(SOURCE_DLQ, { connection });

  try {
    const sourceJob = await sourceQueue.getJob(JOB_ID);

    if (!sourceJob) {
      throw new Error(`DLQ job not found: queue=${SOURCE_DLQ} id=${JOB_ID}`);
    }

    const targetQueueName = resolveTargetQueue(sourceJob);
    const targetName = resolveTargetName(sourceJob);
    const targetData = resolveTargetData(sourceJob);
    const targetOpts = buildTargetOptions(targetQueueName, sourceJob, targetName);

    const preview = {
      sourceQueue: SOURCE_DLQ,
      sourceJobId: String(sourceJob.id ?? ''),
      sourceName: sourceJob.name,
      targetQueue: targetQueueName,
      targetName,
      targetJobId: targetOpts.jobId,
      removeSource: REMOVE_SOURCE,
      preserveJobId: PRESERVE_JOB_ID,
      dryRun: DRY_RUN,
      payloadPreview: JSON.stringify(targetData).slice(0, 400),
    };

    console.log(JSON.stringify(preview, null, 2));

    if (DRY_RUN) {
      console.log('QUEUE_DLQ_REDRIVE_DRY_RUN_OK');
      return;
    }

    const targetQueue = new Queue(targetQueueName, { connection });

    try {
      await targetQueue.add(targetName, targetData, targetOpts);
    } finally {
      await targetQueue.close();
    }

    if (REMOVE_SOURCE) {
      await sourceJob.remove();
    }

    console.log(
      JSON.stringify(
        {
          ...preview,
          removedSource: REMOVE_SOURCE,
        },
        null,
        2,
      ),
    );
    console.log('QUEUE_DLQ_REDRIVE_OK');
  } finally {
    await sourceQueue.close();
  }
}

main()
  .catch((err) => {
    console.error('QUEUE_DLQ_REDRIVE_FAIL');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await connection.quit();
  });
