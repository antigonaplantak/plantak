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

async function readProviderEvent(
  providerEventId,
  provider = PAYMENT_PROVIDER_NAME,
) {
  return prisma.paymentProviderEvent.findUnique({
    where: {
      provider_providerEventId: {
        provider,
        providerEventId,
      },
    },
    select: {
      id: true,
      businessId: true,
      bookingId: true,
      eventType: true,
      processedAt: true,
      rejectedAt: true,
      rejectReason: true,
    },
  });
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
      depositExpiresAt: true,
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
  const key = `payment-provider-webhook-proof-${Date.now()}`;

  const badSig = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-bad-signature`,
  });

  const badSigPayload = {
    businessId: BUSINESS_ID,
    bookingId: badSig.booking.id,
    providerSessionRef: badSig.providerSessionRef,
  };

  const badSigEventId = `${key}-bad-signature-event`;
  const badSigRes = await postWebhook({
    eventId: badSigEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: badSigPayload,
    signature: 'bad-signature',
  });
  assert(
    badSigRes.status === 401,
    `BAD_SIGNATURE_STATUS_${badSigRes.status}_${badSigRes.text}`,
  );
  assert(
    !(await readProviderEvent(badSigEventId)),
    'BAD_SIGNATURE_EVENT_SHOULD_NOT_EXIST',
  );

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

  const authorizedEventId = `${key}-deposit-authorized`;
  const authorizedRes = await postWebhook({
    eventId: authorizedEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: paidPayload,
  });
  assert(
    authorizedRes.status === 200,
    `AUTHORIZED_WEBHOOK_STATUS_${authorizedRes.status}_${authorizedRes.text}`,
  );
  assert(
    authorizedRes.json?.processed === true,
    `AUTHORIZED_WEBHOOK_NOT_PROCESSED_${JSON.stringify(authorizedRes.json)}`,
  );

  const authorizedSession = await readSession(paid.session.id);
  const authorizedEvent = await readProviderEvent(authorizedEventId);
  const authorizedTxCount = await countTx(
    paid.booking.id,
    'DEPOSIT_AUTHORIZATION',
  );

  assert(
    authorizedSession?.status === 'AUTHORIZED',
    `AUTHORIZED_SESSION_STATUS_${authorizedSession?.status}`,
  );
  assert(
    Boolean(authorizedSession?.authorizedAt),
    'AUTHORIZED_SESSION_AUTHORIZED_AT_MISSING',
  );
  assert(Boolean(authorizedEvent?.processedAt), 'AUTHORIZED_EVENT_NOT_PROCESSED');
  assert(!authorizedEvent?.rejectedAt, 'AUTHORIZED_EVENT_SHOULD_NOT_BE_REJECTED');
  assert(authorizedTxCount === 1, `AUTHORIZED_TX_COUNT_${authorizedTxCount}`);

  const paidEventId = `${key}-deposit-paid`;
  const paidRes = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(
    paidRes.status === 200,
    `PAID_WEBHOOK_STATUS_${paidRes.status}_${paidRes.text}`,
  );
  assert(
    paidRes.json?.processed === true,
    `PAID_WEBHOOK_NOT_PROCESSED_${JSON.stringify(paidRes.json)}`,
  );

  const paidBooking = await readBooking(paid.booking.id);
  const paidSession = await readSession(paid.session.id);
  const paidEvent = await readProviderEvent(paidEventId);
  const depositCaptureCount = await countTx(paid.booking.id, 'DEPOSIT_CAPTURE');

  assert(
    paidBooking?.status === 'CONFIRMED',
    `PAID_BOOKING_STATUS_${paidBooking?.status}`,
  );
  assert(
    paidBooking?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_BOOKING_PAYMENT_STATUS_${paidBooking?.paymentStatus}`,
  );
  assert(
    paidSession?.status === 'CONSUMED',
    `PAID_SESSION_STATUS_${paidSession?.status}`,
  );
  assert(Boolean(paidSession?.consumedAt), 'PAID_SESSION_CONSUMED_AT_MISSING');
  assert(Boolean(paidEvent?.processedAt), 'PAID_EVENT_PROCESSED_AT_MISSING');
  assert(!paidEvent?.rejectedAt, 'PAID_EVENT_SHOULD_NOT_BE_REJECTED');
  assert(depositCaptureCount === 1, `DEPOSIT_CAPTURE_COUNT_${depositCaptureCount}`);

  const duplicate = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(
    duplicate.status === 200,
    `DUPLICATE_STATUS_${duplicate.status}_${duplicate.text}`,
  );
  assert(
    duplicate.json?.duplicate === true,
    `DUPLICATE_NOT_TRUE_${JSON.stringify(duplicate.json)}`,
  );

  const duplicateCaptureCount = await countTx(
    paid.booking.id,
    'DEPOSIT_CAPTURE',
  );
  assert(
    duplicateCaptureCount === 1,
    `DUPLICATE_CAPTURE_COUNT_${duplicateCaptureCount}`,
  );

  const closedSessionEventId = `${key}-closed-session-paid`;
  const closedSessionRes = await postWebhook({
    eventId: closedSessionEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(
    closedSessionRes.status === 200,
    `CLOSED_SESSION_STATUS_${closedSessionRes.status}_${closedSessionRes.text}`,
  );
  assert(
    closedSessionRes.json?.rejected === true,
    `CLOSED_SESSION_NOT_REJECTED_${JSON.stringify(closedSessionRes.json)}`,
  );
  assert(
    String(closedSessionRes.json?.reason || '').includes('CONSUMED'),
    `CLOSED_SESSION_REASON_${closedSessionRes.json?.reason}`,
  );

  const wrongBusiness = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-wrong-business`,
  });

  const wrongBusinessEventId = `${key}-wrong-business-event`;
  const wrongBusinessRes = await postWebhook({
    eventId: wrongBusinessEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED,
    payload: {
      businessId: 'wrong-business',
      bookingId: wrongBusiness.booking.id,
      providerSessionRef: wrongBusiness.providerSessionRef,
    },
  });
  assert(
    wrongBusinessRes.status === 200,
    `WRONG_BUSINESS_STATUS_${wrongBusinessRes.status}_${wrongBusinessRes.text}`,
  );
  assert(
    wrongBusinessRes.json?.rejected === true,
    `WRONG_BUSINESS_NOT_REJECTED_${JSON.stringify(wrongBusinessRes.json)}`,
  );
  assert(
    String(wrongBusinessRes.json?.reason || '').includes('business mismatch'),
    `WRONG_BUSINESS_REASON_${wrongBusinessRes.json?.reason}`,
  );

  const wrongBooking = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-wrong-booking`,
  });

  const wrongBookingEventId = `${key}-wrong-booking-event`;
  const wrongBookingRes = await postWebhook({
    eventId: wrongBookingEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: 'wrong-booking-id',
      providerSessionRef: wrongBooking.providerSessionRef,
    },
  });
  assert(
    wrongBookingRes.status === 200,
    `WRONG_BOOKING_STATUS_${wrongBookingRes.status}_${wrongBookingRes.text}`,
  );
  assert(
    wrongBookingRes.json?.rejected === true,
    `WRONG_BOOKING_NOT_REJECTED_${JSON.stringify(wrongBookingRes.json)}`,
  );
  assert(
    String(wrongBookingRes.json?.reason || '').includes('booking mismatch'),
    `WRONG_BOOKING_REASON_${wrongBookingRes.json?.reason}`,
  );

  const missingRefEventId = `${key}-missing-ref-event`;
  const missingRefRes = await postWebhook({
    eventId: missingRefEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: wrongBooking.booking.id,
    },
  });
  assert(
    missingRefRes.status === 200,
    `MISSING_REF_STATUS_${missingRefRes.status}_${missingRefRes.text}`,
  );
  assert(
    missingRefRes.json?.rejected === true,
    `MISSING_REF_NOT_REJECTED_${JSON.stringify(missingRefRes.json)}`,
  );
  assert(
    String(missingRefRes.json?.reason || '').includes('providerSessionRef is required'),
    `MISSING_REF_REASON_${missingRefRes.json?.reason}`,
  );

  const unsupported = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-unsupported`,
  });

  const unsupportedEventId = `${key}-unsupported-event`;
  const unsupportedRes = await postWebhook({
    eventId: unsupportedEventId,
    eventType: 'deposit.unsupported',
    payload: {
      businessId: BUSINESS_ID,
      bookingId: unsupported.booking.id,
      providerSessionRef: unsupported.providerSessionRef,
    },
  });
  assert(
    unsupportedRes.status === 200,
    `UNSUPPORTED_STATUS_${unsupportedRes.status}_${unsupportedRes.text}`,
  );
  assert(
    unsupportedRes.json?.rejected === true,
    `UNSUPPORTED_NOT_REJECTED_${JSON.stringify(unsupportedRes.json)}`,
  );
  assert(
    String(unsupportedRes.json?.reason || '').includes('Unsupported event type'),
    `UNSUPPORTED_REASON_${unsupportedRes.json?.reason}`,
  );

  const expired = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-expired`,
  });

  const expiredAt = new Date(Date.now() - 60_000);

  await prisma.booking.update({
    where: { id: expired.booking.id },
    data: {
      depositExpiresAt: expiredAt,
    },
  });

  await prisma.paymentSession.update({
    where: { id: expired.session.id },
    data: {
      expiresAt: expiredAt,
    },
  });

  const expiredEventId = `${key}-expired-event`;
  const expiredRes = await postWebhook({
    eventId: expiredEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: expired.booking.id,
      providerSessionRef: expired.providerSessionRef,
    },
  });
  assert(
    expiredRes.status === 200,
    `EXPIRED_STATUS_${expiredRes.status}_${expiredRes.text}`,
  );
  assert(
    expiredRes.json?.processed === true,
    `EXPIRED_NOT_PROCESSED_${JSON.stringify(expiredRes.json)}`,
  );

  const expiredSession = await readSession(expired.session.id);
  assert(
    expiredSession?.status === 'EXPIRED',
    `EXPIRED_SESSION_STATUS_${expiredSession?.status}`,
  );

  const cancelled = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-cancelled`,
  });

  const cancelledEventId = `${key}-cancelled-event`;
  const cancelledRes = await postWebhook({
    eventId: cancelledEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: cancelled.booking.id,
      providerSessionRef: cancelled.providerSessionRef,
    },
  });
  assert(
    cancelledRes.status === 200,
    `CANCELLED_STATUS_${cancelledRes.status}_${cancelledRes.text}`,
  );
  assert(
    cancelledRes.json?.processed === true,
    `CANCELLED_NOT_PROCESSED_${JSON.stringify(cancelledRes.json)}`,
  );

  const cancelledSession = await readSession(cancelled.session.id);
  assert(
    cancelledSession?.status === 'CANCELLED',
    `CANCELLED_SESSION_STATUS_${cancelledSession?.status}`,
  );
  assert(
    Boolean(cancelledSession?.cancelledAt),
    'CANCELLED_SESSION_CANCELLED_AT_MISSING',
  );

  const failed = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-failed`,
  });

  const failedEventId = `${key}-failed-event`;
  const failedRes = await postWebhook({
    eventId: failedEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: failed.booking.id,
      providerSessionRef: failed.providerSessionRef,
      failureReason: 'Provider marked payment session failed',
    },
  });
  assert(
    failedRes.status === 200,
    `FAILED_STATUS_${failedRes.status}_${failedRes.text}`,
  );
  assert(
    failedRes.json?.processed === true,
    `FAILED_NOT_PROCESSED_${JSON.stringify(failedRes.json)}`,
  );

  const failedSession = await readSession(failed.session.id);
  assert(
    failedSession?.status === 'FAILED',
    `FAILED_SESSION_STATUS_${failedSession?.status}`,
  );
  assert(Boolean(failedSession?.failedAt), 'FAILED_SESSION_FAILED_AT_MISSING');
  assert(
    typeof failedSession?.failureReason === 'string' &&
      failedSession.failureReason.length > 0,
    `FAILED_SESSION_REASON_${failedSession?.failureReason}`,
  );

  console.log('OK payment_provider_webhook_proof');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error.message || error);
  await prisma.$disconnect();
  process.exit(1);
});
