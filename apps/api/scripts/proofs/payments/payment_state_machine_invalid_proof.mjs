import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API = process.env.API_URL ?? 'http://localhost:3001/api';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@example.com';
const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
const DATE_YMD = process.env.DATE_YMD ?? '2027-01-12';
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

  return { status: res.status, text, json };
}

function bodyText(res) {
  return typeof res?.text === 'string' && res.text.length > 0
    ? res.text
    : JSON.stringify(res?.json ?? null);
}

async function httpOk(path, options = {}) {
  const res = await httpRaw(path, options);
  assert(
    res.status >= 200 && res.status < 300,
    `HTTP_${res.status} ${options.method ?? 'GET'} ${path} :: ${bodyText(res)}`,
  );
  return res.json;
}

async function expectHttpStatus(path, options, expectedStatus, label) {
  const res = await httpRaw(path, options);
  assert(
    res.status === expectedStatus,
    `${label}_EXPECTED_${expectedStatus}_GOT_${res.status}_BODY_${bodyText(res)}`,
  );
  return res;
}

async function authOwner() {
  const magicReq = await httpOk('/auth/magic/request', {
    method: 'POST',
    body: { email: OWNER_EMAIL },
  });

  const code = magicReq?.devCode ?? magicReq?.code;
  assert(typeof code === 'string' && code.length > 0, 'MAGIC_CODE_NOT_FOUND');

  const verify = await httpOk('/auth/magic/verify', {
    method: 'POST',
    body: { email: OWNER_EMAIL, code },
  });

  const token =
    verify?.accessToken ?? verify?.token ?? verify?.tokens?.accessToken;
  const userId = verify?.user?.id ?? verify?.userId ?? verify?.sub;

  assert(typeof token === 'string' && token.length > 0, 'TOKEN_NOT_FOUND');
  assert(typeof userId === 'string' && userId.length > 0, 'USER_ID_NOT_FOUND');

  return { token, userId };
}

async function pickActiveStaffService() {
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

  return { staffId: staff.id, serviceId: service.id };
}

async function firstAvailableSlot(serviceId, staffId) {
  const qs = new URLSearchParams({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    date: DATE_YMD,
    tz: TZ_NAME,
  });

  const availability = await httpOk(`/availability?${qs.toString()}`);
  const slot = availability?.results?.[0]?.slots?.[0];

  assert(slot?.start, 'NO_SLOT_FOUND');
  return slot.start;
}

async function createBooking(token, userId, serviceId, staffId, idempotencyKey) {
  const startAt = await firstAvailableSlot(serviceId, staffId);

  const booking = await httpOk('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt,
      idempotencyKey,
    },
  });

  assert(booking?.id, 'BOOKING_CREATE_FAILED');
  return booking;
}

async function markDepositPaid(token, bookingId, idempotencyKey) {
  return httpOk(`/bookings/${bookingId}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey,
    },
  });
}

async function settlePayment(token, bookingId, idempotencyKey) {
  return httpOk(`/bookings/${bookingId}/payment-settle`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey,
    },
  });
}

async function readBooking(bookingId) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
      amountRemainingCentsSnapshot: true,
      amountTotalCentsSnapshot: true,
    },
  });
}

async function countPaymentTx(bookingId, transactionTypes) {
  return prisma.paymentTransaction.count({
    where: {
      bookingId,
      transactionType: { in: transactionTypes },
    },
  });
}

async function main() {
  const { token, userId } = await authOwner();
  const { staffId, serviceId } = await pickActiveStaffService();

  const key = `payment-state-machine-invalid-proof-${Date.now()}`;

  const pendingBooking = await createBooking(
    token,
    userId,
    serviceId,
    staffId,
    `${key}-pending-create`,
  );

  assert(
    pendingBooking.paymentStatus === 'DEPOSIT_PENDING',
    `PENDING_BOOKING_PAYMENT_STATUS_${pendingBooking?.paymentStatus}`,
  );

  await expectHttpStatus(
    `/bookings/${pendingBooking.id}/payment-settle`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-pending-settle-invalid`,
      },
    },
    400,
    'PENDING_SETTLE_INVALID',
  );

  await expectHttpStatus(
    `/bookings/${pendingBooking.id}/payment-forfeit`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-pending-forfeit-invalid`,
      },
    },
    409,
    'PENDING_FORFEIT_INVALID',
  );

  await expectHttpStatus(
    `/bookings/${pendingBooking.id}/payment-refund`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-pending-refund-invalid`,
      },
    },
    409,
    'PENDING_REFUND_INVALID',
  );

  await expectHttpStatus(
    `/bookings/${pendingBooking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: 100,
        idempotencyKey: `${key}-pending-partial-refund-invalid`,
      },
    },
    409,
    'PENDING_PARTIAL_REFUND_INVALID',
  );

  const pendingDb = await readBooking(pendingBooking.id);
  assert(pendingDb, 'PENDING_DB_BOOKING_NOT_FOUND');
  assert(
    pendingDb.status === 'PENDING',
    `PENDING_DB_STATUS_${pendingDb?.status}`,
  );
  assert(
    pendingDb.paymentStatus === 'DEPOSIT_PENDING',
    `PENDING_DB_PAYMENT_STATUS_${pendingDb?.paymentStatus}`,
  );

  const pendingInvalidTxCount = await countPaymentTx(pendingBooking.id, [
    'FINAL_SETTLEMENT',
    'DEPOSIT_FORFEIT',
    'REFUND',
    'PARTIAL_REFUND',
  ]);

  assert(
    pendingInvalidTxCount === 0,
    `PENDING_INVALID_TX_COUNT_${pendingInvalidTxCount}`,
  );

  const confirmedBooking = await createBooking(
    token,
    userId,
    serviceId,
    staffId,
    `${key}-confirmed-create`,
  );

  assert(
    (confirmedBooking.amountDepositCentsSnapshot ?? 0) > 0,
    `CONFIRMED_BOOKING_NO_DEPOSIT_${confirmedBooking.amountDepositCentsSnapshot ?? 0}`,
  );

  const confirmedAfterDeposit = await markDepositPaid(
    token,
    confirmedBooking.id,
    `${key}-confirmed-deposit-paid`,
  );

  assert(
    confirmedAfterDeposit.status === 'CONFIRMED',
    `CONFIRMED_AFTER_DEPOSIT_STATUS_${confirmedAfterDeposit?.status}`,
  );
  assert(
    confirmedAfterDeposit.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `CONFIRMED_AFTER_DEPOSIT_PAYMENT_STATUS_${confirmedAfterDeposit?.paymentStatus}`,
  );

  await expectHttpStatus(
    `/bookings/${confirmedBooking.id}/payment-waive`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-confirmed-waive-invalid`,
      },
    },
    409,
    'CONFIRMED_WAIVE_INVALID',
  );

  await expectHttpStatus(
    `/bookings/${confirmedBooking.id}/payment-forfeit`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-confirmed-forfeit-invalid`,
      },
    },
    409,
    'CONFIRMED_FORFEIT_INVALID',
  );

  await expectHttpStatus(
    `/bookings/${confirmedBooking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: confirmedBooking.amountDepositCentsSnapshot ?? 0,
        idempotencyKey: `${key}-confirmed-partial-refund-full-invalid`,
      },
    },
    409,
    'CONFIRMED_PARTIAL_REFUND_FULL_AMOUNT_INVALID',
  );

  const confirmedDb = await readBooking(confirmedBooking.id);
  assert(confirmedDb, 'CONFIRMED_DB_BOOKING_NOT_FOUND');
  assert(
    confirmedDb.status === 'CONFIRMED',
    `CONFIRMED_DB_STATUS_${confirmedDb?.status}`,
  );
  assert(
    confirmedDb.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `CONFIRMED_DB_PAYMENT_STATUS_${confirmedDb?.paymentStatus}`,
  );

  const confirmedInvalidTxCount = await countPaymentTx(confirmedBooking.id, [
    'DEPOSIT_WAIVE',
    'DEPOSIT_FORFEIT',
    'REFUND',
    'PARTIAL_REFUND',
  ]);

  assert(
    confirmedInvalidTxCount === 0,
    `CONFIRMED_INVALID_TX_COUNT_${confirmedInvalidTxCount}`,
  );

  const paidBooking = await createBooking(
    token,
    userId,
    serviceId,
    staffId,
    `${key}-paid-create`,
  );

  const paidAfterDeposit = await markDepositPaid(
    token,
    paidBooking.id,
    `${key}-paid-deposit-paid`,
  );

  assert(
    paidAfterDeposit.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_AFTER_DEPOSIT_PAYMENT_STATUS_${paidAfterDeposit?.paymentStatus}`,
  );

  const paidAfterSettle = await settlePayment(
    token,
    paidBooking.id,
    `${key}-paid-settle`,
  );

  assert(
    paidAfterSettle.status === 'CONFIRMED',
    `PAID_AFTER_SETTLE_STATUS_${paidAfterSettle?.status}`,
  );
  assert(
    paidAfterSettle.paymentStatus === 'PAID',
    `PAID_AFTER_SETTLE_PAYMENT_STATUS_${paidAfterSettle?.paymentStatus}`,
  );

  await expectHttpStatus(
    `/bookings/${paidBooking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: paidBooking.amountTotalCentsSnapshot ?? 0,
        idempotencyKey: `${key}-paid-partial-refund-full-invalid`,
      },
    },
    409,
    'PAID_PARTIAL_REFUND_FULL_AMOUNT_INVALID',
  );

  const paidDb = await readBooking(paidBooking.id);
  assert(paidDb, 'PAID_DB_BOOKING_NOT_FOUND');
  assert(
    paidDb.status === 'CONFIRMED',
    `PAID_DB_STATUS_${paidDb?.status}`,
  );
  assert(
    paidDb.paymentStatus === 'PAID',
    `PAID_DB_PAYMENT_STATUS_${paidDb?.paymentStatus}`,
  );

  const paidPartialRefundTxCount = await countPaymentTx(paidBooking.id, [
    'PARTIAL_REFUND',
  ]);

  assert(
    paidPartialRefundTxCount === 0,
    `PAID_INVALID_PARTIAL_REFUND_TX_COUNT_${paidPartialRefundTxCount}`,
  );

  console.log(
    JSON.stringify(
      {
        pendingBookingId: pendingBooking.id,
        confirmedBookingId: confirmedBooking.id,
        paidBookingId: paidBooking.id,
        pendingInvalidTxCount,
        confirmedInvalidTxCount,
        paidPartialRefundTxCount,
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_STATE_MACHINE_INVALID_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
