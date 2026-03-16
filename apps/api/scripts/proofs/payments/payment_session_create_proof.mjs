import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API = process.env.API_URL ?? 'http://localhost:3001/api';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@example.com';
const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
const DATE_YMD = process.env.DATE_YMD ?? '2027-01-18';
const TZ_NAME = process.env.TZ_NAME ?? 'Europe/Paris';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function http(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(`HTTP_${res.status} ${method} ${path} :: ${text}`);
  }

  return json;
}

async function main() {
  const staff = await prisma.staff.findFirst({
    where: { businessId: BUSINESS_ID, active: true },
    select: { id: true },
  });

  assert(staff?.id, 'ACTIVE_STAFF_NOT_FOUND');

  const proofServiceName = '__payment-session-proof-service__';

  const existingProofService = await prisma.service.findFirst({
    where: {
      businessId: BUSINESS_ID,
      name: proofServiceName,
      archivedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const service = existingProofService
    ? await prisma.service.update({
        where: { id: existingProofService.id },
        data: {
          active: true,
          archivedAt: null,
          visibility: 'PUBLIC',
          onlineBookingEnabled: true,
          durationMin: 50,
          priceCents: 5000,
          currency: 'EUR',
          depositPercent: 30,
          useBusinessDepositDefault: false,
        },
        select: { id: true },
      })
    : await prisma.service.create({
        data: {
          businessId: BUSINESS_ID,
          name: proofServiceName,
          durationMin: 50,
          priceCents: 5000,
          currency: 'EUR',
          depositPercent: 30,
          useBusinessDepositDefault: false,
          active: true,
          visibility: 'PUBLIC',
          onlineBookingEnabled: true,
        },
        select: { id: true },
      });

  await prisma.serviceStaff.upsert({
    where: {
      serviceId_staffId: {
        serviceId: service.id,
        staffId: staff.id,
      },
    },
    create: {
      serviceId: service.id,
      staffId: staff.id,
      isActive: true,
      onlineBookingEnabled: true,
      useStaffDepositDefault: false,
      depositPercent: 30,
    },
    update: {
      isActive: true,
      onlineBookingEnabled: true,
      useStaffDepositDefault: false,
      depositPercent: 30,
    },
  });

  assert(service?.id, 'PROOF_SERVICE_NOT_READY');

  const magicReq = await http('/auth/magic/request', {
    method: 'POST',
    body: { email: OWNER_EMAIL },
  });
  const code = magicReq?.devCode ?? magicReq?.code;
  assert(typeof code === 'string' && code.length > 0, 'MAGIC_CODE_NOT_FOUND');

  const verify = await http('/auth/magic/verify', {
    method: 'POST',
    body: { email: OWNER_EMAIL, code },
  });

  const token = verify?.accessToken ?? verify?.token ?? verify?.tokens?.accessToken;
  const userId = verify?.user?.id ?? verify?.userId ?? verify?.sub;

  assert(typeof token === 'string' && token.length > 0, 'TOKEN_NOT_FOUND');
  assert(typeof userId === 'string' && userId.length > 0, 'USER_ID_NOT_FOUND');

  const qs = new URLSearchParams({
    businessId: BUSINESS_ID,
    serviceId: service.id,
    staffId: staff.id,
    date: DATE_YMD,
    tz: TZ_NAME,
  });

  const availability = await http(`/availability?${qs.toString()}`);
  const slot = availability?.results?.[0]?.slots?.[0];
  assert(slot?.start, 'NO_SLOT_FOUND');

  const key = `payment-session-proof-${Date.now()}`;

  const booking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId: service.id,
      staffId: staff.id,
      customerId: userId,
      startAt: slot.start,
      idempotencyKey: `${key}-create`,
    },
  });

  assert(booking?.id, 'BOOKING_CREATE_FAILED');
  assert(booking?.paymentStatus === 'DEPOSIT_PENDING', `CREATE_PAYMENT_STATUS_${booking?.paymentStatus}`);
  assert(booking?.depositResolvedFromScope === 'STAFF_SERVICE_OVERRIDE', `CREATE_DEPOSIT_SCOPE_${booking?.depositResolvedFromScope}`);
  assert(booking?.amountDepositCentsSnapshot === 1500, `CREATE_DEPOSIT_AMOUNT_${booking?.amountDepositCentsSnapshot}`);
  assert(booking?.amountRemainingCentsSnapshot === 3500, `CREATE_REMAINING_AMOUNT_${booking?.amountRemainingCentsSnapshot}`);

  const first = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session`,
      returnUrl: 'https://example.test/return',
      cancelUrl: 'https://example.test/cancel',
    },
  });

  assert(first?.id, 'SESSION_CREATE_FAILED');
  assert(first?.bookingId === booking.id, `SESSION_BOOKING_ID_${first?.bookingId}`);
  assert(first?.businessId === BUSINESS_ID, `SESSION_BUSINESS_ID_${first?.businessId}`);
  assert(first?.provider === 'stub', `SESSION_PROVIDER_${first?.provider}`);
  assert(first?.status === 'OPEN', `SESSION_STATUS_${first?.status}`);
  assert(first?.amountCents === booking.amountDepositCentsSnapshot, `SESSION_AMOUNT_${first?.amountCents}_EXPECTED_${booking.amountDepositCentsSnapshot}`);

  const replaySameKey = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session`,
      returnUrl: 'https://example.test/return',
      cancelUrl: 'https://example.test/cancel',
    },
  });

  assert(replaySameKey?.id === first.id, `REPLAY_SESSION_ID_${replaySameKey?.id}_EXPECTED_${first.id}`);

  const reuseOpen = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session-other`,
    },
  });

  assert(reuseOpen?.id === first.id, `OPEN_REUSE_SESSION_ID_${reuseOpen?.id}_EXPECTED_${first.id}`);

  const dbSession = await prisma.paymentSession.findUnique({
    where: { id: first.id },
    select: {
      id: true,
      bookingId: true,
      businessId: true,
      provider: true,
      status: true,
      amountCents: true,
      currency: true,
      idempotencyKey: true,
    },
  });

  assert(dbSession, 'DB_SESSION_NOT_FOUND');
  assert(dbSession.bookingId === booking.id, `DB_SESSION_BOOKING_${dbSession?.bookingId}`);
  assert(dbSession.status === 'OPEN', `DB_SESSION_STATUS_${dbSession?.status}`);
  assert(dbSession.amountCents === booking.amountDepositCentsSnapshot, `DB_SESSION_AMOUNT_${dbSession?.amountCents}_EXPECTED_${booking.amountDepositCentsSnapshot}`);

  console.log(JSON.stringify({
    bookingId: booking.id,
    sessionId: first.id,
    amountCents: dbSession.amountCents,
    status: dbSession.status,
  }, null, 2));

  console.log('PAYMENT_SESSION_CREATE_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
