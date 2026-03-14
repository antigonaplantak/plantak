import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SINK_FILE = process.env.SINK_FILE || '_queue_runs/notifications.jsonl';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 20000);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queue = new Queue('notifications', { connection });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sinkMatches(marker) {
  if (!existsSync(SINK_FILE)) return [];
  const text = await fs.readFile(SINK_FILE, 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => JSON.stringify(row).includes(marker));
}

async function main() {
  const logicalKey = `consumer-idem-${Date.now()}`;
  const marker = `consumer-idem-marker-${Date.now()}`;
  const jobId1 = `consumer_idem_a_${Date.now()}`;
  const jobId2 = `consumer_idem_b_${Date.now()}`;

  await queue.add(
    'consumer.idempotency.proof',
    {
      outboxEventId: logicalKey,
      marker,
      note: 'duplicate-a',
    },
    {
      jobId: jobId1,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  await queue.add(
    'consumer.idempotency.proof',
    {
      outboxEventId: logicalKey,
      marker,
      note: 'duplicate-b',
    },
    {
      jobId: jobId2,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  console.log(
    JSON.stringify(
      {
        logicalKey,
        marker,
        jobId1,
        jobId2,
        sinkFile: SINK_FILE,
      },
      null,
      2,
    ),
  );

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const j1 = await queue.getJob(jobId1);
    const j2 = await queue.getJob(jobId2);

    const state1 = j1 ? await j1.getState() : 'missing';
    const state2 = j2 ? await j2.getState() : 'missing';

    const matches = await sinkMatches(marker);

    console.log(
      JSON.stringify(
        {
          state1,
          state2,
          sinkMatches: matches.length,
        },
        null,
        2,
      ),
    );

    if (
      (state1 === 'completed' || state1 === 'missing') &&
      (state2 === 'completed' || state2 === 'missing') &&
      matches.length >= 1
    ) {
      if (matches.length !== 1) {
        console.error('QUEUE_CONSUMER_IDEMPOTENCY_PROOF_FAIL');
        console.error(
          JSON.stringify(
            {
              reason: 'duplicate side-effect observed in sink',
              logicalKey,
              marker,
              sinkMatches: matches.length,
              matches,
            },
            null,
            2,
          ),
        );
        process.exit(1);
      }

      console.log(
        JSON.stringify(
          {
            logicalKey,
            marker,
            sinkMatches: matches.length,
            row: matches[0],
          },
          null,
          2,
        ),
      );
      console.log('QUEUE_CONSUMER_IDEMPOTENCY_PROOF_OK');
      return;
    }

    await sleep(500);
  }

  const matches = await sinkMatches(marker);

  console.error('QUEUE_CONSUMER_IDEMPOTENCY_PROOF_FAIL');
  console.error(
    JSON.stringify(
      {
        reason: 'timeout waiting for duplicate jobs to settle',
        sinkMatches: matches.length,
        matches,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

main()
  .catch((err) => {
    console.error('QUEUE_CONSUMER_IDEMPOTENCY_PROOF_FAIL');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await queue.close();
    await connection.quit();
  });
