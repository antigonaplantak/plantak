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
