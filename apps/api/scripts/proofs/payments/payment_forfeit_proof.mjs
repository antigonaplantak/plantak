import {
  prisma,
  BUSINESS_ID,
  assert,
  http,
  httpRaw,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2027-01-08';

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  assert(slot?.start, 'NO_SLOT_FOUND_FOR_FORFEIT');

  const key = `payment-forfeit-proof-${Date.now()}`;

  const booking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
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
  assert(
    (beforeForfeit.amountDepositCentsSnapshot ?? 0) > 0,
    `DB_DEPOSIT_AMOUNT_BEFORE_FORFEIT_${beforeForfeit?.amountDepositCentsSnapshot}`,
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

  const forfeitKey = `${key}-payment-forfeit`;

  const forfeited = await http(`/bookings/${booking.id}/payment-forfeit`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: forfeitKey,
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

  const forfeitedReplay = await http(`/bookings/${booking.id}/payment-forfeit`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: forfeitKey,
    },
  });

  assert(
    forfeitedReplay?.id === forfeited?.id &&
      forfeitedReplay?.businessId === forfeited?.businessId &&
      forfeitedReplay?.staffId === forfeited?.staffId &&
      forfeitedReplay?.customerId === forfeited?.customerId &&
      forfeitedReplay?.status === forfeited?.status &&
      forfeitedReplay?.paymentStatus === forfeited?.paymentStatus &&
      forfeitedReplay?.startAt === forfeited?.startAt &&
      forfeitedReplay?.endAt === forfeited?.endAt,
    'FORFEIT_IDEMPOTENT_RESPONSE_MISMATCH',
  );

  const forfeitedOtherKey = await http(`/bookings/${booking.id}/payment-forfeit`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${forfeitKey}-other`,
    },
  });

  assert(
    forfeitedOtherKey?.id === forfeited?.id &&
      forfeitedOtherKey?.businessId === forfeited?.businessId &&
      forfeitedOtherKey?.staffId === forfeited?.staffId &&
      forfeitedOtherKey?.customerId === forfeited?.customerId &&
      forfeitedOtherKey?.status === forfeited?.status &&
      forfeitedOtherKey?.paymentStatus === forfeited?.paymentStatus &&
      forfeitedOtherKey?.startAt === forfeited?.startAt &&
      forfeitedOtherKey?.endAt === forfeited?.endAt,
    'FORFEIT_OTHER_KEY_RESPONSE_MISMATCH',
  );

  const secondSlot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  assert(secondSlot?.start, 'NO_SLOT_FOUND_FOR_FORFEIT_REUSE');

  const secondBooking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt: secondSlot.start,
      idempotencyKey: `${key}-create-2`,
    },
  });

  assert(secondBooking?.id, 'SECOND_BOOKING_CREATE_FAILED');
  assert(
    secondBooking?.id !== booking.id,
    `SECOND_BOOKING_ID_REUSED_${secondBooking?.id}`,
  );
  assert(
    secondBooking?.paymentStatus === 'DEPOSIT_PENDING',
    `SECOND_BOOKING_PAYMENT_STATUS_${secondBooking?.paymentStatus}`,
  );

  const secondPaid = await http(`/bookings/${secondBooking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid-2`,
    },
  });

  assert(
    secondPaid?.status === 'CONFIRMED',
    `SECOND_DEPOSIT_UNEXPECTED_STATUS_${secondPaid?.status}`,
  );
  assert(
    secondPaid?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `SECOND_DEPOSIT_UNEXPECTED_PAYMENT_STATUS_${secondPaid?.paymentStatus}`,
  );

  const secondCancelled = await http(`/bookings/${secondBooking.id}/cancel`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-cancel-2`,
    },
  });

  assert(
    secondCancelled?.status === 'CANCELLED',
    `SECOND_CANCEL_UNEXPECTED_STATUS_${secondCancelled?.status}`,
  );

  const reusedKeyDifferentBooking = await httpRaw(
    `/bookings/${secondBooking.id}/payment-forfeit`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        idempotencyKey: forfeitKey,
      },
    },
  );

  assert(
    reusedKeyDifferentBooking.status === 409,
    `FORFEIT_REUSED_KEY_DIFFERENT_BOOKING_STATUS_${reusedKeyDifferentBooking.status}_${reusedKeyDifferentBooking.text}`,
  );
  assert(
    reusedKeyDifferentBooking.text.includes('Idempotency key reused with different request'),
    `FORFEIT_REUSED_KEY_DIFFERENT_BOOKING_BODY_${reusedKeyDifferentBooking.text}`,
  );

  const secondDbBooking = await prisma.booking.findUnique({
    where: { id: secondBooking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
    },
  });

  const secondForfeitTxCount = await prisma.paymentTransaction.count({
    where: {
      bookingId: secondBooking.id,
      transactionType: 'DEPOSIT_FORFEIT',
    },
  });

  assert(secondDbBooking, 'SECOND_DB_BOOKING_NOT_FOUND_AFTER_CONFLICT');
  assert(
    secondDbBooking.status === 'CANCELLED',
    `SECOND_DB_STATUS_AFTER_CONFLICT_${secondDbBooking?.status}`,
  );
  assert(
    secondDbBooking.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `SECOND_DB_PAYMENT_STATUS_AFTER_CONFLICT_${secondDbBooking?.paymentStatus}`,
  );
  assert(
    secondForfeitTxCount === 0,
    `SECOND_DEPOSIT_FORFEIT_TX_COUNT_${secondForfeitTxCount}`,
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

  const forfeitedAgg = await prisma.paymentTransaction.aggregate({
    _sum: { amountCents: true },
    where: {
      bookingId: booking.id,
      transactionType: 'DEPOSIT_FORFEIT',
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
  assert(
    txs[0].currency === 'EUR',
    `DEPOSIT_FORFEIT_CURRENCY_${txs[0].currency}`,
  );
  assert(
    Boolean(txs[0].actorUserId),
    'DEPOSIT_FORFEIT_ACTOR_USER_MISSING',
  );
  assert(
    txs[0].actorRole === 'OWNER',
    `DEPOSIT_FORFEIT_ACTOR_ROLE_${txs[0].actorRole}`,
  );
  assert(
    (forfeitedAgg._sum.amountCents ?? 0) === (dbBooking.amountDepositCentsSnapshot ?? 0),
    `DEPOSIT_FORFEIT_AGG_MISMATCH_${forfeitedAgg._sum.amountCents ?? 0}_EXPECTED_${dbBooking.amountDepositCentsSnapshot ?? 0}`,
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
