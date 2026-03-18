import {
  prisma,
  BUSINESS_ID,
  TZ_NAME,
  assert,
  http,
  httpRaw,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2027-01-14';

function hasSlot(results, staffId, start) {
  const row = results?.find((x) => x.staffId === staffId) ?? results?.[0];
  const slots = row?.slots ?? [];
  return slots.some((slot) => slot.start === start);
}

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();

  const qs = new URLSearchParams({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    date: DATE_YMD,
    tz: TZ_NAME,
  });

  const createSlot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  assert(createSlot?.start, 'NO_SLOT_FOUND_BEFORE_CREATE');

  const resolvedDateYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_NAME,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(createSlot.start));

  const resolvedQs = new URLSearchParams({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    date: resolvedDateYmd,
    tz: TZ_NAME,
  });

  const key = `payment-deposit-expire-proof-${Date.now()}`;

  const booking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
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

  const availabilityAfterCreate = await http(`/availability?${resolvedQs.toString()}`);
  assert(
    !hasSlot(availabilityAfterCreate?.results, staffId, createSlot.start),
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

  const confirmAfterExpire = await httpRaw(`/bookings/${booking.id}/confirm`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-confirm-after-expire-invalid`,
    },
  });

  assert(
    confirmAfterExpire.status === 400,
    `CONFIRM_AFTER_EXPIRE_EXPECTED_400_GOT_${confirmAfterExpire.status}_BODY_${confirmAfterExpire.text}`,
  );

  const depositPaidAfterExpire = await httpRaw(`/bookings/${booking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid-after-expire-invalid`,
    },
  });

  assert(
    depositPaidAfterExpire.status === 400,
    `DEPOSIT_PAID_AFTER_EXPIRE_EXPECTED_400_GOT_${depositPaidAfterExpire.status}_BODY_${depositPaidAfterExpire.text}`,
  );

  const txCount = await prisma.paymentTransaction.count({
    where: { bookingId: booking.id },
  });

  assert(txCount === 0, `UNEXPECTED_PAYMENT_TRANSACTION_COUNT_${txCount}`);

  const cancelHistoryCount = await prisma.bookingHistory.count({
    where: {
      bookingId: booking.id,
      action: 'CANCEL',
    },
  });

  assert(
    cancelHistoryCount === 1,
    `DEPOSIT_EXPIRE_CANCEL_HISTORY_COUNT_${cancelHistoryCount}`,
  );

  const availabilityAfterExpire = await http(`/availability?${resolvedQs.toString()}`);
  assert(
    hasSlot(availabilityAfterExpire?.results, staffId, createSlot.start),
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
