import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { QueueModule } from './queue.module';
import { QueueRetentionService } from './queue.retention.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(QueueModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const svc = app.get(QueueRetentionService);
    await svc.cleanup();
  } finally {
    await app.close();
  }
}

void bootstrap();
