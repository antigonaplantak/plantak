import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const STALE_AGE_MS = Number(process.env.STALE_AGE_MS || 10 * 60 * 1000);
const SINK_FILE = process.env.SINK_FILE || '_queue_runs/notifications.jsonl';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readSinkContains(outboxEventId) {
  if (!existsSync(SINK_FILE)) return false;
  const text = await fs.readFile(SINK_FILE, 'utf8');
  return text.includes(outboxEventId);
}

async function main() {
  const row = await prisma.outboxEvent.findFirst({
    where: {
      status: 'PENDING',
      eventType: {
        startsWith: 'booking.',
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!row) {
    console.error('OUTBOX_CRASH_RECOVERY_PROOF_FAIL');
    console.error('No pending booking.* outbox event found. Run booking gate first.');
    process.exit(1);
  }

  const staleLockedAt = new Date(Date.now() - STALE_AGE_MS);

  await prisma.outboxEvent.update({
    where: { id: row.id },
    data: {
      status: 'PROCESSING',
      lockedAt: staleLockedAt,
      lockedBy: 'crash-recovery-proof',
      lastError: 'simulated-crash-before-dispatch',
    },
  });

  console.log(
    JSON.stringify(
      {
        prepared: true,
        outboxEventId: row.id,
        eventType: row.eventType,
        aggregateId: row.aggregateId,
        staleLockedAt: staleLockedAt.toISOString(),
        sinkFile: SINK_FILE,
      },
      null,
      2,
    ),
  );

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const current = await prisma.outboxEvent.findUnique({
      where: { id: row.id },
    });

    const sinkHit = await readSinkContains(row.id);

    console.log(
      JSON.stringify(
        {
          outboxEventId: row.id,
          status: current?.status ?? 'missing',
          lockedBy: current?.lockedBy ?? null,
          sentAt: current?.sentAt ? current.sentAt.toISOString() : null,
          sinkHit,
        },
        null,
        2,
      ),
    );

    if (current?.status === 'SENT' && sinkHit) {
      console.log('OUTBOX_CRASH_RECOVERY_PROOF_OK');
      return;
    }

    if (current?.status === 'FAILED') {
      console.error('OUTBOX_CRASH_RECOVERY_PROOF_FAIL');
      console.error(
        JSON.stringify(
          {
            reason: 'row reached FAILED instead of being recovered and sent',
            outboxEventId: row.id,
            lastError: current.lastError ?? null,
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }

    await sleep(1000);
  }

  const finalRow = await prisma.outboxEvent.findUnique({
    where: { id: row.id },
  });

  console.error('OUTBOX_CRASH_RECOVERY_PROOF_FAIL');
  console.error(
    JSON.stringify(
      {
        reason: 'timeout waiting for recovered outbox row to be sent',
        outboxEventId: row.id,
        finalStatus: finalRow?.status ?? 'missing',
        finalLockedBy: finalRow?.lockedBy ?? null,
        finalSentAt: finalRow?.sentAt ? finalRow.sentAt.toISOString() : null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

main()
  .catch((err) => {
    console.error('OUTBOX_CRASH_RECOVERY_PROOF_FAIL');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
