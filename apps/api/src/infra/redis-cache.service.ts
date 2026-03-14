import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }

  key(...parts: Array<string | number>) {
    const prefix = process.env.CACHE_PREFIX ?? 'plantak';
    return [prefix, ...parts.map(String)].join(':');
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSec: number) {
    const body = JSON.stringify(value);
    if (ttlSec > 0) {
      await this.redis.set(key, body, 'EX', ttlSec);
    } else {
      await this.redis.set(key, body);
    }
  }

  async delKeys(...keys: string[]) {
    const list = keys.filter(Boolean);
    if (!list.length) return;
    await this.redis.unlink(...list);
  }

  async delByPrefix(prefix: string) {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const res = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        200,
      );
      cursor = res[0];
      keys.push(...res[1]);
    } while (cursor !== '0');
    if (keys.length) {
      await this.redis.del(...keys);
    }
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
