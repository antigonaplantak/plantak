#!/usr/bin/env node
import fs from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

function loadDotEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const prisma = new PrismaClient();

const OWNER_EMAIL = 'owner@example.com';
const CUSTOMER_ID = '9ae97f7d-56b1-4e0e-a347-c76776bfd090';
const CUSTOMER_EMAIL = 'customer@example.com';
const BUSINESS_ID = 'b1';
const STAFF_ID = 'b9b77322-1012-4860-af1b-5b53a6171d06';
const SERVICE_ID = 'f37eca6e-8729-4a73-a498-028436514c1b';

async function main() {
  const owner = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: {
      passwordHash: 'dev-magic-login',
    },
    create: {
      email: OWNER_EMAIL,
      passwordHash: 'dev-magic-login',
    },
  });

  await prisma.user.upsert({
    where: { id: CUSTOMER_ID },
    update: {
      email: CUSTOMER_EMAIL,
      passwordHash: 'dev-customer',
    },
    create: {
      id: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
      passwordHash: 'dev-customer',
    },
  });

  await prisma.business.upsert({
    where: { id: BUSINESS_ID },
    update: {
      name: 'Plantak Demo',
      timezone: 'Europe/Paris',
    },
    create: {
      id: BUSINESS_ID,
      name: 'Plantak Demo',
      timezone: 'Europe/Paris',
    },
  });

  await prisma.businessMember.upsert({
    where: {
      businessId_userId: {
        businessId: BUSINESS_ID,
        userId: owner.id,
      },
    },
    update: {
      role: 'OWNER',
    },
    create: {
      businessId: BUSINESS_ID,
      userId: owner.id,
      role: 'OWNER',
    },
  });

  await prisma.staff.upsert({
    where: { id: STAFF_ID },
    update: {
      businessId: BUSINESS_ID,
      userId: owner.id,
      displayName: 'Owner',
      active: true,
    },
    create: {
      id: STAFF_ID,
      businessId: BUSINESS_ID,
      userId: owner.id,
      displayName: 'Owner',
      active: true,
    },
  });

  await prisma.service.upsert({
    where: { id: SERVICE_ID },
    update: {
      businessId: BUSINESS_ID,
      name: 'Signature Service',
      durationMin: 50,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      priceCents: 5000,
      currency: 'EUR',
      active: true,
      isPublic: true,
      onlineBookingEnabled: true,
      visibility: 'PUBLIC',
      archivedAt: null,
      locationId: null,
    },
    create: {
      id: SERVICE_ID,
      businessId: BUSINESS_ID,
      name: 'Signature Service',
      durationMin: 50,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      priceCents: 5000,
      currency: 'EUR',
      active: true,
      isPublic: true,
      onlineBookingEnabled: true,
      visibility: 'PUBLIC',
      archivedAt: null,
      locationId: null,
    },
  });

  await prisma.serviceStaff.upsert({
    where: {
      serviceId_staffId: {
        serviceId: SERVICE_ID,
        staffId: STAFF_ID,
      },
    },
    update: {},
    create: {
      serviceId: SERVICE_ID,
      staffId: STAFF_ID,
    },
  });

  await prisma.workingHour.deleteMany({
    where: { staffId: STAFF_ID },
  });

  await prisma.workingHour.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      staffId: STAFF_ID,
      dayOfWeek,
      startMin: 9 * 60,
      endMin: 18 * 60,
    })),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        ownerEmail: OWNER_EMAIL,
        ownerUserId: owner.id,
        businessId: BUSINESS_ID,
        staffId: STAFF_ID,
        serviceId: SERVICE_ID,
        customerId: CUSTOMER_ID,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
