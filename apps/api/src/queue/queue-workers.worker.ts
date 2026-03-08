import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueueWorkersModule } from './queue-workers.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(QueueWorkersModule, {
    logger: ['log', 'error', 'warn'],
  });

  const logger = new Logger('QueueWorkers');
  logger.log('started queue consumer workers');

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
}

void bootstrap();
