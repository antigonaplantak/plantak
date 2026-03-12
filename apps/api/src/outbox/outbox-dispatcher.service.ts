import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { QUEUE_NAMES, type QueueName } from '../queue/queue.constants';

type DbOutboxRow = {
  id: string;
  businessId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
};

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly maxDispatchAttempts = Number(
    process.env.OUTBOX_DISPATCH_MAX_ATTEMPTS || 10,
  );
  private readonly staleLockMs = Number(
    process.env.OUTBOX_STALE_LOCK_MS || 5 * 60 * 1000,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  private route(eventType: string): QueueName {
    if (eventType.startsWith('booking.')) return QUEUE_NAMES.notifications;
    if (eventType.startsWith('webhook.')) return QUEUE_NAMES.webhooks;
    if (
      eventType.startsWith('sync.') ||
      eventType.startsWith('sync-job.') ||
      eventType.startsWith('integration.')
    ) {
      return QUEUE_NAMES.syncJobs;
    }

    throw new Error(`Unknown outbox eventType: ${eventType}`);
  }

  private async reviveStaleLocks(workerId: string) {
    const threshold = new Date(Date.now() - this.staleLockMs);

    const result = await this.prisma.outboxEvent.updateMany({
      where: {
        status: 'PROCESSING',
        lockedAt: { lt: threshold },
      },
      data: {
        status: 'PENDING',
        lockedAt: null,
        lockedBy: null,
      },
    });

    if (result.count > 0) {
      this.logger.warn(
        `recovered stale outbox locks count=${result.count} workerId=${workerId}`,
      );
    }
  }

  private async claimBatch(
    limit: number,
    workerId: string,
  ): Promise<DbOutboxRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<DbOutboxRow[]>`
        SELECT
          id,
          "businessId",
          "aggregateType",
          "aggregateId",
          "eventType",
          payload,
          attempts
        FROM "OutboxEvent"
        WHERE status = 'PENDING'::"OutboxStatus"
          AND "availableAt" <= NOW()
        ORDER BY "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;

      if (!rows.length) return [];

      const ids = rows.map((r) => r.id);

      await tx.$executeRaw`
        UPDATE "OutboxEvent"
        SET
          status = 'PROCESSING'::"OutboxStatus",
          "lockedAt" = NOW(),
          "lockedBy" = ${workerId},
          "updatedAt" = NOW()
        WHERE id = ANY(${ids}::text[])
      `;

      return rows;
    });
  }

  private nextAvailableAt(nextAttempt: number) {
    const delaySec = Math.min(300, Math.max(5, 2 ** Math.min(nextAttempt, 8)));
    return new Date(Date.now() + delaySec * 1000);
  }

  private async markSent(id: string) {
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

  private async markRetryOrFailed(row: DbOutboxRow, err: unknown) {
    const message =
      err instanceof Error
        ? err.message.slice(0, 2000)
        : String(err).slice(0, 2000);

    const nextAttempt = Number(row.attempts ?? 0) + 1;

    if (nextAttempt >= this.maxDispatchAttempts) {
      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      });

      return;
    }

    await this.prisma.outboxEvent.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        attempts: { increment: 1 },
        availableAt: this.nextAvailableAt(nextAttempt),
        lockedAt: null,
        lockedBy: null,
        lastError: message,
      },
    });
  }

  private async dispatchOne(row: DbOutboxRow) {
    const queueName = this.route(row.eventType);
    const jobName = row.eventType;

    const payload = {
      outboxEventId: row.id,
      businessId: row.businessId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
    };

    if (queueName === QUEUE_NAMES.notifications) {
      await this.queues.addNotification(jobName, payload, {
        jobId: row.id,
      });
      return;
    }

    if (queueName === QUEUE_NAMES.webhooks) {
      await this.queues.addWebhook(jobName, payload, {
        jobId: row.id,
      });
      return;
    }

    await this.queues.addSyncJob(jobName, payload, {
      jobId: row.id,
    });
  }

  async drainOnce(limit = 100, workerId = `dispatcher-${process.pid}`) {
    await this.reviveStaleLocks(workerId);

    const rows = await this.claimBatch(limit, workerId);

    if (!rows.length) {
      return { claimed: 0, sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await this.dispatchOne(row);
        await this.markSent(row.id);
        sent += 1;
      } catch (err) {
        failed += 1;
        await this.markRetryOrFailed(row, err);
        this.logger.error(`dispatch failed id=${row.id} type=${row.eventType}`);
      }
    }

    return {
      claimed: rows.length,
      sent,
      failed,
    };
  }
}
