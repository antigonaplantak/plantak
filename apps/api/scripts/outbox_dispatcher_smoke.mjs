import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';

const prisma = new PrismaClient();
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

async function main() {
  const latest = await prisma.outboxEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      eventType: true,
      status: true,
      aggregateId: true,
      sentAt: true,
      createdAt: true,
    },
  });

  console.log('== OUTBOX LATEST ==');
  console.table(latest);

  const queueKeys = await redis.keys('bull:*');
  console.log('== REDIS BULL KEYS ==');
  console.log(queueKeys.sort());
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
