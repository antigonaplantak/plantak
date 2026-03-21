import crypto from 'crypto';
import {
  prisma,
  API,
  BUSINESS_ID,
  assert,
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
  PAYMENT_PROVIDER_NAME,
  PAYMENT_PROVIDER_EVENT,
} from './_payment_proof_fixture.mjs';

const DATE_YMD = process.env.DATE_YMD ?? '2026-04-23';
const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev_payment_webhook_secret';

function sign(rawBody) {
  return crypto
    .createHmac('sha256', PAYMENT_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
}

async function postWebhook({
  eventId,
  eventType,
  payload,
  signature,
  provider = PAYMENT_PROVIDER_NAME,
}) {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(`${API}/payments/provider/webhook`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-payment-provider': provider,
      'x-payment-event-id': eventId,
      'x-payment-event-type': eventType,
      'x-payment-signature': signature ?? sign(rawBody),
    },
    body: rawBody,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { status: res.status, text, json };
}

async function createPendingBookingAndSession({
  token,
  userId,
  serviceId,
  staffId,
  key,
}) {
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd: DATE_YMD,
  });

  const bookingRes = await fetch(`${API}/bookings`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt: slot.start,
      idempotencyKey: `${key}-create`,
    }),
  });

  const bookingText = await bookingRes.text();
  const booking = bookingText ? JSON.parse(bookingText) : null;
  assert(
    bookingRes.status === 201,
    `BOOKING_HTTP_${bookingRes.status}_${bookingText}`,
  );
  assert(booking?.id, 'BOOKING_CREATE_FAILED');
  assert(
    booking?.paymentStatus === 'DEPOSIT_PENDING',
    `BOOKING_PAYMENT_STATUS_${booking?.paymentStatus}`,
  );

  const sessionRes = await fetch(`${API}/payments/bookings/${booking.id}/session`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      businessId: BUSINESS_ID,
      idempotencyKey: `${key}-session`,
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    }),
  });

  const sessionText = await sessionRes.text();
  const session = sessionText ? JSON.parse(sessionText) : null;
  assert(
    sessionRes.status === 201,
    `SESSION_HTTP_${sessionRes.status}_${sessionText}`,
  );
  assert(session?.id, 'SESSION_CREATE_FAILED');

  const providerSessionRef = `${key}-provider-ref`;
  const dbSession = await prisma.paymentSession.update({
    where: { id: session.id },
    data: { providerSessionRef },
    select: {
      id: true,
      bookingId: true,
      businessId: true,
      status: true,
      providerSessionRef: true,
    },
  });

  return {
    booking,
    session: dbSession,
    providerSessionRef,
  };
}

async function readSession(sessionId) {
  return prisma.paymentSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      authorizedAt: true,
      consumedAt: true,
      cancelledAt: true,
      failedAt: true,
      failureReason: true,
      providerSessionRef: true,
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
    },
  });
}

async function countTx(bookingId, transactionType) {
  return prisma.paymentTransaction.count({
    where: {
      bookingId,
      transactionType,
    },
  });
}

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const key = `payment-auth-capture-proof-${Date.now()}`;

  // Flow A: authorize -> capture
  const paid = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-paid`,
  });

  const paidPayload = {
    businessId: BUSINESS_ID,
    bookingId: paid.booking.id,
    providerSessionRef: paid.providerSessionRef,
  };

  const authEventId = `${key}-authorized`;
  const authRes = await postWebhook({
    eventId: authEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: paidPayload,
  });
  assert(
    authRes.status === 200,
    `AUTHORIZED_STATUS_${authRes.status}_${authRes.text}`,
  );
  assert(
    authRes.json?.processed === true,
    `AUTHORIZED_NOT_PROCESSED_${JSON.stringify(authRes.json)}`,
  );

  const authSession = await readSession(paid.session.id);
  const authBooking = await readBooking(paid.booking.id);
  const authCount = await countTx(paid.booking.id, 'DEPOSIT_AUTHORIZATION');

  assert(
    authSession?.status === 'AUTHORIZED',
    `AUTHORIZED_SESSION_STATUS_${authSession?.status}`,
  );
  assert(Boolean(authSession?.authorizedAt), 'AUTHORIZED_AT_MISSING');
  assert(authBooking?.status === 'PENDING', `AUTHORIZED_BOOKING_STATUS_${authBooking?.status}`);
  assert(
    authBooking?.paymentStatus === 'DEPOSIT_PENDING',
    `AUTHORIZED_BOOKING_PAYMENT_STATUS_${authBooking?.paymentStatus}`,
  );
  assert(authCount === 1, `AUTHORIZED_TX_COUNT_${authCount}`);

  const authDuplicate = await postWebhook({
    eventId: authEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: paidPayload,
  });
  assert(
    authDuplicate.status === 200,
    `AUTHORIZED_DUPLICATE_STATUS_${authDuplicate.status}_${authDuplicate.text}`,
  );
  assert(
    authDuplicate.json?.duplicate === true,
    `AUTHORIZED_DUPLICATE_NOT_TRUE_${JSON.stringify(authDuplicate.json)}`,
  );
  const authCountAfterDuplicate = await countTx(
    paid.booking.id,
    'DEPOSIT_AUTHORIZATION',
  );
  assert(
    authCountAfterDuplicate === 1,
    `AUTHORIZED_DUPLICATE_TX_COUNT_${authCountAfterDuplicate}`,
  );

  const paidEventId = `${key}-paid`;
  const paidRes = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(
    paidRes.status === 200,
    `PAID_STATUS_${paidRes.status}_${paidRes.text}`,
  );
  assert(
    paidRes.json?.processed === true,
    `PAID_NOT_PROCESSED_${JSON.stringify(paidRes.json)}`,
  );

  const paidSession = await readSession(paid.session.id);
  const paidBookingDb = await readBooking(paid.booking.id);
  const captureCount = await countTx(paid.booking.id, 'DEPOSIT_CAPTURE');

  assert(
    paidSession?.status === 'CONSUMED',
    `PAID_SESSION_STATUS_${paidSession?.status}`,
  );
  assert(Boolean(paidSession?.consumedAt), 'PAID_CONSUMED_AT_MISSING');
  assert(
    paidBookingDb?.status === 'CONFIRMED',
    `PAID_BOOKING_STATUS_${paidBookingDb?.status}`,
  );
  assert(
    paidBookingDb?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_BOOKING_PAYMENT_STATUS_${paidBookingDb?.paymentStatus}`,
  );
  assert(captureCount === 1, `CAPTURE_TX_COUNT_${captureCount}`);

  // Flow B: authorize -> void
  const voided = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-voided`,
  });

  const voidPayload = {
    businessId: BUSINESS_ID,
    bookingId: voided.booking.id,
    providerSessionRef: voided.providerSessionRef,
  };

  const voidAuthEventId = `${key}-void-authorized`;
  const voidAuthRes = await postWebhook({
    eventId: voidAuthEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: voidPayload,
  });
  assert(
    voidAuthRes.status === 200,
    `VOID_AUTH_STATUS_${voidAuthRes.status}_${voidAuthRes.text}`,
  );
  assert(
    voidAuthRes.json?.processed === true,
    `VOID_AUTH_NOT_PROCESSED_${JSON.stringify(voidAuthRes.json)}`,
  );

  const voidEventId = `${key}-voided`;
  const voidRes = await postWebhook({
    eventId: voidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_VOIDED,
    payload: voidPayload,
  });
  assert(
    voidRes.status === 200,
    `VOID_STATUS_${voidRes.status}_${voidRes.text}`,
  );
  assert(
    voidRes.json?.processed === true,
    `VOID_NOT_PROCESSED_${JSON.stringify(voidRes.json)}`,
  );

  const voidSession = await readSession(voided.session.id);
  const voidBooking = await readBooking(voided.booking.id);
  const voidCount = await countTx(voided.booking.id, 'DEPOSIT_VOID');

  assert(
    voidSession?.status === 'CANCELLED',
    `VOID_SESSION_STATUS_${voidSession?.status}`,
  );
  assert(Boolean(voidSession?.cancelledAt), 'VOID_CANCELLED_AT_MISSING');
  assert(voidBooking?.status === 'PENDING', `VOID_BOOKING_STATUS_${voidBooking?.status}`);
  assert(
    voidBooking?.paymentStatus === 'DEPOSIT_PENDING',
    `VOID_BOOKING_PAYMENT_STATUS_${voidBooking?.paymentStatus}`,
  );
  assert(voidCount === 1, `VOID_TX_COUNT_${voidCount}`);

  // Flow C: capture without authorize -> reject
  const invalid = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-invalid`,
  });

  const invalidPayload = {
    businessId: BUSINESS_ID,
    bookingId: invalid.booking.id,
    providerSessionRef: invalid.providerSessionRef,
  };

  const invalidPaidEventId = `${key}-invalid-paid`;
  const invalidPaidRes = await postWebhook({
    eventId: invalidPaidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: invalidPayload,
  });
  assert(
    invalidPaidRes.status === 200,
    `INVALID_PAID_STATUS_${invalidPaidRes.status}_${invalidPaidRes.text}`,
  );
  assert(
    invalidPaidRes.json?.rejected === true,
    `INVALID_PAID_NOT_REJECTED_${JSON.stringify(invalidPaidRes.json)}`,
  );

  const invalidSession = await readSession(invalid.session.id);
  const invalidBooking = await readBooking(invalid.booking.id);
  const invalidCaptureCount = await countTx(invalid.booking.id, 'DEPOSIT_CAPTURE');

  assert(
    invalidSession?.status === 'OPEN',
    `INVALID_SESSION_STATUS_${invalidSession?.status}`,
  );
  assert(
    invalidBooking?.status === 'PENDING',
    `INVALID_BOOKING_STATUS_${invalidBooking?.status}`,
  );
  assert(
    invalidBooking?.paymentStatus === 'DEPOSIT_PENDING',
    `INVALID_BOOKING_PAYMENT_STATUS_${invalidBooking?.paymentStatus}`,
  );
  assert(
    invalidCaptureCount === 0,
    `INVALID_CAPTURE_TX_COUNT_${invalidCaptureCount}`,
  );

  console.log('OK payment_auth_capture_proof');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
