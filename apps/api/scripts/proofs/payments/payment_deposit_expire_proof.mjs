import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API = process.env.API_URL ?? 'http://localhost:3001/api';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@example.com';
const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
const DATE_YMD = process.env.DATE_YMD ?? '2027-01-14';
const TZ_NAME = process.env.TZ_NAME ?? 'Europe/Paris';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function httpRaw(path, { method = 'GET', token, body } = {}) {
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

  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
  };
}

async function http(path, opts = {}) {
  const res = await httpRaw(path, opts);
  if (!res.ok) {
    throw new Error(
      `HTTP_${res.status} ${opts.method ?? 'GET'} ${path} :: ${res.text}`,
    );
  }
  return res.json;
}

function hasSlot(results, staffId, start) {
  const row = results?.find((x) => x.staffId === staffId) ?? results?.[0];
  const slots = row?.slots ?? [];
  return slots.some((slot) => slot.start === start);
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

  const token =
    verify?.accessToken ?? verify?.token ?? verify?.tokens?.accessToken;
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

  const availabilityBeforeCreate = await http(`/availability?${qs.toString()}`);
  const createSlot = availabilityBeforeCreate?.results?.[0]?.slots?.[0];
  assert(createSlot?.start, 'NO_SLOT_FOUND_BEFORE_CREATE');

  const key = `payment-deposit-expire-proof-${Date.now()}`;

  const booking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId: service.id,
      staffId: staff.id,
      customerId: userId,
      startAt: createSlot.start,
      idempotencyKey: `${key}-create`,
    },
  });

  assert(booking?.id, 'BOOKING_CREATE_FAILED');
  assert(booking?.status === 'PENDING', `CREATE_STATUS_${booking?.status}`);
  assert(
    booking?.paymentStatus === 'DEPOSIT_PENDING',
    `CREATE_PAYMENT_STATUS_${booking?.paymentStatus}`,
  );
  assert(booking?.depositExpiresAt, 'DEPOSIT_EXPIRES_AT_MISSING');

  const availabilityAfterCreate = await http(`/availability?${qs.toString()}`);
  assert(
    !hasSlot(availabilityAfterCreate?.results, staff.id, createSlot.start),
    'SLOT_STILL_VISIBLE_AFTER_CREATE',
  );

  const earlyExpire = await httpRaw(`/bookings/${booking.id}/deposit-expire`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-expire-early`,
    },
  });

  assert(
    earlyExpire.status === 409,
    `EARLY_EXPIRE_EXPECTED_409_GOT_${earlyExpire.status}_BODY_${earlyExpire.text}`,
  );
  assert(
    earlyExpire.text.includes('Deposit hold not expired'),
    `EARLY_EXPIRE_MESSAGE_${earlyExpire.text}`,
  );

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      depositExpiresAt: new Date(Date.now() - 60_000),
    },
  });

  const expired = await http(`/bookings/${booking.id}/deposit-expire`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-expire`,
    },
  });

  assert(expired?.status === 'CANCELLED', `EXPIRE_STATUS_${expired?.status}`);
  assert(
    expired?.paymentStatus === 'NONE',
    `EXPIRE_PAYMENT_STATUS_${expired?.paymentStatus}`,
  );

  const expiredReplay = await http(`/bookings/${booking.id}/deposit-expire`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-expire`,
    },
  });

  const expiredComparable = {
    id: expired?.id,
    businessId: expired?.businessId,
    serviceId: expired?.serviceId,
    staffId: expired?.staffId,
    customerId: expired?.customerId,
    locationId: expired?.locationId ?? null,
    status: expired?.status,
    paymentStatus: expired?.paymentStatus,
    startAt: expired?.startAt,
    endAt: expired?.endAt,
  };

  const expiredReplayComparable = {
    id: expiredReplay?.id,
    businessId: expiredReplay?.businessId,
    serviceId: expiredReplay?.serviceId,
    staffId: expiredReplay?.staffId,
    customerId: expiredReplay?.customerId,
    locationId: expiredReplay?.locationId ?? null,
    status: expiredReplay?.status,
    paymentStatus: expiredReplay?.paymentStatus,
    startAt: expiredReplay?.startAt,
    endAt: expiredReplay?.endAt,
  };

  assert(
    JSON.stringify(expiredReplayComparable) === JSON.stringify(expiredComparable),
    `EXPIRE_IDEMPOTENT_REPLAY_MISMATCH_FIRST_${JSON.stringify(expiredComparable)}_REPLAY_${JSON.stringify(expiredReplayComparable)}`,
  );

  const dbBooking = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      depositExpiresAt: true,
    },
  });

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND_AFTER_EXPIRE');
  assert(
    dbBooking.status === 'CANCELLED',
    `DB_STATUS_AFTER_EXPIRE_${dbBooking?.status}`,
  );
  assert(
    dbBooking.paymentStatus === 'NONE',
    `DB_PAYMENT_STATUS_AFTER_EXPIRE_${dbBooking?.paymentStatus}`,
  );
  assert(
    dbBooking.depositExpiresAt === null,
    `DB_DEPOSIT_EXPIRES_AT_AFTER_EXPIRE_${dbBooking?.depositExpiresAt}`,
  );

  const txCount = await prisma.paymentTransaction.count({
    where: { bookingId: booking.id },
  });

  assert(txCount === 0, `UNEXPECTED_PAYMENT_TRANSACTION_COUNT_${txCount}`);

  const availabilityAfterExpire = await http(`/availability?${qs.toString()}`);
  assert(
    hasSlot(availabilityAfterExpire?.results, staff.id, createSlot.start),
    'SLOT_NOT_REOPENED_AFTER_EXPIRE',
  );

  console.log(
    JSON.stringify(
      {
        bookingId: booking.id,
        expiredStatus: dbBooking.status,
        expiredPaymentStatus: dbBooking.paymentStatus,
        paymentTransactionCount: txCount,
        slotReopened: true,
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_DEPOSIT_EXPIRE_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
