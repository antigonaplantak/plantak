import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxEvent } from '@prisma/client';
import { OutboxModule } from './outbox.module';
import { OutboxService } from './outbox.service';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatch(event: OutboxEvent, logger: Logger) {
  logger.log(`[dispatch] ${event.eventType} ${event.aggregateType}:${event.aggregateId}`);
  // enterprise next step:
  // - email sender
  // - webhook sender
  // - push notifications
  // - external integrations
}

async function bootstrap() {
  const logger = new Logger('OutboxWorker');
  const app = await NestFactory.createApplicationContext(OutboxModule, {
    logger: ['error', 'warn', 'log'],
  });

  const outbox = app.get(OutboxService);
  const pollMs = Number(process.env.OUTBOX_POLL_MS || 1000);
  const workerId = process.env.OUTBOX_WORKER_ID || `worker-${process.pid}`;

  logger.log(`started workerId=${workerId} pollMs=${pollMs}`);

  const shutdown = async (sig: string) => {
    logger.warn(`shutting down on ${sig}`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  while (true) {
    const processed = await outbox.drainOnce(
      async (event) => dispatch(event, logger),
      workerId,
    );

    if (processed === 0) {
      await sleep(pollMs);
    }
  }
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
