import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  BackpressureAcquireResult,
  BackpressureBudgetOptions,
} from './backpressure.types';

const ACQUIRE_SCRIPT = `
local rateKey = KEYS[1]
local semKey = KEYS[2]

local nowMs = tonumber(ARGV[1])
local leaseId = ARGV[2]
local effectiveSpacingMs = tonumber(ARGV[3])
local maxConcurrent = tonumber(ARGV[4])
local maxHoldMs = tonumber(ARGV[5])

local staleBeforeMs = nowMs - maxHoldMs
redis.call('ZREMRANGEBYSCORE', semKey, '-inf', staleBeforeMs)

local concurrentCount = redis.call('ZCARD', semKey)
local nextAllowedAt = tonumber(redis.call('GET', rateKey) or '0')

if concurrentCount < maxConcurrent and nowMs >= nextAllowedAt then
  local newNextAllowedAt = nowMs + effectiveSpacingMs
  redis.call('SET', rateKey, tostring(newNextAllowedAt), 'PX', math.max(effectiveSpacingMs * 20, maxHoldMs))
  redis.call('ZADD', semKey, nowMs, leaseId)
  redis.call('PEXPIRE', semKey, math.max(maxHoldMs * 2, effectiveSpacingMs * 20))
  return {1, newNextAllowedAt, concurrentCount + 1}
end

return {0, nextAllowedAt, concurrentCount}
`;

const RELEASE_SCRIPT = `
local semKey = KEYS[1]
local leaseId = ARGV[1]

local removed = redis.call('ZREM', semKey, leaseId)
local concurrentCount = redis.call('ZCARD', semKey)

if concurrentCount == 0 then
  redis.call('DEL', semKey)
end

return {removed, concurrentCount}
`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class RedisBackpressureService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisBackpressureService.name);
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly redis: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  getInstanceId() {
    return this.instanceId;
  }

  async runWithBudget<T>(
    options: BackpressureBudgetOptions,
    task: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(options);
    try {
      return await task();
    } finally {
      await this.release(options.policyKey, lease.leaseId);
    }
  }

  async acquire(
    options: BackpressureBudgetOptions,
  ): Promise<BackpressureAcquireResult> {
    const startedAt = Date.now();
    const deadline = startedAt + options.acquireTimeoutMs;

    const minSpacingMs = Math.max(
      1,
      Math.ceil(options.windowMs / options.maxPerWindow),
    );

    const safetyMarginMs = Math.max(
      50,
      Math.ceil(minSpacingMs * 0.15),
    );

    const effectiveSpacingMs = minSpacingMs + safetyMarginMs;

    const rateKey = `plantak:bp:rate:${options.policyKey}`;
    const semKey = `plantak:bp:sem:${options.policyKey}`;

    while (true) {
      const now = Date.now();

      if (now > deadline) {
        throw new Error(
          `backpressure acquire timeout policy=${options.policyKey} waitedMs=${options.acquireTimeoutMs}`,
        );
      }

      const leaseId = `${this.instanceId}:lease:${randomUUID()}`;

      const raw = (await this.redis.eval(
        ACQUIRE_SCRIPT,
        2,
        rateKey,
        semKey,
        String(now),
        leaseId,
        String(effectiveSpacingMs),
        String(options.maxConcurrent),
        String(options.maxHoldMs),
      )) as [number, number, number];

      const acquired = Number(raw[0]) === 1;
      const nextAllowedAt = Number(raw[1] ?? 0);
      const concurrentCount = Number(raw[2] ?? 0);

      if (acquired) {
        this.logger.log(
          `backpressure grant policy=${options.policyKey} leaseId=${leaseId} minSpacingMs=${minSpacingMs} safetyMarginMs=${safetyMarginMs} effectiveSpacingMs=${effectiveSpacingMs}`,
        );

        return {
          leaseId,
          attemptId: leaseId,
          acquiredAt: now,
        };
      }

      const waitForRate = nextAllowedAt > now ? nextAllowedAt - now : 25;
      const waitForConcurrency = concurrentCount >= options.maxConcurrent ? 50 : 0;
      const sleepMs = Math.min(250, Math.max(25, waitForRate, waitForConcurrency));

      await sleep(sleepMs);
    }
  }

  async release(policyKey: string, leaseId: string): Promise<void> {
    const semKey = `plantak:bp:sem:${policyKey}`;
    await this.redis.eval(RELEASE_SCRIPT, 1, semKey, leaseId);
  }
}
