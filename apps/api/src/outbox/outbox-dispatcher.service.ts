import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  private route(eventType: string): 'notifications' | 'webhooks' | 'syncJobs' {
    if (eventType.startsWith('booking.')) return 'notifications';
    if (eventType.startsWith('webhook.')) return 'webhooks';
    return 'syncJobs';
  }

  private async claimBatch(limit: number, workerId: string): Promise<DbOutboxRow[]> {
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

  private async markFailed(id: string, err: unknown) {
    const message =
      err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000);

    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
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

    if (queueName === 'notifications') {
      await this.queues.addNotification(jobName, payload, {
        jobId: row.id,
      });
      return;
    }

    if (queueName === 'webhooks') {
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
        await this.markFailed(row.id, err);
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
