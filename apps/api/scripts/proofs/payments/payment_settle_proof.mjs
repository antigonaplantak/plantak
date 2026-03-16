import {
  prisma,
  BUSINESS_ID,
  assert,
  http,
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

  const key = `payment-settle-proof-${Date.now()}`;

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

  const beforeSettle = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      paymentStatus: true,
      amountRemainingCentsSnapshot: true,
      amountDepositCentsSnapshot: true,
    },
  });

  assert(beforeSettle, 'DB_BOOKING_NOT_FOUND_BEFORE_SETTLE');
  assert(
    beforeSettle.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `DB_PAYMENT_STATUS_BEFORE_SETTLE_${beforeSettle?.paymentStatus}`,
  );
  assert(
    (beforeSettle.amountRemainingCentsSnapshot ?? 0) > 0,
    `NO_REMAINING_AMOUNT_${beforeSettle.amountRemainingCentsSnapshot ?? 0}`,
  );

  const settled = await http(`/bookings/${booking.id}/payment-settle`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-payment-settle`,
    },
  });

  assert(settled?.status === 'CONFIRMED', `SETTLE_UNEXPECTED_STATUS_${settled?.status}`);
  assert(
    settled?.paymentStatus === 'PAID',
    `SETTLE_UNEXPECTED_PAYMENT_STATUS_${settled?.paymentStatus}`,
  );

  const dbBooking = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: {
      id: true,
      paymentStatus: true,
      amountDepositCentsSnapshot: true,
      amountRemainingCentsSnapshot: true,
    },
  });

  const txs = await prisma.paymentTransaction.findMany({
    where: {
      bookingId: booking.id,
      transactionType: 'FINAL_SETTLEMENT',
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

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND_AFTER_SETTLE');
  assert(dbBooking.paymentStatus === 'PAID', `DB_PAYMENT_STATUS_${dbBooking?.paymentStatus}`);
  assert(txs.length === 1, `FINAL_SETTLEMENT_TX_COUNT_${txs.length}`);
  assert(
    txs[0].amountCents === (dbBooking.amountRemainingCentsSnapshot ?? 0),
    `FINAL_SETTLEMENT_AMOUNT_MISMATCH_${txs[0].amountCents}_EXPECTED_${dbBooking.amountRemainingCentsSnapshot ?? 0}`,
  );

  console.log(JSON.stringify({
    bookingId: booking.id,
    paymentStatus: dbBooking.paymentStatus,
    depositAmountCents: dbBooking.amountDepositCentsSnapshot,
    remainingAmountCents: dbBooking.amountRemainingCentsSnapshot,
    ledgerRow: txs[0],
  }, null, 2));

  console.log('PAYMENT_SETTLE_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
