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

  const key = `payment-waive-proof-${Date.now()}`;

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

  const waived = await http(`/bookings/${booking.id}/payment-waive`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-payment-waive`,
    },
  });

  assert(waived?.status === 'CONFIRMED', `UNEXPECTED_STATUS_${waived?.status}`);
  assert(
    waived?.paymentStatus === 'DEPOSIT_WAIVED',
    `UNEXPECTED_PAYMENT_STATUS_${waived?.paymentStatus}`,
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
      transactionType: 'DEPOSIT_WAIVE',
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

  assert(dbBooking, 'DB_BOOKING_NOT_FOUND');
  assert(dbBooking?.status === 'CONFIRMED', `DB_STATUS_${dbBooking?.status}`);
  assert(
    dbBooking?.paymentStatus === 'DEPOSIT_WAIVED',
    `DB_PAYMENT_STATUS_${dbBooking?.paymentStatus}`,
  );
  assert(txs.length === 1, `DEPOSIT_WAIVE_TX_COUNT_${txs.length}`);
  assert(
    txs[0].amountCents === (dbBooking.amountDepositCentsSnapshot ?? 0),
    `DEPOSIT_WAIVE_AMOUNT_MISMATCH_${txs[0].amountCents}_EXPECTED_${dbBooking.amountDepositCentsSnapshot ?? 0}`,
  );

  console.log(JSON.stringify({
    bookingId: booking.id,
    paymentStatus: dbBooking.paymentStatus,
    depositAmountCents: dbBooking.amountDepositCentsSnapshot,
    ledgerRow: txs[0],
  }, null, 2));

  console.log('PAYMENT_WAIVE_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
