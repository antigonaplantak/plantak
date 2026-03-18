import {
  prisma,
  BUSINESS_ID,
  assert,
  http,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2027-01-11';

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  assert(slot?.start, 'NO_SLOT_FOUND_FOR_REFUND');

  const key = `payment-refund-proof-${Date.now()}`;

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
  assert(
    booking?.paymentStatus === 'DEPOSIT_PENDING',
    'BOOKING_NOT_DEPOSIT_PENDING',
  );

  const paid = await http(`/bookings/${booking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid`,
    },
  });

  assert(paid?.status === 'CONFIRMED', `DEPOSIT_UNEXPECTED_STATUS_${paid?.status}`);
  assert(
    paid?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `DEPOSIT_UNEXPECTED_PAYMENT_STATUS_${paid?.paymentStatus}`,
  );

  const beforeRefund = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
      amountRemainingCentsSnapshot: true,
      amountTotalCentsSnapshot: true,
    },
  });

  assert(beforeRefund, 'DB_BOOKING_NOT_FOUND_BEFORE_REFUND');
  assert(
    beforeRefund.status === 'CONFIRMED',
    `DB_STATUS_BEFORE_REFUND_${beforeRefund?.status}`,
  );
  assert(
    beforeRefund.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `DB_PAYMENT_STATUS_BEFORE_REFUND_${beforeRefund?.paymentStatus}`,
  );
  assert(
    (beforeRefund.amountDepositCentsSnapshot ?? 0) > 0,
    `DB_DEPOSIT_AMOUNT_BEFORE_REFUND_${beforeRefund?.amountDepositCentsSnapshot}`,
  );
  assert(
    (beforeRefund.amountRemainingCentsSnapshot ?? 0) > 0,
    `DB_REMAINING_AMOUNT_BEFORE_REFUND_${beforeRefund?.amountRemainingCentsSnapshot}`,
  );
  assert(
    (beforeRefund.amountTotalCentsSnapshot ?? 0) ===
      (beforeRefund.amountDepositCentsSnapshot ?? 0) +
        (beforeRefund.amountRemainingCentsSnapshot ?? 0),
    `DB_TOTAL_MISMATCH_BEFORE_REFUND_${beforeRefund?.amountTotalCentsSnapshot}`,
  );

  const refundTxCountBefore = await prisma.paymentTransaction.count({
    where: {
      bookingId: booking.id,
      transactionType: 'REFUND',
    },
  });

  assert(refundTxCountBefore === 0, `REFUND_TX_COUNT_BEFORE_${refundTxCountBefore}`);

  const settled = await http(`/bookings/${booking.id}/payment-settle`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-payment-settle`,
    },
  });

  assert(
    settled?.status === 'CONFIRMED',
    `SETTLE_UNEXPECTED_STATUS_${settled?.status}`,
  );
  assert(
    settled?.paymentStatus === 'PAID',
    `SETTLE_UNEXPECTED_PAYMENT_STATUS_${settled?.paymentStatus}`,
  );

  const refundKey = `${key}-payment-refund`;

  const refunded = await http(`/bookings/${booking.id}/payment-refund`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: refundKey,
    },
  });

  assert(
    refunded?.status === 'CONFIRMED',
    `REFUND_UNEXPECTED_STATUS_${refunded?.status}`,
  );
  assert(
    refunded?.paymentStatus === 'REFUNDED',
    `REFUND_UNEXPECTED_PAYMENT_STATUS_${refunded?.paymentStatus}`,
  );

  const refundedReplay = await http(`/bookings/${booking.id}/payment-refund`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: refundKey,
    },
  });

  assert(
    refundedReplay?.id === refunded?.id &&
      refundedReplay?.businessId === refunded?.businessId &&
      refundedReplay?.staffId === refunded?.staffId &&
      refundedReplay?.customerId === refunded?.customerId &&
      refundedReplay?.status === refunded?.status &&
      refundedReplay?.paymentStatus === refunded?.paymentStatus &&
      refundedReplay?.startAt === refunded?.startAt &&
      refundedReplay?.endAt === refunded?.endAt,
    'REFUND_IDEMPOTENT_RESPONSE_MISMATCH',
  );

  const refundedOtherKey = await http(`/bookings/${booking.id}/payment-refund`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${refundKey}-other`,
    },
  });

  assert(
    refundedOtherKey?.id === refunded?.id,
    `REFUND_OTHER_KEY_ID_${refundedOtherKey?.id}_EXPECTED_${refunded?.id}`,
  );
  assert(
    refundedOtherKey?.status === 'CONFIRMED',
    `REFUND_OTHER_KEY_STATUS_${refundedOtherKey?.status}`,
  );
  assert(
    refundedOtherKey?.paymentStatus === 'REFUNDED',
    `REFUND_OTHER_KEY_PAYMENT_STATUS_${refundedOtherKey?.paymentStatus}`,
  );

  const dbBooking = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
      amountRemainingCentsSnapshot: true,
      amountTotalCentsSnapshot: true,
    },
  });

  const txs = await prisma.paymentTransaction.findMany({
    where: {
      bookingId: booking.id,
      transactionType: 'REFUND',
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

  const refundHistoryRows = await prisma.bookingHistory.findMany({
    where: {
      bookingId: booking.id,
      action: 'PAYMENT_REFUNDED',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      action: true,
      actorUserId: true,
      actorRole: true,
      status: true,
    },
  });

  const refundedAgg = await prisma.paymentTransaction.aggregate({
    _sum: { amountCents: true },
    where: {
      bookingId: booking.id,
      transactionType: 'REFUND',
    },
  });

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND_AFTER_REFUND');
  assert(dbBooking.status === 'CONFIRMED', `DB_STATUS_${dbBooking?.status}`);
  assert(
    dbBooking.paymentStatus === 'REFUNDED',
    `DB_PAYMENT_STATUS_${dbBooking?.paymentStatus}`,
  );
  assert(txs.length === 1, `REFUND_TX_COUNT_${txs.length}`);
  assert(
    txs[0].transactionType === 'REFUND',
    `REFUND_TX_TYPE_${txs[0].transactionType}`,
  );
  assert(
    txs[0].currency === 'EUR',
    `REFUND_TX_CURRENCY_${txs[0].currency}`,
  );
  assert(
    txs[0].actorRole === 'OWNER',
    `REFUND_TX_ACTOR_ROLE_${txs[0].actorRole}`,
  );
  assert(
    txs[0].amountCents === (dbBooking.amountTotalCentsSnapshot ?? 0),
    `REFUND_AMOUNT_MISMATCH_${txs[0].amountCents}_EXPECTED_${dbBooking.amountTotalCentsSnapshot ?? 0}`,
  );
  assert(
    refundHistoryRows.length === 1,
    `REFUND_HISTORY_COUNT_${refundHistoryRows.length}`,
  );
  assert(
    refundHistoryRows[0].action === 'PAYMENT_REFUNDED',
    `REFUND_HISTORY_ACTION_${refundHistoryRows[0].action}`,
  );
  assert(
    refundHistoryRows[0].actorRole === 'OWNER',
    `REFUND_HISTORY_ACTOR_ROLE_${refundHistoryRows[0].actorRole}`,
  );
  assert(
    (refundedAgg._sum.amountCents ?? 0) === (dbBooking.amountTotalCentsSnapshot ?? 0),
    `REFUND_AGG_MISMATCH_${refundedAgg._sum.amountCents ?? 0}_EXPECTED_${dbBooking.amountTotalCentsSnapshot ?? 0}`,
  );

  console.log(
    JSON.stringify(
      {
        bookingId: booking.id,
        status: dbBooking.status,
        paymentStatus: dbBooking.paymentStatus,
        depositAmountCents: dbBooking.amountDepositCentsSnapshot,
        remainingAmountCents: dbBooking.amountRemainingCentsSnapshot,
        totalAmountCents: dbBooking.amountTotalCentsSnapshot,
        ledgerRow: txs[0],
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_REFUND_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
