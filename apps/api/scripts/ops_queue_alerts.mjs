import fs from 'node:fs';
import { join } from 'node:path';
import { Queue } from 'bullmq';

function loadDotEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function envInt(name, fallback) {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: envInt('REDIS_PORT', 6379),
    db: envInt('REDIS_DB', 0),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

async function oldestAgeMs(queue, statuses) {
  const jobs = await queue.getJobs(statuses, 0, 0, true);
  const job = jobs[0];
  if (!job) return 0;
  const ts = Number(job.timestamp || 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return Date.now() - ts;
}

loadDotEnv();

const connection = redisConnection();

const policies = [
  { name: 'notifications', kind: 'main' },
  { name: 'webhooks', kind: 'main' },
  { name: 'sync-jobs', kind: 'main' },
  { name: 'notifications-dlq', kind: 'dlq' },
  { name: 'webhooks-dlq', kind: 'dlq' },
  { name: 'sync-jobs-dlq', kind: 'dlq' },
];

const thresholds = {
  mainWaitMax: envInt('ALERT_MAIN_WAIT_MAX', 200),
  mainDelayedMax: envInt('ALERT_MAIN_DELAYED_MAX', 200),
  mainActiveMax: envInt('ALERT_MAIN_ACTIVE_MAX', 50),
  mainOldestWaitMs: envInt('ALERT_MAIN_OLDEST_WAIT_MS', 300000),
  dlqWaitMax: envInt('ALERT_DLQ_WAIT_MAX', 10),
};

const summary = {
  generatedAt: new Date().toISOString(),
  thresholds,
  queues: {},
  issues: [],
};

const queues = policies.map((policy) => ({
  policy,
  queue: new Queue(policy.name, { connection }),
}));

try {
  for (const { policy, queue } of queues) {
    const counts = await queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'failed',
      'paused',
      'prioritized',
      'waiting-children',
      'completed',
    );

    const oldestWait = await oldestAgeMs(queue, ['wait']);
    const oldestDelayed = await oldestAgeMs(queue, ['delayed']);

    summary.queues[policy.name] = {
      kind: policy.kind,
      counts,
      oldestWaitMs: oldestWait,
      oldestDelayedMs: oldestDelayed,
    };

    if (policy.kind === 'main') {
      if ((counts.wait || 0) > thresholds.mainWaitMax) {
        summary.issues.push(
          `${policy.name}: wait=${counts.wait} > ${thresholds.mainWaitMax}`,
        );
      }
      if ((counts.delayed || 0) > thresholds.mainDelayedMax) {
        summary.issues.push(
          `${policy.name}: delayed=${counts.delayed} > ${thresholds.mainDelayedMax}`,
        );
      }
      if ((counts.active || 0) > thresholds.mainActiveMax) {
        summary.issues.push(
          `${policy.name}: active=${counts.active} > ${thresholds.mainActiveMax}`,
        );
      }
      if (oldestWait > thresholds.mainOldestWaitMs) {
        summary.issues.push(
          `${policy.name}: oldestWaitMs=${oldestWait} > ${thresholds.mainOldestWaitMs}`,
        );
      }
    } else {
      if ((counts.wait || 0) > thresholds.dlqWaitMax) {
        summary.issues.push(
          `${policy.name}: wait=${counts.wait} > ${thresholds.dlqWaitMax}`,
        );
      }
    }
  }

  if (summary.issues.length > 0) {
    console.error('QUEUE_ALERTS_BREACHED');
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  console.log('QUEUE_ALERTS_OK');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await Promise.all(queues.map(({ queue }) => queue.close().catch(() => undefined)));
}
