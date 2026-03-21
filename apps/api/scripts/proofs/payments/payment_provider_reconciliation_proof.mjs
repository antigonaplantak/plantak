#!/usr/bin/env node
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import {
  authOwner,
  ensureDepositEnabledFixture,
  getFirstSlot,
} from './_payment_proof_fixture.mjs';

const prisma = new PrismaClient();
const require = createRequire(import.meta.url);

const {
  DEFAULT_PAYMENT_PROVIDER: PROVIDER,
  PAYMENT_PROVIDER_EVENT,
} = require('../../../dist/payments/payment-provider-contract.js');

const API_URL = process.env.API_URL ?? 'http://localhost:3001/api';
const BASE_DATE = process.env.DATE_YMD ?? '2027-01-12';

const OWNER_EMAIL = 'owner@example.com';
const BUSINESS_ID = 'b1';
const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev_payment_webhook_secret';

let ownerPromise;
let fixturePromise;

async function getOwner() {
  if (!ownerPromise) ownerPromise = authOwner();
  return ownerPromise;
}

async function getFixture() {
  if (!fixturePromise) fixturePromise = ensureDepositEnabledFixture();
  return fixturePromise;
}

function day(offset) {
  const base = new Date(`${BASE_DATE}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function http(path, init = {}, attempt = 0) {
  const { token, headers: initHeaders = {}, body: initBody, ...fetchInit } = init;

  const body =
    initBody === undefined
      ? undefined
      : typeof initBody === 'string'
        ? initBody
        : JSON.stringify(initBody);

  const res = await fetch(`${API_URL}${path}`, {
    ...fetchInit,
    ...(body === undefined ? {} : { body }),
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...initHeaders,
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  const method = String(init.method || 'GET').toUpperCase();

  if (
    res.status === 429 &&
    method === 'GET' &&
    path.startsWith('/availability?')
  ) {
    if (attempt >= 6) {
      console.error(`HTTP_${res.status} ${method} ${path} :: ${text}`);
      throw new Error(`HTTP_${res.status} ${method} ${path} :: ${text}`);
    }

    await sleep(1200 * (attempt + 1));
    return http(path, init, attempt + 1);
  }

  if (!res.ok) {
    console.error(`HTTP_${res.status} ${method} ${path} :: ${text}`);
    throw new Error(`HTTP_${res.status} ${method} ${path} :: ${text}`);
  }

  return { status: res.status, text, json };
}

async function loginOwner() {
  const { token } = await getOwner();
  return token;
}

async function createOpenPaymentSession(dateYmd, label) {
  console.log(`TRACE createOpenPaymentSession:start label=${label} date=${dateYmd}`);

  const { token, userId } = await getOwner();
  const { serviceId, staffId } = await getFixture();

  const slot = await getFirstSlot({
    businessId: BUSINESS_ID,
    serviceId,
    staffId,
    dateYmd,
    searchDays: 45,
  });

  assert(slot?.start, `NO_SLOT_FOUND_${label}_${dateYmd}`);

  const bookingRes = await http('/bookings', {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      serviceId,
      staffId,
      customerId: userId,
      startAt: slot.start,
      idempotencyKey: `${label}-${RUN_ID}-create`,
    },
  });

  assert(
    bookingRes.status === 201,
    `BOOKING_CREATE_FAILED_${label}_${bookingRes.status}_${bookingRes.text}`,
  );

  const bookingId = bookingRes.json?.id;
  assert(bookingId, `BOOKING_ID_MISSING_${label}`);
  assert(
    bookingRes.json?.paymentStatus === 'DEPOSIT_PENDING',
    `BOOKING_PAYMENT_STATUS_${label}_${bookingRes.json?.paymentStatus}`,
  );

  const sessionRes = await http(`/payments/bookings/${bookingId}/session`, {
    method: 'POST',
    token,
    body: {
      businessId: BUSINESS_ID,
      idempotencyKey: `${label}-${RUN_ID}-session`,
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    },
  });

  assert(
    sessionRes.status === 201,
    `SESSION_CREATE_FAILED_${label}_${sessionRes.status}_${sessionRes.text}`,
  );

  const sessionId = sessionRes.json?.id;
  assert(sessionId, `SESSION_ID_MISSING_${label}`);

  const providerSessionRef = `${label}-provider-session-ref-${bookingId}`;

  await prisma.paymentSession.update({
    where: { id: sessionId },
    data: { providerSessionRef },
  });

  console.log(
    `TRACE createOpenPaymentSession:done label=${label} booking=${bookingId} session=${sessionId}`,
  );

  return {
    bookingId,
    sessionId,
    providerSessionRef,
  };
}

async function getBooking(id) {
  return prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      depositExpiresAt: true,
    },
  });
}

async function getSession(id) {
  return prisma.paymentSession.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      providerSessionRef: true,
      authorizedAt: true,
      consumedAt: true,
      cancelledAt: true,
      failedAt: true,
      failureReason: true,
    },
  });
}

async function getEvent(providerEventId, provider = PROVIDER) {
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
      processedAt: true,
      rejectedAt: true,
      rejectReason: true,
    },
  });
}

async function countEvents(providerEventId, provider = PROVIDER) {
  return prisma.paymentProviderEvent.count({
    where: {
      provider,
      providerEventId,
    },
  });
}

async function reconcile(token, body) {
  return http('/payments/provider/reconcile', {
    method: 'POST',
    token,
    body,
  });
}

async function webhook(body, providerEventId, eventType) {
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', PAYMENT_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return http('/payments/provider/webhook', {
    method: 'POST',
    headers: {
      'x-payment-provider': PROVIDER,
      'x-payment-event-id': providerEventId,
      'x-payment-event-type': eventType,
      'x-payment-signature': signature,
    },
    body,
  });
}

async function provePaidReconcile(token) {
  const label = 'provider-reconcile-paid';
  const seed = await createOpenPaymentSession(day(0), label);

  const authorizedEventId = `${label}-authorized-${seed.bookingId}`;
  const authorizedPayload = {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    providerSessionRef: seed.providerSessionRef,
    amountCents: 1500,
  };

  const authorizedRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId: authorizedEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED,
    payload: authorizedPayload,
  });

  assert(
    authorizedRes.status === 200,
    `AUTHORIZED_RECONCILE_STATUS_${authorizedRes.status}_${authorizedRes.text}`,
  );
  assert(
    authorizedRes.json?.processed === true,
    'AUTHORIZED_RECONCILE_NOT_PROCESSED',
  );

  const authorizedSession = await getSession(seed.sessionId);
  const authorizedEvent = await getEvent(authorizedEventId);

  assert(
    authorizedSession?.status === 'AUTHORIZED',
    `AUTHORIZED_SESSION_STATUS_${authorizedSession?.status}`,
  );
  assert(
    Boolean(authorizedSession?.authorizedAt),
    'AUTHORIZED_SESSION_AUTHORIZED_AT_MISSING',
  );
  assert(
    Boolean(authorizedEvent?.processedAt),
    'AUTHORIZED_EVENT_PROCESSED_AT_MISSING',
  );

  const providerEventId = `${label}-event-${seed.bookingId}`;
  const payload = {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    providerSessionRef: seed.providerSessionRef,
    amountCents: 1500,
  };

  const paidRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload,
  });

  assert(
    paidRes.status === 200,
    `PAID_RECONCILE_STATUS_${paidRes.status}_${paidRes.text}`,
  );
  assert(paidRes.json?.processed === true, 'PAID_RECONCILE_NOT_PROCESSED');

  const paidBooking = await getBooking(seed.bookingId);
  const paidSession = await getSession(seed.sessionId);
  const paidEvent = await getEvent(providerEventId);

  assert(
    paidBooking?.paymentStatus === 'DEPOSIT_PAID' ||
      paidBooking?.paymentStatus === 'PAID' ||
      paidBooking?.paymentStatus === 'REMAINING_DUE_IN_SALON',
    `PAID_BOOKING_PAYMENT_STATUS_${paidBooking?.paymentStatus}`,
  );
  assert(
    paidSession?.status === 'CONSUMED',
    `PAID_SESSION_STATUS_${paidSession?.status}`,
  );
  assert(Boolean(paidSession?.consumedAt), 'PAID_SESSION_CONSUMED_AT_MISSING');
  assert(Boolean(paidEvent?.processedAt), 'PAID_EVENT_PROCESSED_AT_MISSING');

  const duplicateRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload,
  });

  assert(
    duplicateRes.status === 200,
    `DUPLICATE_RECONCILE_STATUS_${duplicateRes.status}_${duplicateRes.text}`,
  );
  assert(duplicateRes.json?.duplicate === true, 'DUPLICATE_RECONCILE_NOT_TRUE');
  assert(
    (await countEvents(providerEventId)) === 1,
    'DUPLICATE_RECONCILE_EVENT_COUNT_MISMATCH',
  );

  const lateWebhookRes = await webhook(
    payload,
    providerEventId,
    PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
  );
  assert(
    lateWebhookRes.status === 200,
    `LATE_WEBHOOK_STATUS_${lateWebhookRes.status}_${lateWebhookRes.text}`,
  );
  assert(lateWebhookRes.json?.duplicate === true, 'LATE_WEBHOOK_NOT_DUPLICATE');
  assert(
    (await countEvents(providerEventId)) === 1,
    'LATE_WEBHOOK_EVENT_COUNT_MISMATCH',
  );

  return {
    paidBookingId: seed.bookingId,
    paidSessionStatus: paidSession?.status,
    duplicateHandled: true,
  };
}

async function proveCancelledReconcile(token) {
  const label = 'provider-reconcile-cancelled';
  const seed = await createOpenPaymentSession(day(1), label);
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const cancelledRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: seed.bookingId,
      providerSessionRef: seed.providerSessionRef,
      reason: 'customer_cancelled',
    },
  });

  assert(
    cancelledRes.status === 200,
    `CANCELLED_STATUS_${cancelledRes.status}_${cancelledRes.text}`,
  );
  assert(cancelledRes.json?.processed === true, 'CANCELLED_NOT_PROCESSED');

  const session = await getSession(seed.sessionId);
  assert(
    session?.status === 'CANCELLED',
    `CANCELLED_SESSION_STATUS_${session?.status}`,
  );

  return { cancelledSessionStatus: session?.status };
}

async function proveFailedReconcile(token) {
  const label = 'provider-reconcile-failed';
  const seed = await createOpenPaymentSession(day(2), label);
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const failedRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: seed.bookingId,
      providerSessionRef: seed.providerSessionRef,
      failureReason: 'card_declined',
    },
  });

  assert(
    failedRes.status === 200,
    `FAILED_STATUS_${failedRes.status}_${failedRes.text}`,
  );
  assert(failedRes.json?.processed === true, 'FAILED_NOT_PROCESSED');

  const session = await getSession(seed.sessionId);
  assert(
    session?.status === 'FAILED',
    `FAILED_SESSION_STATUS_${session?.status}`,
  );
  assert(Boolean(session?.failedAt), 'FAILED_SESSION_FAILED_AT_MISSING');

  return { failedSessionStatus: session?.status };
}

async function proveExpiredReconcile(token) {
  const label = 'provider-reconcile-expired';
  const seed = await createOpenPaymentSession(day(3), label);
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const expiredAt = new Date(Date.now() - 60_000);

  await prisma.booking.update({
    where: { id: seed.bookingId },
    data: { depositExpiresAt: expiredAt },
  });

  await prisma.paymentSession.update({
    where: { id: seed.sessionId },
    data: { expiresAt: expiredAt },
  });

  const expiredRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: seed.bookingId,
      providerSessionRef: seed.providerSessionRef,
    },
  });

  assert(
    expiredRes.status === 200,
    `EXPIRED_STATUS_${expiredRes.status}_${expiredRes.text}`,
  );
  assert(expiredRes.json?.processed === true, 'EXPIRED_NOT_PROCESSED');

  const booking = await getBooking(seed.bookingId);
  const session = await getSession(seed.sessionId);
  const event = await getEvent(providerEventId);

  assert(
    booking?.status === 'CANCELLED',
    `EXPIRED_BOOKING_STATUS_${booking?.status}`,
  );
  assert(
    booking?.paymentStatus === 'NONE',
    `EXPIRED_BOOKING_PAYMENT_STATUS_${booking?.paymentStatus}`,
  );
  assert(
    session?.status === 'EXPIRED',
    `EXPIRED_SESSION_STATUS_${session?.status}`,
  );
  assert(Boolean(event?.processedAt), 'EXPIRED_EVENT_PROCESSED_AT_MISSING');

  return { expiredSessionStatus: session?.status };
}

async function proveInvalidProviderReconcile(token) {
  const label = 'provider-reconcile-invalid-provider';
  const seed = await createOpenPaymentSession(day(4), label);
  const invalidProvider = 'invalid-provider';
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const invalidProviderRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: invalidProvider,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: seed.bookingId,
      providerSessionRef: seed.providerSessionRef,
    },
  });

  assert(
    invalidProviderRes.status === 200,
    `INVALID_PROVIDER_STATUS_${invalidProviderRes.status}_${invalidProviderRes.text}`,
  );
  assert(
    invalidProviderRes.json?.rejected === true,
    'INVALID_PROVIDER_NOT_REJECTED',
  );

  const event = await getEvent(providerEventId, invalidProvider);
  const session = await getSession(seed.sessionId);
  assert(Boolean(event?.rejectedAt), 'INVALID_PROVIDER_REJECTED_AT_MISSING');
  assert(
    String(event?.rejectReason ?? '').includes('Unsupported provider'),
    `INVALID_PROVIDER_REASON_${event?.rejectReason}`,
  );
  assert(
    session?.status === 'OPEN',
    `INVALID_PROVIDER_SESSION_STATUS_${session?.status}`,
  );

  return { invalidProviderRejected: true };
}

async function proveUnsupportedEventReconcile(token) {
  const label = 'provider-reconcile-unsupported-event';
  const seed = await createOpenPaymentSession(day(5), label);
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const unsupportedRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: seed.bookingId,
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: 'deposit.unsupported',
    payload: {
      businessId: BUSINESS_ID,
      bookingId: seed.bookingId,
      providerSessionRef: seed.providerSessionRef,
    },
  });

  assert(
    unsupportedRes.status === 200,
    `UNSUPPORTED_STATUS_${unsupportedRes.status}_${unsupportedRes.text}`,
  );
  assert(unsupportedRes.json?.rejected === true, 'UNSUPPORTED_NOT_REJECTED');

  const event = await getEvent(providerEventId);
  const session = await getSession(seed.sessionId);
  assert(Boolean(event?.rejectedAt), 'UNSUPPORTED_REJECTED_AT_MISSING');
  assert(
    String(event?.rejectReason ?? '').includes('Unsupported event type'),
    `UNSUPPORTED_REASON_${event?.rejectReason}`,
  );
  assert(
    session?.status === 'OPEN',
    `UNSUPPORTED_SESSION_STATUS_${session?.status}`,
  );

  return { unsupportedEventRejected: true };
}

async function proveBookingMismatchReconcile(token) {
  const label = 'provider-reconcile-booking-mismatch';
  const seed = await createOpenPaymentSession(day(6), label);
  const providerEventId = `${label}-event-${seed.bookingId}`;

  const mismatchRes = await reconcile(token, {
    businessId: BUSINESS_ID,
    bookingId: 'wrong-booking',
    provider: PROVIDER,
    providerEventId,
    providerSessionRef: seed.providerSessionRef,
    eventType: PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID,
    payload: {
      businessId: BUSINESS_ID,
      bookingId: 'wrong-booking',
      providerSessionRef: seed.providerSessionRef,
    },
  });

  assert(
    mismatchRes.status === 200,
    `BOOKING_MISMATCH_STATUS_${mismatchRes.status}_${mismatchRes.text}`,
  );
  assert(
    mismatchRes.json?.rejected === true,
    'BOOKING_MISMATCH_NOT_REJECTED',
  );

  const event = await getEvent(providerEventId);
  const session = await getSession(seed.sessionId);
  assert(Boolean(event?.rejectedAt), 'BOOKING_MISMATCH_REJECTED_AT_MISSING');
  assert(
    String(event?.rejectReason ?? '').includes('booking mismatch'),
    `BOOKING_MISMATCH_REASON_${event?.rejectReason}`,
  );
  assert(
    session?.status === 'OPEN',
    `BOOKING_MISMATCH_SESSION_STATUS_${session?.status}`,
  );

  return { bookingMismatchRejected: true };
}

async function main() {
  console.log('TRACE main:start');
  const token = await loginOwner();
  console.log('TRACE main:loginOwner:done');

  console.log('TRACE main:provePaidReconcile:start');
  const paid = await provePaidReconcile(token);
  console.log('TRACE main:provePaidReconcile:done');

  console.log('TRACE main:proveCancelledReconcile:start');
  const cancelled = await proveCancelledReconcile(token);
  console.log('TRACE main:proveCancelledReconcile:done');

  console.log('TRACE main:proveFailedReconcile:start');
  const failed = await proveFailedReconcile(token);
  console.log('TRACE main:proveFailedReconcile:done');

  console.log('TRACE main:proveExpiredReconcile:start');
  const expired = await proveExpiredReconcile(token);
  console.log('TRACE main:proveExpiredReconcile:done');

  console.log('TRACE main:proveInvalidProviderReconcile:start');
  const invalidProvider = await proveInvalidProviderReconcile(token);
  console.log('TRACE main:proveInvalidProviderReconcile:done');

  console.log('TRACE main:proveUnsupportedEventReconcile:start');
  const unsupportedEvent = await proveUnsupportedEventReconcile(token);
  console.log('TRACE main:proveUnsupportedEventReconcile:done');

  console.log('TRACE main:proveBookingMismatchReconcile:start');
  const bookingMismatch = await proveBookingMismatchReconcile(token);
  console.log('TRACE main:proveBookingMismatchReconcile:done');

  console.log(
    JSON.stringify(
      {
        paidBookingId: paid.paidBookingId,
        paidSessionStatus: paid.paidSessionStatus,
        cancelledSessionStatus: cancelled.cancelledSessionStatus,
        failedSessionStatus: failed.failedSessionStatus,
        expiredSessionStatus: expired.expiredSessionStatus,
        invalidProviderRejected: invalidProvider.invalidProviderRejected,
        unsupportedEventRejected: unsupportedEvent.unsupportedEventRejected,
        bookingMismatchRejected: bookingMismatch.bookingMismatchRejected,
        duplicateHandled: paid.duplicateHandled,
      },
      null,
      2,
    ),
  );
  console.log('PAYMENT_PROVIDER_RECONCILIATION_PROOF_OK');
}

main()
  .catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
