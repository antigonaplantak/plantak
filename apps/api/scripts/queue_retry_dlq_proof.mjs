import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = 'notifications';
const DLQ_NAME = `${QUEUE_NAME}-dlq`;
const ATTEMPTS = 3;
const BACKOFF_MS = 500;
const TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queue = new Queue(QUEUE_NAME, { connection });
const dlq = new Queue(DLQ_NAME, { connection });

const marker = `retry-dlq-proof-${Date.now()}`;
const jobId = `proof_retry_dlq_${Date.now()}`;

async function main() {
  console.log(`queue=${QUEUE_NAME}`);
  console.log(`dlq=${DLQ_NAME}`);
  console.log(`jobId=${jobId}`);
  console.log(`marker=${marker}`);

  await queue.add(
    'proof.retry-dlq',
    {
      failMode: 'retry-then-dlq',
      marker,
    },
    {
      jobId,
      attempts: ATTEMPTS,
      backoff: { type: 'fixed', delay: BACKOFF_MS },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  const deadline = Date.now() + TIMEOUT_MS;
  let finalState = 'unknown';
  let finalAttempts = 0;
  let matchedDlqJob = null;

  while (Date.now() < deadline) {
    const original = await queue.getJob(jobId);
    finalState = original ? await original.getState() : 'missing';
    finalAttempts = Number(original?.attemptsMade ?? 0);

    const dlqJobs = await dlq.getJobs(
      ['wait', 'delayed', 'active', 'completed', 'failed', 'paused'],
      0,
      100,
      true,
    );

    matchedDlqJob =
      dlqJobs.find((job) => {
        const data = job.data ?? {};
        return (
          data.originalJobId === jobId ||
          data.marker === marker ||
          data?.data?.marker === marker
        );
      }) ?? null;

    console.log(
      JSON.stringify({
        originalState: finalState,
        originalAttempts: finalAttempts,
        dlqFound: Boolean(matchedDlqJob),
      }),
    );

    if (finalState === 'failed' && finalAttempts === ATTEMPTS && matchedDlqJob) {
      break;
    }

    await sleep(750);
  }

  if (!(finalState === 'failed' && finalAttempts === ATTEMPTS && matchedDlqJob)) {
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

    console.error('RETRY_FINAL_DLQ_PROOF_FAIL');
    console.error(
      JSON.stringify(
        {
          finalState,
          finalAttempts,
          counts,
          dlqFound: Boolean(matchedDlqJob),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const dlqData = matchedDlqJob.data ?? {};
  const attemptsMade = Number(dlqData.attemptsMade ?? 0);
  const maxAttempts = Number(dlqData.maxAttempts ?? 0);

  if (attemptsMade !== ATTEMPTS || maxAttempts !== ATTEMPTS) {
    console.error('RETRY_FINAL_DLQ_PROOF_FAIL');
    console.error(
      JSON.stringify(
        {
          reason: 'DLQ payload attempts mismatch',
          attemptsMade,
          maxAttempts,
          expected: ATTEMPTS,
          dlqId: String(matchedDlqJob.id ?? ''),
          dlqData,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (String(matchedDlqJob.id ?? '').includes(':')) {
    console.error('RETRY_FINAL_DLQ_PROOF_FAIL');
    console.error(
      JSON.stringify(
        {
          reason: 'DLQ job id still contains colon',
          dlqId: String(matchedDlqJob.id ?? ''),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const sinkFile = path.join(process.cwd(), '_queue_runs', 'notifications.jsonl');
  if (existsSync(sinkFile)) {
    const text = await fs.readFile(sinkFile, 'utf8');
    if (text.includes(marker)) {
      console.error('RETRY_FINAL_DLQ_PROOF_FAIL');
      console.error(
        JSON.stringify(
          {
            reason: 'failed retry->dlq job unexpectedly hit success sink',
            sinkFile,
            marker,
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
  }

  console.log(
    JSON.stringify(
      {
        finalState,
        finalAttempts,
        dlqId: String(matchedDlqJob.id ?? ''),
        dlqData,
      },
      null,
      2,
    ),
  );
  console.log('RETRY_FINAL_DLQ_PROOF_OK');
}

main()
  .catch((err) => {
    console.error('RETRY_FINAL_DLQ_PROOF_FAIL');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await queue.close();
    await dlq.close();
    await connection.quit();
  });
