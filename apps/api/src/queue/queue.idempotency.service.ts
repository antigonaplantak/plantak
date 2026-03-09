import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class QueueIdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueIdempotencyService.name);
  private readonly redis = new Redis(
    process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
  );

  private readonly ttlSec = Number(
    process.env.QUEUE_IDEMPOTENCY_TTL_SEC || 7 * 24 * 60 * 60,
  );
  private readonly lockMs = Number(
    process.env.QUEUE_IDEMPOTENCY_LOCK_MS || 5 * 60 * 1000,
  );

  private normalize(key: string) {
    return String(key).trim();
  }

  private completedKey(queueName: string, key: string) {
    return `queue:idempotency:done:${queueName}:${this.normalize(key)}`;
  }

  private lockKey(queueName: string, key: string) {
    return `queue:idempotency:lock:${queueName}:${this.normalize(key)}`;
  }

  async runOnce(
    queueName: string,
    key: string,
    handler: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    const normalized = this.normalize(key);

    if (!normalized) {
      await handler();
      return 'processed';
    }

    const doneKey = this.completedKey(queueName, normalized);
    const lockKey = this.lockKey(queueName, normalized);

    const alreadyDone = await this.redis.exists(doneKey);
    if (alreadyDone) {
      return 'duplicate';
    }

    const acquired = await this.redis.set(lockKey, '1', 'PX', this.lockMs, 'NX');
    if (!acquired) {
      const doneAfterBusy = await this.redis.exists(doneKey);
      if (doneAfterBusy) {
        return 'duplicate';
      }

      throw new Error(`idempotency lock busy queue=${queueName} key=${normalized}`);
    }

    try {
      const doneAfterLock = await this.redis.exists(doneKey);
      if (doneAfterLock) {
        return 'duplicate';
      }

      await handler();

      await this.redis.set(doneKey, new Date().toISOString(), 'EX', this.ttlSec);
      return 'processed';
    } finally {
      await this.redis.del(lockKey);
    }
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch (err) {
      this.logger.warn(`redis quit failed: ${String(err)}`);
    }
  }
}
