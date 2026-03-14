import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { RuntimeLeaseService } from '../runtime/runtime-lease.service';

type LeaseGrant = Awaited<ReturnType<RuntimeLeaseService['tryAcquire']>>;

@Injectable()
export class LeasedCronService {
  private readonly logger = new Logger(LeasedCronService.name);
  private readonly ownerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly localRunning = new Set<string>();

  constructor(private readonly runtimeLeaseService: RuntimeLeaseService) {}

  getOwnerId() {
    return this.ownerId;
  }

  async runWithLease<T>(options: {
    jobName: string;
    leaseKey: string;
    ttlMs: number;
    task: () => Promise<T>;
  }): Promise<{ executed: boolean; result?: T }> {
    const { jobName, leaseKey, ttlMs, task } = options;

    if (this.localRunning.has(leaseKey)) {
      this.logger.warn(
        `scheduler local overlap skip job=${jobName} leaseKey=${leaseKey}`,
      );
      return { executed: false };
    }

    this.localRunning.add(leaseKey);
    let grant: LeaseGrant | null = null;

    try {
      grant = await this.runtimeLeaseService.tryAcquire(
        leaseKey,
        this.ownerId,
        ttlMs,
      );

      if (!grant) {
        this.logger.debug(
          `scheduler lease miss job=${jobName} leaseKey=${leaseKey}`,
        );
        return { executed: false };
      }

      this.logger.log(
        `scheduler lease acquired job=${jobName} leaseKey=${leaseKey} fencingToken=${grant.fencingToken}`,
      );

      const result = await task();
      return { executed: true, result };
    } finally {
      try {
        if (grant) {
          await this.runtimeLeaseService.release(leaseKey, this.ownerId);

          this.logger.warn(
            `scheduler lease released job=${jobName} leaseKey=${leaseKey}`,
          );
        }
      } finally {
        this.localRunning.delete(leaseKey);
      }
    }
  }
}
