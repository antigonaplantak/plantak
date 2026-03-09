import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type RuntimeLeaseGrant = {
  leaseKey: string;
  ownerId: string;
  fencingToken: bigint;
  expiresAt: Date;
};

@Injectable()
export class RuntimeLeaseService {
  private readonly logger = new Logger(RuntimeLeaseService.name);

  constructor(private readonly prisma: PrismaService) {}

  private mark(message: string) {
    console.log(message);
  }

  async tryAcquire(
    leaseKey: string,
    ownerId: string,
    ttlMs: number,
  ): Promise<RuntimeLeaseGrant | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    this.mark(`RUNTIME_LEASE_TRY_ACQUIRE_BEGIN leaseKey=${leaseKey} ownerId=${ownerId} ttlMs=${ttlMs}`);

    await this.prisma.runtimeLease.createMany({
      data: [
        {
          leaseKey,
          ownerId: '__unowned__',
          fencingToken: BigInt(0),
          expiresAt: new Date(0),
          heartbeatAt: new Date(0),
        },
      ],
      skipDuplicates: true,
    });

    this.mark(`RUNTIME_LEASE_TRY_ACQUIRE_AFTER_CREATE_MANY leaseKey=${leaseKey} ownerId=${ownerId}`);

    const res = await this.prisma.runtimeLease.updateMany({
      where: {
        leaseKey,
        OR: [{ expiresAt: { lte: now } }, { ownerId }],
      },
      data: {
        ownerId,
        expiresAt,
        heartbeatAt: now,
        fencingToken: { increment: BigInt(1) },
      },
    });

    this.mark(`RUNTIME_LEASE_TRY_ACQUIRE_AFTER_UPDATE_MANY leaseKey=${leaseKey} ownerId=${ownerId} count=${res.count}`);

    if (res.count !== 1) {
      this.mark(`RUNTIME_LEASE_TRY_ACQUIRE_MISS leaseKey=${leaseKey} ownerId=${ownerId}`);
      return null;
    }

    const row = await this.prisma.runtimeLease.findUniqueOrThrow({
      where: { leaseKey },
    });

    this.mark(
      `RUNTIME_LEASE_TRY_ACQUIRE_OK leaseKey=${row.leaseKey} ownerId=${row.ownerId} fencingToken=${row.fencingToken.toString()}`,
    );

    this.logger.log(
      `lease acquired key=${row.leaseKey} owner=${row.ownerId} fencingToken=${row.fencingToken.toString()}`,
    );

    return {
      leaseKey: row.leaseKey,
      ownerId: row.ownerId,
      fencingToken: row.fencingToken,
      expiresAt: row.expiresAt,
    };
  }

  async renew(
    leaseKey: string,
    ownerId: string,
    ttlMs: number,
  ): Promise<RuntimeLeaseGrant | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    this.mark(`RUNTIME_LEASE_RENEW_BEGIN leaseKey=${leaseKey} ownerId=${ownerId} ttlMs=${ttlMs}`);

    const res = await this.prisma.runtimeLease.updateMany({
      where: {
        leaseKey,
        ownerId,
        expiresAt: { gte: now },
      },
      data: {
        expiresAt,
        heartbeatAt: now,
      },
    });

    this.mark(`RUNTIME_LEASE_RENEW_AFTER_UPDATE_MANY leaseKey=${leaseKey} ownerId=${ownerId} count=${res.count}`);

    if (res.count !== 1) {
      this.mark(`RUNTIME_LEASE_RENEW_MISS leaseKey=${leaseKey} ownerId=${ownerId}`);
      return null;
    }

    const row = await this.prisma.runtimeLease.findUniqueOrThrow({
      where: { leaseKey },
    });

    this.mark(
      `RUNTIME_LEASE_RENEW_OK leaseKey=${row.leaseKey} ownerId=${row.ownerId} fencingToken=${row.fencingToken.toString()}`,
    );

    return {
      leaseKey: row.leaseKey,
      ownerId: row.ownerId,
      fencingToken: row.fencingToken,
      expiresAt: row.expiresAt,
    };
  }

  async release(leaseKey: string, ownerId: string): Promise<boolean> {
    const now = new Date();

    this.mark(`RUNTIME_LEASE_RELEASE_BEGIN leaseKey=${leaseKey} ownerId=${ownerId}`);

    const res = await this.prisma.runtimeLease.updateMany({
      where: {
        leaseKey,
        ownerId,
      },
      data: {
        expiresAt: now,
        heartbeatAt: now,
      },
    });

    this.mark(`RUNTIME_LEASE_RELEASE_AFTER_UPDATE_MANY leaseKey=${leaseKey} ownerId=${ownerId} count=${res.count}`);

    if (res.count === 1) {
      this.logger.warn(`lease released key=${leaseKey} owner=${ownerId}`);
      return true;
    }

    return false;
  }
}
