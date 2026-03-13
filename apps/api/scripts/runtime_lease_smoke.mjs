import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const leaseKey = `runtime:lease:smoke:${Date.now()}`;
const ownerId = `smoke-owner-${Date.now()}`;
const now = new Date();
const expiresAt = new Date(now.getTime() + 10000);

try {
  console.log('RUNTIME_LEASE_SMOKE_BEGIN');

  await prisma.runtimeLease.createMany({
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

  console.log('RUNTIME_LEASE_SMOKE_AFTER_CREATE_MANY');

  const res = await prisma.runtimeLease.updateMany({
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

  console.log('RUNTIME_LEASE_SMOKE_AFTER_UPDATE_MANY', JSON.stringify({ count: res.count }));

  const row = await prisma.runtimeLease.findUniqueOrThrow({
    where: { leaseKey },
  });

  console.log(
    'RUNTIME_LEASE_SMOKE_OK',
    JSON.stringify({
      leaseKey: row.leaseKey,
      ownerId: row.ownerId,
      fencingToken: row.fencingToken.toString(),
    }),
  );
} finally {
  await prisma.$disconnect();
}
