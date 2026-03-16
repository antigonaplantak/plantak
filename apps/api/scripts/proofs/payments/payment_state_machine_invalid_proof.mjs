import {
  prisma,
  BUSINESS_ID,
  assert,
  httpRaw,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2027-01-12';

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

async function createBooking(token, userId, serviceId, staffId, idempotencyKey) {
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  const booking = await httpOk('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt: slot.start,
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
  const { staffId, serviceId } = await ensureDepositEnabledFixture();

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
  assert(pendingDb.status === 'PENDING', `PENDING_DB_STATUS_${pendingDb?.status}`);
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

  const confirmedPaid = await markDepositPaid(
    token,
    confirmedBooking.id,
    `${key}-confirmed-deposit-paid`,
  );

  assert(
    confirmedPaid.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `CONFIRMED_DEPOSIT_PAID_STATUS_${confirmedPaid?.paymentStatus}`,
  );

  await expectHttpStatus(
    `/bookings/${confirmedBooking.id}/deposit-paid`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-confirmed-deposit-paid-again`,
      },
    },
    409,
    'CONFIRMED_DEPOSIT_PAID_INVALID',
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
        amountCents: 5000,
        idempotencyKey: `${key}-confirmed-partial-refund-full-invalid`,
      },
    },
    409,
    'CONFIRMED_PARTIAL_REFUND_INVALID',
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

  await markDepositPaid(token, paidBooking.id, `${key}-paid-deposit-paid`);
  const paidSettled = await settlePayment(
    token,
    paidBooking.id,
    `${key}-paid-settle`,
  );

  assert(
    paidSettled.paymentStatus === 'PAID',
    `PAID_BOOKING_PAYMENT_STATUS_${paidSettled?.paymentStatus}`,
  );

  await expectHttpStatus(
    `/bookings/${paidBooking.id}/deposit-paid`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: `${key}-paid-deposit-paid-again`,
      },
    },
    409,
    'PAID_DEPOSIT_PAID_INVALID',
  );

  const paidDb = await readBooking(paidBooking.id);
  assert(paidDb, 'PAID_DB_BOOKING_NOT_FOUND');

  await expectHttpStatus(
    `/bookings/${paidBooking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: paidDb.amountTotalCentsSnapshot ?? 0,
        idempotencyKey: `${key}-paid-partial-refund-full-invalid`,
      },
    },
    409,
    'PAID_PARTIAL_REFUND_FULL_INVALID',
  );

  const paidPartialRefundTxCount = await countPaymentTx(paidBooking.id, [
    'PARTIAL_REFUND',
  ]);

  assert(
    paidPartialRefundTxCount === 0,
    `PAID_PARTIAL_REFUND_TX_COUNT_${paidPartialRefundTxCount}`,
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
