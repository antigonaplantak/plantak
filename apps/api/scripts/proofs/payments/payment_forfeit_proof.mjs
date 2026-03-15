import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API = process.env.API_URL ?? 'http://localhost:3001/api';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@example.com';
const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
const DATE_YMD = process.env.DATE_YMD ?? '2027-01-08';
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
  const service = await prisma.service.findFirst({
    where: { businessId: BUSINESS_ID, active: true },
    select: { id: true },
  });

  assert(staff?.id, 'ACTIVE_STAFF_NOT_FOUND');
  assert(service?.id, 'ACTIVE_SERVICE_NOT_FOUND');

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

  const key = `payment-forfeit-proof-${Date.now()}`;

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
  assert(booking?.paymentStatus === 'DEPOSIT_PENDING', 'BOOKING_NOT_DEPOSIT_PENDING');

  const paid = await http(`/bookings/${booking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid`,
    },
  });

  assert(paid?.status === 'CONFIRMED', `UNEXPECTED_STATUS_${paid?.status}`);
  assert(
    paid?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `UNEXPECTED_PAYMENT_STATUS_AFTER_DEPOSIT_${paid?.paymentStatus}`,
  );

  const beforeForfeit = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
    },
  });

  assert(beforeForfeit, 'DB_BOOKING_NOT_FOUND_BEFORE_FORFEIT');
  assert(
    beforeForfeit.status === 'CONFIRMED',
    `DB_STATUS_BEFORE_FORFEIT_${beforeForfeit?.status}`,
  );
  assert(
    beforeForfeit.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `DB_PAYMENT_STATUS_BEFORE_FORFEIT_${beforeForfeit?.paymentStatus}`,
  );

  const cancelled = await http(`/bookings/${booking.id}/cancel`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-cancel`,
    },
  });

  assert(
    cancelled?.status === 'CANCELLED',
    `CANCEL_UNEXPECTED_STATUS_${cancelled?.status}`,
  );

  const forfeited = await http(`/bookings/${booking.id}/payment-forfeit`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-payment-forfeit`,
    },
  });

  assert(
    forfeited?.status === 'CANCELLED',
    `FORFEIT_UNEXPECTED_STATUS_${forfeited?.status}`,
  );
  assert(
    forfeited?.paymentStatus === 'DEPOSIT_FORFEITED',
    `FORFEIT_UNEXPECTED_PAYMENT_STATUS_${forfeited?.paymentStatus}`,
  );

  const dbBooking = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
    },
  });

  const txs = await prisma.paymentTransaction.findMany({
    where: {
      bookingId: booking.id,
      transactionType: 'DEPOSIT_FORFEIT',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      transactionType: true,
      amountCents: true,
      currency: true,
      actorUserId: true,
      actorRole: true,
    },
  });

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND_AFTER_FORFEIT');
  assert(dbBooking.status === 'CANCELLED', `DB_STATUS_${dbBooking?.status}`);
  assert(
    dbBooking.paymentStatus === 'DEPOSIT_FORFEITED',
    `DB_PAYMENT_STATUS_${dbBooking?.paymentStatus}`,
  );
  assert(txs.length === 1, `DEPOSIT_FORFEIT_TX_COUNT_${txs.length}`);
  assert(
    txs[0].amountCents === (dbBooking.amountDepositCentsSnapshot ?? 0),
    `DEPOSIT_FORFEIT_AMOUNT_MISMATCH_${txs[0].amountCents}_EXPECTED_${dbBooking.amountDepositCentsSnapshot ?? 0}`,
  );

  console.log(JSON.stringify({
    bookingId: booking.id,
    status: dbBooking.status,
    paymentStatus: dbBooking.paymentStatus,
    depositAmountCents: dbBooking.amountDepositCentsSnapshot,
    ledgerRow: txs[0],
  }, null, 2));

  console.log('PAYMENT_FORFEIT_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
