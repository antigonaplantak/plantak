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

  assert(slot?.start, 'NO_SLOT_FOUND_FOR_PARTIAL_REFUND');

  const key = `payment-partial-refund-proof-${Date.now()}`;

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
    `BOOKING_NOT_DEPOSIT_PENDING_${booking?.paymentStatus}`,
  );

  const paidDeposit = await http(`/bookings/${booking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid`,
    },
  });

  assert(
    paidDeposit?.status === 'CONFIRMED',
    `DEPOSIT_PAID_UNEXPECTED_STATUS_${paidDeposit?.status}`,
  );
  assert(
    paidDeposit?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `DEPOSIT_PAID_UNEXPECTED_PAYMENT_STATUS_${paidDeposit?.paymentStatus}`,
  );

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

  const beforePartial = await prisma.booking.findUnique({
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

  assert(beforePartial, 'DB_BOOKING_NOT_FOUND_BEFORE_PARTIAL_REFUND');
  assert(
    beforePartial.status === 'CONFIRMED',
    `DB_STATUS_BEFORE_PARTIAL_REFUND_${beforePartial?.status}`,
  );
  assert(
    beforePartial.paymentStatus === 'PAID',
    `DB_PAYMENT_STATUS_BEFORE_PARTIAL_REFUND_${beforePartial?.paymentStatus}`,
  );
  assert(
    (beforePartial.amountDepositCentsSnapshot ?? 0) > 0,
    `DB_DEPOSIT_AMOUNT_BEFORE_PARTIAL_REFUND_${beforePartial?.amountDepositCentsSnapshot}`,
  );
  assert(
    (beforePartial.amountRemainingCentsSnapshot ?? 0) > 0,
    `DB_REMAINING_AMOUNT_BEFORE_PARTIAL_REFUND_${beforePartial?.amountRemainingCentsSnapshot}`,
  );
  assert(
    (beforePartial.amountTotalCentsSnapshot ?? 0) ===
      (beforePartial.amountDepositCentsSnapshot ?? 0) +
        (beforePartial.amountRemainingCentsSnapshot ?? 0),
    `DB_TOTAL_SPLIT_MISMATCH_${beforePartial?.amountTotalCentsSnapshot}_EXPECTED_${
      (beforePartial?.amountDepositCentsSnapshot ?? 0) +
      (beforePartial?.amountRemainingCentsSnapshot ?? 0)
    }`,
  );

  const partialAmountCents = 1000;
  const totalAmountCents = beforePartial.amountTotalCentsSnapshot ?? 0;
  const conflictingAmountCents = 1500;

  assert(
    partialAmountCents > 0 && partialAmountCents < totalAmountCents,
    `INVALID_PARTIAL_REFUND_AMOUNT_${partialAmountCents}_TOTAL_${totalAmountCents}`,
  );
  assert(
    conflictingAmountCents > 0 && conflictingAmountCents < totalAmountCents,
    `INVALID_CONFLICTING_PARTIAL_REFUND_AMOUNT_${conflictingAmountCents}_TOTAL_${totalAmountCents}`,
  );

  const partialKey = `${key}-payment-refund-partial`;

  const partial1 = await http(`/bookings/${booking.id}/payment-refund-partial`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      amountCents: partialAmountCents,
      idempotencyKey: partialKey,
    },
  });

  assert(
    partial1?.status === 'CONFIRMED',
    `PARTIAL_REFUND_UNEXPECTED_STATUS_${partial1?.status}`,
  );
  assert(
    partial1?.paymentStatus === 'PAID',
    `PARTIAL_REFUND_UNEXPECTED_PAYMENT_STATUS_${partial1?.paymentStatus}`,
  );
  assert(
    partial1?.refundedAmountCents === partialAmountCents,
    `PARTIAL_REFUND_AMOUNT_RESPONSE_${partial1?.refundedAmountCents}_EXPECTED_${partialAmountCents}`,
  );
  assert(
    partial1?.remainingRefundableCents === totalAmountCents - partialAmountCents,
    `PARTIAL_REFUND_REMAINING_RESPONSE_${partial1?.remainingRefundableCents}_EXPECTED_${totalAmountCents - partialAmountCents}`,
  );

  const partial2 = await http(`/bookings/${booking.id}/payment-refund-partial`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      amountCents: partialAmountCents,
      idempotencyKey: partialKey,
    },
  });

  assert(
    partial2?.id === partial1?.id &&
      partial2?.status === partial1?.status &&
      partial2?.paymentStatus === partial1?.paymentStatus &&
      partial2?.refundedAmountCents === partial1?.refundedAmountCents &&
      partial2?.remainingRefundableCents === partial1?.remainingRefundableCents,
    'PARTIAL_REFUND_IDEMPOTENT_RESPONSE_MISMATCH',
  );

  const reusedSameKeyDifferentAmount = await httpRaw(
    `/bookings/${booking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: conflictingAmountCents,
        idempotencyKey: partialKey,
      },
    },
  );

  assert(
    reusedSameKeyDifferentAmount.status === 409,
    `PARTIAL_REFUND_SAME_KEY_DIFFERENT_AMOUNT_STATUS_${reusedSameKeyDifferentAmount.status}_${reusedSameKeyDifferentAmount.text}`,
  );
  assert(
    reusedSameKeyDifferentAmount.text.includes(
      'Idempotency key reused with different request',
    ),
    `PARTIAL_REFUND_SAME_KEY_DIFFERENT_AMOUNT_BODY_${reusedSameKeyDifferentAmount.text}`,
  );

  const secondSlot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  assert(secondSlot?.start, 'NO_SECOND_SLOT_FOUND_FOR_PARTIAL_REFUND');
  assert(
    secondSlot.start !== slot.start,
    `SECOND_SLOT_NOT_DISTINCT_${secondSlot.start}`,
  );

  const secondBooking = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt: secondSlot.start,
      idempotencyKey: `${key}-create-second`,
    },
  });

  assert(secondBooking?.id, 'SECOND_BOOKING_CREATE_FAILED');
  assert(
    secondBooking?.paymentStatus === 'DEPOSIT_PENDING',
    `SECOND_BOOKING_NOT_DEPOSIT_PENDING_${secondBooking?.paymentStatus}`,
  );

  const secondPaidDeposit = await http(`/bookings/${secondBooking.id}/deposit-paid`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-deposit-paid-second`,
    },
  });

  assert(
    secondPaidDeposit?.status === 'CONFIRMED',
    `SECOND_DEPOSIT_PAID_UNEXPECTED_STATUS_${secondPaidDeposit?.status}`,
  );
  assert(
    secondPaidDeposit?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `SECOND_DEPOSIT_PAID_UNEXPECTED_PAYMENT_STATUS_${secondPaidDeposit?.paymentStatus}`,
  );

  const secondSettled = await http(`/bookings/${secondBooking.id}/payment-settle`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-payment-settle-second`,
    },
  });

  assert(
    secondSettled?.status === 'CONFIRMED',
    `SECOND_SETTLE_UNEXPECTED_STATUS_${secondSettled?.status}`,
  );
  assert(
    secondSettled?.paymentStatus === 'PAID',
    `SECOND_SETTLE_UNEXPECTED_PAYMENT_STATUS_${secondSettled?.paymentStatus}`,
  );

  const reusedAcrossBooking = await httpRaw(
    `/bookings/${secondBooking.id}/payment-refund-partial`,
    {
      method: 'POST',
      token,
      body: {
        businessId: BUSINESS_ID,
        amountCents: partialAmountCents,
        idempotencyKey: partialKey,
      },
    },
  );

  assert(
    reusedAcrossBooking.status === 409,
    `PARTIAL_REFUND_CROSS_BOOKING_KEY_STATUS_${reusedAcrossBooking.status}_${reusedAcrossBooking.text}`,
  );
  assert(
    reusedAcrossBooking.text.includes('Idempotency key reused with different request'),
    `PARTIAL_REFUND_CROSS_BOOKING_KEY_BODY_${reusedAcrossBooking.text}`,
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

  const secondDbBooking = await prisma.booking.findUnique({
    where: { id: secondBooking.id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
    },
  });

  const txs = await prisma.paymentTransaction.findMany({
    where: {
      bookingId: booking.id,
      transactionType: 'PARTIAL_REFUND',
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

  const secondBookingTxs = await prisma.paymentTransaction.findMany({
    where: {
      bookingId: secondBooking.id,
      transactionType: 'PARTIAL_REFUND',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
    },
  });

  const refundedAgg = await prisma.paymentTransaction.aggregate({
    _sum: { amountCents: true },
    where: {
      bookingId: booking.id,
      transactionType: { in: ['REFUND', 'PARTIAL_REFUND'] },
    },
  });

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND_AFTER_PARTIAL_REFUND');
  assert(
    dbBooking.status === 'CONFIRMED',
    `DB_STATUS_AFTER_PARTIAL_REFUND_${dbBooking?.status}`,
  );
  assert(
    dbBooking.paymentStatus === 'PAID',
    `DB_PAYMENT_STATUS_AFTER_PARTIAL_REFUND_${dbBooking?.paymentStatus}`,
  );
  assert(txs.length === 1, `PARTIAL_REFUND_TX_COUNT_${txs.length}`);
  assert(
    txs[0].amountCents === partialAmountCents,
    `PARTIAL_REFUND_LEDGER_AMOUNT_${txs[0].amountCents}_EXPECTED_${partialAmountCents}`,
  );
  assert(
    (refundedAgg._sum.amountCents ?? 0) === partialAmountCents,
    `PARTIAL_REFUND_AGG_${refundedAgg._sum.amountCents ?? 0}_EXPECTED_${partialAmountCents}`,
  );

  assert(secondDbBooking, 'SECOND_DB_BOOKING_NOT_FOUND_AFTER_CROSS_KEY_CHECK');
  assert(
    secondDbBooking.status === 'CONFIRMED',
    `SECOND_DB_BOOKING_STATUS_${secondDbBooking?.status}`,
  );
  assert(
    secondDbBooking.paymentStatus === 'PAID',
    `SECOND_DB_BOOKING_PAYMENT_STATUS_${secondDbBooking?.paymentStatus}`,
  );
  assert(
    secondBookingTxs.length === 0,
    `SECOND_BOOKING_PARTIAL_REFUND_TX_COUNT_${secondBookingTxs.length}`,
  );

  console.log(
    JSON.stringify(
      {
        bookingId: booking.id,
        secondBookingId: secondBooking.id,
        status: dbBooking.status,
        paymentStatus: dbBooking.paymentStatus,
        partialRefundAmountCents: partialAmountCents,
        remainingRefundableCents: totalAmountCents - partialAmountCents,
        ledgerRow: txs[0],
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_PARTIAL_REFUND_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
