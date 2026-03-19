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
  assert(bookingRes.status === 201, `BOOKING_HTTP_${bookingRes.status}_${bookingText}`);
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
  assert(sessionRes.status === 201, `SESSION_HTTP_${sessionRes.status}_${sessionText}`);
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

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const key = `payment-provider-webhook-proof-${Date.now()}`;

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

  const badSigEventId = `${key}-bad-signature`;
  const badSig = await postWebhook({
    eventId: badSigEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
    signature: 'bad-signature',
  });
  assert(badSig.status === 401, `BAD_SIGNATURE_STATUS_${badSig.status}_${badSig.text}`);
  assert(!(await readProviderEvent(badSigEventId)), 'BAD_SIGNATURE_EVENT_SHOULD_NOT_EXIST');

  const paidEventId = `${key}-deposit-paid`;
  const paidRes = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(paidRes.status === 200, `PAID_WEBHOOK_STATUS_${paidRes.status}_${paidRes.text}`);
  assert(paidRes.json?.processed === true, `PAID_WEBHOOK_NOT_PROCESSED_${JSON.stringify(paidRes.json)}`);

  const paidBooking = await readBooking(paid.booking.id);
  const paidSession = await readSession(paid.session.id);
  const paidEvent = await readProviderEvent(paidEventId);
  const depositCaptureCount = await prisma.paymentTransaction.count({
    where: {
      bookingId: paid.booking.id,
      transactionType: 'DEPOSIT_CAPTURE',
    },
  });

  assert(paidBooking?.status === 'CONFIRMED', `PAID_BOOKING_STATUS_${paidBooking?.status}`);
  assert(
    paidBooking?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_BOOKING_PAYMENT_STATUS_${paidBooking?.paymentStatus}`,
  );
  assert(paidSession?.status === 'CONSUMED', `PAID_SESSION_STATUS_${paidSession?.status}`);
  assert(Boolean(paidSession?.consumedAt), 'PAID_SESSION_CONSUMED_AT_MISSING');
  assert(Boolean(paidEvent?.processedAt), 'PAID_EVENT_PROCESSED_AT_MISSING');
  assert(!paidEvent?.rejectedAt, 'PAID_EVENT_SHOULD_NOT_BE_REJECTED');
  assert(depositCaptureCount === 1, `DEPOSIT_CAPTURE_COUNT_${depositCaptureCount}`);

  const duplicate = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: paidPayload,
  });
  assert(duplicate.status === 200, `DUPLICATE_STATUS_${duplicate.status}_${duplicate.text}`);
  assert(duplicate.json?.duplicate === true, `DUPLICATE_NOT_TRUE_${JSON.stringify(duplicate.json)}`);

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
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: 'wrong-business',
      bookingId: wrongBusiness.booking.id,
      providerSessionRef: wrongBusiness.providerSessionRef,
    },
  });
  const wrongBusinessEvent = await readProviderEvent(wrongBusinessEventId);
  const wrongBusinessSession = await readSession(wrongBusiness.session.id);
  assert(wrongBusinessRes.status === 200, `WRONG_BUSINESS_STATUS_${wrongBusinessRes.status}_${wrongBusinessRes.text}`);
  assert(wrongBusinessRes.json?.rejected === true, 'WRONG_BUSINESS_NOT_REJECTED');
  assert(Boolean(wrongBusinessEvent?.rejectedAt), 'WRONG_BUSINESS_REJECTED_AT_MISSING');
  assert(
    String(wrongBusinessEvent?.rejectReason ?? '').includes('business mismatch'),
    `WRONG_BUSINESS_REASON_${wrongBusinessEvent?.rejectReason}`,
  );
  assert(wrongBusinessSession?.status === 'OPEN', `WRONG_BUSINESS_SESSION_STATUS_${wrongBusinessSession?.status}`);

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
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: 'wrong-booking',
      providerSessionRef: wrongBooking.providerSessionRef,
    },
  });
  const wrongBookingEvent = await readProviderEvent(wrongBookingEventId);
  assert(wrongBookingRes.status === 200, `WRONG_BOOKING_STATUS_${wrongBookingRes.status}_${wrongBookingRes.text}`);
  assert(wrongBookingRes.json?.rejected === true, 'WRONG_BOOKING_NOT_REJECTED');
  assert(Boolean(wrongBookingEvent?.rejectedAt), 'WRONG_BOOKING_REJECTED_AT_MISSING');
  assert(
    String(wrongBookingEvent?.rejectReason ?? '').includes('booking mismatch'),
    `WRONG_BOOKING_REASON_${wrongBookingEvent?.rejectReason}`,
  );

  const missingSessionEventId = `${key}-missing-session`;
  const missingSessionRes = await postWebhook({
    eventId: missingSessionEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: paid.booking.id,
      providerSessionRef: `${key}-missing-ref`,
    },
  });
  const missingSessionEvent = await readProviderEvent(missingSessionEventId);
  assert(missingSessionRes.status === 200, `MISSING_SESSION_STATUS_${missingSessionRes.status}_${missingSessionRes.text}`);
  assert(missingSessionRes.json?.rejected === true, 'MISSING_SESSION_NOT_REJECTED');
  assert(Boolean(missingSessionEvent?.rejectedAt), 'MISSING_SESSION_REJECTED_AT_MISSING');
  assert(
    String(missingSessionEvent?.rejectReason ?? '').toLowerCase().includes('not found'),
    `MISSING_SESSION_REASON_${missingSessionEvent?.rejectReason}`,
  );

  const closedSessionEventId = `${key}-closed-session`;
  const closedSessionRes = await postWebhook({
    eventId: closedSessionEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: paid.booking.id,
      providerSessionRef: paid.providerSessionRef,
    },
  });
  const closedSessionEvent = await readProviderEvent(closedSessionEventId);
  assert(closedSessionRes.status === 200, `CLOSED_SESSION_STATUS_${closedSessionRes.status}_${closedSessionRes.text}`);
  assert(closedSessionRes.json?.rejected === true, 'CLOSED_SESSION_NOT_REJECTED');
  assert(Boolean(closedSessionEvent?.rejectedAt), 'CLOSED_SESSION_REJECTED_AT_MISSING');
  assert(
    String(closedSessionEvent?.rejectReason ?? '').includes('not open'),
    `CLOSED_SESSION_REASON_${closedSessionEvent?.rejectReason}`,
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
  const unsupportedEvent = await readProviderEvent(unsupportedEventId);
  const unsupportedSession = await readSession(unsupported.session.id);
  assert(unsupportedRes.status === 200, `UNSUPPORTED_STATUS_${unsupportedRes.status}_${unsupportedRes.text}`);
  assert(unsupportedRes.json?.rejected === true, 'UNSUPPORTED_NOT_REJECTED');
  assert(Boolean(unsupportedEvent?.rejectedAt), 'UNSUPPORTED_REJECTED_AT_MISSING');
  assert(
    String(unsupportedEvent?.rejectReason ?? '').includes('Unsupported event type'),
    `UNSUPPORTED_REASON_${unsupportedEvent?.rejectReason}`,
  );
  assert(unsupportedSession?.status === 'OPEN', `UNSUPPORTED_SESSION_STATUS_${unsupportedSession?.status}`);

  const invalidProvider = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-invalid-provider`,
  });
  const invalidProviderValue = 'invalid-provider';
  const invalidProviderEventId = `${key}-invalid-provider-event`;
  const invalidProviderRes = await postWebhook({
    eventId: invalidProviderEventId,
    provider: invalidProviderValue,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: invalidProvider.booking.id,
      providerSessionRef: invalidProvider.providerSessionRef,
    },
  });
  const invalidProviderEvent = await readProviderEvent(
    invalidProviderEventId,
    invalidProviderValue,
  );
  const invalidProviderSession = await readSession(invalidProvider.session.id);
  assert(
    invalidProviderRes.status === 200,
    `INVALID_PROVIDER_STATUS_${invalidProviderRes.status}_${invalidProviderRes.text}`,
  );
  assert(
    invalidProviderRes.json?.rejected === true,
    'INVALID_PROVIDER_NOT_REJECTED',
  );
  assert(
    Boolean(invalidProviderEvent?.rejectedAt),
    'INVALID_PROVIDER_REJECTED_AT_MISSING',
  );
  assert(
    String(invalidProviderEvent?.rejectReason ?? '').includes(
      'Unsupported provider',
    ),
    `INVALID_PROVIDER_REASON_${invalidProviderEvent?.rejectReason}`,
  );
  assert(
    invalidProviderSession?.status === 'OPEN',
    `INVALID_PROVIDER_SESSION_STATUS_${invalidProviderSession?.status}`,
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
  const cancelledBooking = await readBooking(cancelled.booking.id);
  const cancelledSession = await readSession(cancelled.session.id);
  const cancelledEvent = await readProviderEvent(cancelledEventId);
  assert(cancelledRes.status === 200, `CANCELLED_STATUS_${cancelledRes.status}_${cancelledRes.text}`);
  assert(cancelledRes.json?.processed === true, 'CANCELLED_NOT_PROCESSED');
  assert(cancelledBooking?.paymentStatus === 'DEPOSIT_PENDING', `CANCELLED_BOOKING_PAYMENT_STATUS_${cancelledBooking?.paymentStatus}`);
  assert(cancelledSession?.status === 'CANCELLED', `CANCELLED_SESSION_STATUS_${cancelledSession?.status}`);
  assert(Boolean(cancelledSession?.cancelledAt), 'CANCELLED_AT_MISSING');
  assert(Boolean(cancelledEvent?.processedAt), 'CANCELLED_EVENT_PROCESSED_AT_MISSING');

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
      reason: 'declined by provider',
    },
  });
  const failedBooking = await readBooking(failed.booking.id);
  const failedSession = await readSession(failed.session.id);
  const failedEvent = await readProviderEvent(failedEventId);
  assert(failedRes.status === 200, `FAILED_STATUS_${failedRes.status}_${failedRes.text}`);
  assert(failedRes.json?.processed === true, 'FAILED_NOT_PROCESSED');
  assert(failedBooking?.paymentStatus === 'DEPOSIT_PENDING', `FAILED_BOOKING_PAYMENT_STATUS_${failedBooking?.paymentStatus}`);
  assert(failedSession?.status === 'FAILED', `FAILED_SESSION_STATUS_${failedSession?.status}`);
  assert(Boolean(failedSession?.failedAt), 'FAILED_AT_MISSING');
  assert(
    String(failedSession?.failureReason ?? '').includes('declined'),
    `FAILED_REASON_${failedSession?.failureReason}`,
  );
  assert(Boolean(failedEvent?.processedAt), 'FAILED_EVENT_PROCESSED_AT_MISSING');

  const expired = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-expired`,
  });
  await prisma.booking.update({
    where: { id: expired.booking.id },
    data: { depositExpiresAt: new Date(Date.now() - 60_000) },
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
  const expiredBooking = await readBooking(expired.booking.id);
  const expiredSession = await readSession(expired.session.id);
  const expiredEvent = await readProviderEvent(expiredEventId);
  assert(expiredRes.status === 200, `EXPIRED_STATUS_${expiredRes.status}_${expiredRes.text}`);
  assert(expiredRes.json?.processed === true, 'EXPIRED_NOT_PROCESSED');
  assert(expiredBooking?.status === 'CANCELLED', `EXPIRED_BOOKING_STATUS_${expiredBooking?.status}`);
  assert(expiredBooking?.paymentStatus === 'NONE', `EXPIRED_BOOKING_PAYMENT_STATUS_${expiredBooking?.paymentStatus}`);
  assert(expiredSession?.status === 'EXPIRED', `EXPIRED_SESSION_STATUS_${expiredSession?.status}`);
  assert(Boolean(expiredEvent?.processedAt), 'EXPIRED_EVENT_PROCESSED_AT_MISSING');

  console.log(
    JSON.stringify(
      {
        paidBookingId: paid.booking.id,
        paidSessionStatus: paidSession?.status,
        cancelledSessionStatus: cancelledSession?.status,
        failedSessionStatus: failedSession?.status,
        expiredSessionStatus: expiredSession?.status,
        duplicateHandled: duplicate.json?.duplicate === true,
      },
      null,
      2,
    ),
  );

  console.log('PAYMENT_PROVIDER_WEBHOOK_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
