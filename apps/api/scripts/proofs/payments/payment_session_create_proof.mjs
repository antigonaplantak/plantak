import {
  prisma,
  BUSINESS_ID,
  assert,
  http,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2027-01-18';

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  const key = `payment-session-proof-${Date.now()}`;

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
    `CREATE_PAYMENT_STATUS_${booking?.paymentStatus}`,
  );
  assert(
    booking?.depositPercentSnapshot === 30,
    `CREATE_DEPOSIT_PERCENT_${booking?.depositPercentSnapshot}`,
  );
  assert(
    booking?.depositResolvedFromScope === 'STAFF_SERVICE_OVERRIDE',
    `CREATE_DEPOSIT_SCOPE_${booking?.depositResolvedFromScope}`,
  );
  assert(
    (booking?.amountDepositCentsSnapshot ?? 0) === 1500,
    `CREATE_DEPOSIT_AMOUNT_${booking?.amountDepositCentsSnapshot}`,
  );
  assert(
    (booking?.amountRemainingCentsSnapshot ?? 0) === 3500,
    `CREATE_REMAINING_AMOUNT_${booking?.amountRemainingCentsSnapshot}`,
  );

  const first = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session`,
      returnUrl: 'https://example.test/return',
      cancelUrl: 'https://example.test/cancel',
    },
  });

  assert(first?.id, 'SESSION_CREATE_FAILED');
  assert(
    first?.bookingId === booking.id,
    `SESSION_BOOKING_ID_${first?.bookingId}`,
  );
  assert(
    first?.businessId === BUSINESS_ID,
    `SESSION_BUSINESS_ID_${first?.businessId}`,
  );
  assert(first?.provider === 'stub', `SESSION_PROVIDER_${first?.provider}`);
  assert(first?.status === 'OPEN', `SESSION_STATUS_${first?.status}`);
  assert(
    first?.amountCents === booking.amountDepositCentsSnapshot,
    `SESSION_AMOUNT_${first?.amountCents}_EXPECTED_${booking.amountDepositCentsSnapshot}`,
  );

  const replaySameKey = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session`,
      returnUrl: 'https://example.test/return',
      cancelUrl: 'https://example.test/cancel',
    },
  });

  assert(
    replaySameKey?.id === first.id,
    `REPLAY_SESSION_ID_${replaySameKey?.id}_EXPECTED_${first.id}`,
  );

  const reuseOpen = await http(`/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session-other`,
    },
  });

  assert(
    reuseOpen?.id === first.id,
    `OPEN_REUSE_SESSION_ID_${reuseOpen?.id}_EXPECTED_${first.id}`,
  );

  const dbSession = await prisma.paymentSession.findUnique({
    where: { id: first.id },
    select: {
      id: true,
      bookingId: true,
      businessId: true,
      provider: true,
      status: true,
      amountCents: true,
      currency: true,
      idempotencyKey: true,
      expiresAt: true,
    },
  });

  assert(dbSession, 'DB_SESSION_NOT_FOUND');
  assert(
    dbSession.bookingId === booking.id,
    `DB_SESSION_BOOKING_${dbSession?.bookingId}`,
  );
  assert(
    dbSession.businessId === BUSINESS_ID,
    `DB_SESSION_BUSINESS_${dbSession?.businessId}`,
  );
  assert(dbSession.provider === 'stub', `DB_SESSION_PROVIDER_${dbSession?.provider}`);
  assert(dbSession.status === 'OPEN', `DB_SESSION_STATUS_${dbSession?.status}`);
  assert(
    dbSession.amountCents === booking.amountDepositCentsSnapshot,
    `DB_SESSION_AMOUNT_${dbSession?.amountCents}_EXPECTED_${booking.amountDepositCentsSnapshot}`,
  );
  assert(
    dbSession.idempotencyKey === `${key}-session`,
    `DB_SESSION_IDEMPOTENCY_${dbSession?.idempotencyKey}`,
  );

  console.log(
    JSON.stringify(
      {
        bookingId: booking.id,
        sessionId: first.id,
        amountCents: dbSession.amountCents,
        status: dbSession.status,
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_SESSION_CREATE_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
