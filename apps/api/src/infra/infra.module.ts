import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, seconds } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AppThrottlerGuard } from './app-throttler.guard';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { BullModule } from '@nestjs/bullmq';
import type { RedisOptions } from 'ioredis';
import { URL } from 'node:url';
import type { IncomingMessage } from 'node:http';

type ReqWithId = IncomingMessage & { id?: string };

function parseRedisUrl(redisUrl: string): RedisOptions {
  const u = new URL(redisUrl);
  const opts: RedisOptions = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
  };

  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') opts.tls = {};

  return opts;
}

function getRedis() {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  return { redisUrl, conn: parseRedisUrl(redisUrl) };
}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req: ReqWithId) =>
          (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        customProps: (req: ReqWithId) => ({ requestId: req.id }),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),

    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
      storage: new ThrottlerStorageRedisService(getRedis().redisUrl),
    }),

    BullModule.forRoot({
      connection: getRedis().conn,
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class InfraModule {}
