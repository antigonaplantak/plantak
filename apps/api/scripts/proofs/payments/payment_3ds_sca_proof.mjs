#!/usr/bin/env node
import crypto from 'crypto';
import { prisma, API, BUSINESS_ID, assert, authOwner, ensureDepositEnabledFixture, getFirstSlot, PAYMENT_PROVIDER_NAME } from './_payment_proof_fixture.mjs';

const DATE_YMD =
  process.env.DATE_YMD ??
  new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev_payment_webhook_secret';

const PAYMENT_PROVIDER_EVENT = Object.freeze({
  DEPOSIT_ACTION_REQUIRED: 'deposit.action_required',
  DEPOSIT_AUTHENTICATION_SUCCEEDED: 'deposit.authentication_succeeded',
  DEPOSIT_AUTHENTICATION_FAILED: 'deposit.authentication_failed',
  DEPOSIT_PAID: 'deposit.paid',
});

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

async function postReconcile(token, body) {
  const res = await fetch(`${API}/payments/provider/reconcile`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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
  dateYmd,
}) {
  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd,
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
      challengeUrl: true,
      actionRequiredAt: true,
      authorizedAt: true,
      consumedAt: true,
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

async function main() {
  const { serviceId, staffId } = await ensureDepositEnabledFixture();
  const { token, userId } = await authOwner();
  const key = `payment-3ds-sca-proof-${Date.now()}`;

  const success = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-success`,
    dateYmd: DATE_YMD,
  });

  const challengeUrl = 'https://example.com/3ds/challenge';
  const actionPayload = {
    businessId: BUSINESS_ID,
    bookingId: success.booking.id,
    providerSessionRef: success.providerSessionRef,
    challengeUrl,
  };

  const actionEventId = `${key}-action-required`;
  const actionRes = await postReconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: success.booking.id,
    provider: PAYMENT_PROVIDER_NAME,
    providerEventId: actionEventId,
    providerSessionRef: success.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_ACTION_REQUIRED,
    payload: actionPayload,
  });
  assert(
    actionRes.status === 200,
    `ACTION_REQUIRED_STATUS_${actionRes.status}_${actionRes.text}`,
  );
  assert(
    actionRes.json?.processed === true,
    `ACTION_REQUIRED_NOT_PROCESSED_${JSON.stringify(actionRes.json)}`,
  );

  const actionSession = await readSession(success.session.id);
  assert(
    actionSession?.status === 'ACTION_REQUIRED',
    `ACTION_REQUIRED_SESSION_STATUS_${actionSession?.status}`,
  );
  assert(
    actionSession?.challengeUrl === challengeUrl,
    `ACTION_REQUIRED_CHALLENGE_URL_${actionSession?.challengeUrl}`,
  );
  assert(
    Boolean(actionSession?.actionRequiredAt),
    'ACTION_REQUIRED_AT_MISSING',
  );

  const actionDuplicate = await postReconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: success.booking.id,
    provider: PAYMENT_PROVIDER_NAME,
    providerEventId: actionEventId,
    providerSessionRef: success.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_ACTION_REQUIRED,
    payload: actionPayload,
  });
  assert(
    actionDuplicate.status === 200,
    `ACTION_DUPLICATE_STATUS_${actionDuplicate.status}_${actionDuplicate.text}`,
  );
  assert(
    actionDuplicate.json?.duplicate === true,
    `ACTION_DUPLICATE_NOT_TRUE_${JSON.stringify(actionDuplicate.json)}`,
  );

  const paidTooEarlyEventId = `${key}-paid-too-early`;
  const paidTooEarlyRes = await postWebhook({
    eventId: paidTooEarlyEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: success.booking.id,
      providerSessionRef: success.providerSessionRef,
    },
  });
  assert(
    paidTooEarlyRes.status === 200,
    `PAID_TOO_EARLY_STATUS_${paidTooEarlyRes.status}_${paidTooEarlyRes.text}`,
  );
  assert(
    paidTooEarlyRes.json?.rejected === true,
    `PAID_TOO_EARLY_NOT_REJECTED_${JSON.stringify(paidTooEarlyRes.json)}`,
  );
  assert(
    String(paidTooEarlyRes.json?.reason || '').includes('ACTION_REQUIRED'),
    `PAID_TOO_EARLY_REASON_${paidTooEarlyRes.json?.reason}`,
  );

  const authSucceededEventId = `${key}-auth-succeeded`;
  const authSucceededRes = await postWebhook({
    eventId: authSucceededEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHENTICATION_SUCCEEDED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: success.booking.id,
      providerSessionRef: success.providerSessionRef,
    },
  });
  assert(
    authSucceededRes.status === 200,
    `AUTH_SUCCEEDED_STATUS_${authSucceededRes.status}_${authSucceededRes.text}`,
  );
  assert(
    authSucceededRes.json?.processed === true,
    `AUTH_SUCCEEDED_NOT_PROCESSED_${JSON.stringify(authSucceededRes.json)}`,
  );

  const authorizedSession = await readSession(success.session.id);
  const authorizationTxCount = await prisma.paymentTransaction.count({
    where: {
      bookingId: success.booking.id,
      transactionType: 'DEPOSIT_AUTHORIZATION',
    },
  });

  assert(
    authorizedSession?.status === 'AUTHORIZED',
    `AUTHORIZED_SESSION_STATUS_${authorizedSession?.status}`,
  );
  assert(
    Boolean(authorizedSession?.authorizedAt),
    'AUTHORIZED_AT_MISSING',
  );
  assert(
    authorizedSession?.challengeUrl === null,
    `AUTHORIZED_CHALLENGE_URL_${authorizedSession?.challengeUrl}`,
  );
  assert(
    authorizationTxCount === 1,
    `AUTHORIZATION_TX_COUNT_${authorizationTxCount}`,
  );

  const paidEventId = `${key}-paid`;
  const paidRes = await postWebhook({
    eventId: paidEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: success.booking.id,
      providerSessionRef: success.providerSessionRef,
    },
  });
  assert(
    paidRes.status === 200,
    `PAID_STATUS_${paidRes.status}_${paidRes.text}`,
  );
  assert(
    paidRes.json?.processed === true,
    `PAID_NOT_PROCESSED_${JSON.stringify(paidRes.json)}`,
  );

  const paidSession = await readSession(success.session.id);
  const paidBooking = await readBooking(success.booking.id);
  assert(
    paidSession?.status === 'CONSUMED',
    `PAID_SESSION_STATUS_${paidSession?.status}`,
  );
  assert(
    paidBooking?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_BOOKING_PAYMENT_STATUS_${paidBooking?.paymentStatus}`,
  );

  const failed = await createPendingBookingAndSession({
    token,
    userId,
    serviceId,
    staffId,
    key: `${key}-failed`,
    dateYmd: '2027-01-13',
  });

  const failedActionEventId = `${key}-failed-action-required`;
  const failedActionRes = await postReconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: failed.booking.id,
    provider: PAYMENT_PROVIDER_NAME,
    providerEventId: failedActionEventId,
    providerSessionRef: failed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_ACTION_REQUIRED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: failed.booking.id,
      providerSessionRef: failed.providerSessionRef,
      challengeUrl: 'https://example.com/3ds/challenge-failed',
    },
  });
  assert(
    failedActionRes.status === 200,
    `FAILED_ACTION_REQUIRED_STATUS_${failedActionRes.status}_${failedActionRes.text}`,
  );
  assert(
    failedActionRes.json?.processed === true,
    `FAILED_ACTION_REQUIRED_NOT_PROCESSED_${JSON.stringify(failedActionRes.json)}`,
  );

  const authFailedEventId = `${key}-auth-failed`;
  const authFailedRes = await postReconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: failed.booking.id,
    provider: PAYMENT_PROVIDER_NAME,
    providerEventId: authFailedEventId,
    providerSessionRef: failed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHENTICATION_FAILED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: failed.booking.id,
      providerSessionRef: failed.providerSessionRef,
      failureReason: '3ds_failed',
    },
  });
  assert(
    authFailedRes.status === 200,
    `AUTH_FAILED_STATUS_${authFailedRes.status}_${authFailedRes.text}`,
  );
  assert(
    authFailedRes.json?.processed === true,
    `AUTH_FAILED_NOT_PROCESSED_${JSON.stringify(authFailedRes.json)}`,
  );

  const failedSession = await readSession(failed.session.id);
  assert(
    failedSession?.status === 'FAILED',
    `FAILED_SESSION_STATUS_${failedSession?.status}`,
  );
  assert(Boolean(failedSession?.failedAt), 'FAILED_AT_MISSING');
  assert(
    String(failedSession?.failureReason || '').includes('3ds_failed'),
    `FAILED_REASON_${failedSession?.failureReason}`,
  );

  const paidAfterFailEventId = `${key}-paid-after-fail`;
  const paidAfterFailRes = await postWebhook({
    eventId: paidAfterFailEventId,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: failed.booking.id,
      providerSessionRef: failed.providerSessionRef,
    },
  });
  assert(
    paidAfterFailRes.status === 200,
    `PAID_AFTER_FAIL_STATUS_${paidAfterFailRes.status}_${paidAfterFailRes.text}`,
  );
  assert(
    paidAfterFailRes.json?.rejected === true,
    `PAID_AFTER_FAIL_NOT_REJECTED_${JSON.stringify(paidAfterFailRes.json)}`,
  );
  assert(
    String(paidAfterFailRes.json?.reason || '').includes('FAILED'),
    `PAID_AFTER_FAIL_REASON_${paidAfterFailRes.json?.reason}`,
  );

  console.log(
    JSON.stringify(
      {
        successBookingId: success.booking.id,
        failedBookingId: failed.booking.id,
        actionRequiredStatus: actionSession?.status,
        authorizedStatus: authorizedSession?.status,
        paidStatus: paidSession?.status,
        failedStatus: failedSession?.status,
        duplicateHandled: true,
      },
      null,
      2,
    ),
  );
  console.log('PAYMENT_3DS_SCA_PROOF_OK');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error.message || error);
  await prisma.$disconnect();
  process.exit(1);
});
