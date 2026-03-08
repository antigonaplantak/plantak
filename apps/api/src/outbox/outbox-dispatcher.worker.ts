import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OutboxDispatcherModule } from './outbox-dispatcher.module';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OutboxDispatcherModule, {
    logger: ['log', 'error', 'warn'],
  });

  const logger = new Logger('OutboxDispatcherWorker');
  const service = app.get(OutboxDispatcherService);

  const limit = Number(process.env.OUTBOX_DISPATCH_BATCH || 100);
  const pollMs = Number(process.env.OUTBOX_DISPATCH_POLL_MS || 1000);
  const workerId = `dispatcher-${process.pid}`;

  logger.log(`started workerId=${workerId} batch=${limit} pollMs=${pollMs}`);

  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn(`shutting down on ${signal}`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  while (!stopping) {
    try {
      const result = await service.drainOnce(limit, workerId);
      if (result.claimed > 0) {
        logger.log(JSON.stringify(result));
      }
    } catch (err) {
      logger.error(err);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

void bootstrap();
