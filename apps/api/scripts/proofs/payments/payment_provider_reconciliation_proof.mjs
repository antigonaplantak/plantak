#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const API_URL = process.env.API_URL ?? 'http://localhost:3001/api';
const BASE_DATE =
  process.env.DATE_YMD ??
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const OWNER_EMAIL = 'owner@example.com';
const BUSINESS_ID = 'b1';
const PROVIDER = 'stub';
const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev_payment_webhook_secret';

function day(offset) {
  const base = new Date(`${BASE_DATE}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

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
  const requestRes = await http('/auth/magic/request', {
    method: 'POST',
    body: { email: OWNER_EMAIL },
  });

  assert(
    requestRes.status === 201,
    `MAGIC_REQUEST_${requestRes.status}_${requestRes.text}`,
  );

  const code =
    requestRes.json?.code ??
    requestRes.json?.devCode ??
    requestRes.json?.debugCode ??
    requestRes.json?.magicCode ??
    requestRes.json?.otp;

  assert(code, 'MAGIC_CODE_NOT_FOUND');

  const verifyRes = await http('/auth/magic/verify', {
    method: 'POST',
    body: { email: OWNER_EMAIL, code },
  });

  assert(
    verifyRes.status === 201,
    `MAGIC_VERIFY_${verifyRes.status}_${verifyRes.text}`,
  );

  const token =
    verifyRes.json?.accessToken ??
    verifyRes.json?.tokens?.accessToken ??
    verifyRes.json?.access?.token ??
    verifyRes.json?.token;

  assert(token, 'ACCESS_TOKEN_NOT_FOUND');
  return token;
}

function extractSessionCreateJson(stdout) {
  const match = stdout.match(
    /(\{[\s\S]*?"bookingId"[\s\S]*?"sessionId"[\s\S]*?"status"\s*:\s*"OPEN"[\s\S]*?\})\s*PAYMENT_SESSION_CREATE_PROOF_OK/,
  );
  assert(match, `SESSION_CREATE_JSON_NOT_FOUND\n${stdout}`);
  return JSON.parse(match[1]);
}

async function createOpenPaymentSession(dateYmd, label) {
  const run = spawnSync(
    'node',
    ['apps/api/scripts/proofs/payments/payment_session_create_proof.mjs'],
    {
      cwd: process.cwd(),
      env: { ...process.env, API_URL, DATE_YMD: dateYmd },
      encoding: 'utf8',
    },
  );

  assert(
    run.status === 0,
    `SESSION_CREATE_PROOF_FAILED_${label}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`,
  );

  const data = extractSessionCreateJson(run.stdout);
  const providerSessionRef = `${label}-provider-session-ref-${data.bookingId ?? data.sessionId}`;

  await prisma.paymentSession.update({
    where: { id: data.sessionId },
    data: { providerSessionRef },
  });

  return {
    bookingId: data.bookingId,
    sessionId: data.sessionId,
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
      consumedAt: true,
      cancelledAt: true,
      failedAt: true,
      failureReason: true,
    },
  });
}

async function getEvent(providerEventId) {
  return prisma.paymentProviderEvent.findUnique({
    where: {
      provider_providerEventId: {
        provider: PROVIDER,
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

async function countEvents(providerEventId) {
  return prisma.paymentProviderEvent.count({
    where: {
      provider: PROVIDER,
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
    eventType: 'deposit.paid',
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
    eventType: 'deposit.paid',
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
    'deposit.paid',
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
    eventType: 'deposit.cancelled',
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
    eventType: 'deposit.failed',
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
    eventType: 'deposit.expired',
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

async function main() {
  const token = await loginOwner();

  const paid = await provePaidReconcile(token);
  const cancelled = await proveCancelledReconcile(token);
  const failed = await proveFailedReconcile(token);
  const expired = await proveExpiredReconcile(token);

  console.log(
    JSON.stringify(
      {
        paidBookingId: paid.paidBookingId,
        paidSessionStatus: paid.paidSessionStatus,
        cancelledSessionStatus: cancelled.cancelledSessionStatus,
        failedSessionStatus: failed.failedSessionStatus,
        expiredSessionStatus: expired.expiredSessionStatus,
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
