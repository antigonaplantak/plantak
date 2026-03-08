import { Injectable, Logger } from '@nestjs/common';
import { Prisma, OutboxEvent } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export type EnqueueOutboxInput = {
  businessId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
  availableAt?: Date;
};

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueueTx(tx: Tx, input: EnqueueOutboxInput) {
    return tx.outboxEvent.create({
      data: {
        businessId: input.businessId ?? null,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload,
        availableAt: input.availableAt ?? new Date(),
      },
    });
  }

  async claimBatch(workerId: string, limit = 50): Promise<OutboxEvent[]> {
    const rows = await this.prisma.$queryRaw<OutboxEvent[]>`
      WITH picked AS (
        SELECT id
        FROM "OutboxEvent"
        WHERE status = CAST('PENDING' AS "OutboxStatus")
          AND "availableAt" <= now()
        ORDER BY "availableAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "OutboxEvent" o
      SET status = CAST('PROCESSING' AS "OutboxStatus"),
          "lockedAt" = now(),
          "lockedBy" = ${workerId},
          attempts = o.attempts + 1,
          "updatedAt" = now()
      FROM picked
      WHERE o.id = picked.id
      RETURNING o.*;
    `;

    return rows;
  }

  async markSent(id: string) {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
  }

  async markRetry(id: string, attempts: number, error: unknown) {
    const delaySec = Math.min(300, Math.max(5, 2 ** Math.min(attempts, 8)));
    const nextAt = new Date(Date.now() + delaySec * 1000);

    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'PENDING',
        availableAt: nextAt,
        lockedAt: null,
        lockedBy: null,
        lastError: String(error ?? 'unknown error').slice(0, 2000),
      },
    });
  }

  async markFailed(id: string, error: unknown) {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'FAILED',
        lockedAt: null,
        lockedBy: null,
        lastError: String(error ?? 'unknown error').slice(0, 2000),
      },
    });
  }

  async drainOnce(
    handler: (event: OutboxEvent) => Promise<void>,
    workerId = process.env.OUTBOX_WORKER_ID || `worker-${process.pid}`,
    batchSize = Number(process.env.OUTBOX_BATCH_SIZE || 50),
  ): Promise<number> {
    const batch = await this.claimBatch(workerId, batchSize);

    for (const event of batch) {
      try {
        await handler(event);
        await this.markSent(event.id);
      } catch (error) {
        this.logger.error(`outbox event failed ${event.id}`, error as any);
        await this.markRetry(event.id, event.attempts, error);
      }
    }

    return batch.length;
  }

  async stats() {
    const grouped = await this.prisma.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return grouped.map((x) => ({
      status: x.status,
      total: x._count._all,
    }));
  }
}
