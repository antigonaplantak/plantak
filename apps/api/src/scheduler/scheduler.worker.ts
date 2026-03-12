import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerWorkerModule } from './scheduler.worker.module';

async function bootstrap() {
  const logger = new Logger('SchedulerWorker');
  const app = await NestFactory.createApplicationContext(
    SchedulerWorkerModule,
    {
      bufferLogs: true,
    },
  );

  logger.log(`scheduler worker active pid=${process.pid}`);

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`scheduler worker shutdown signal=${signal}`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  const logger = new Logger('SchedulerWorker');
  logger.error(
    `scheduler worker bootstrap failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  process.exit(1);
});
