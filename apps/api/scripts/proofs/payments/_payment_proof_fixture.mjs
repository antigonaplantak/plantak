import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

const require = createRequire(import.meta.url);

function loadPaymentProviderContract() {
  try {
    return require('../../../dist/payments/payment-provider-contract.js');
  } catch (error) {
    throw new Error(
      `PAYMENT_PROVIDER_CONTRACT_LOAD_FAILED_${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const paymentProviderContract = loadPaymentProviderContract();

export const API = process.env.API_URL ?? 'http://localhost:3001/api';
export const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'owner@example.com';
export const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
export const TZ_NAME = process.env.TZ_NAME ?? 'Europe/Paris';
export const PAYMENT_PROVIDER_NAME =
  paymentProviderContract.DEFAULT_PAYMENT_PROVIDER;
export const PAYMENT_PROVIDER_EVENT = paymentProviderContract.PAYMENT_PROVIDER_EVENT;

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpRaw(
  path,
  { method = 'GET', token, body } = {},
  attempt = 0,
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  const upperMethod = String(method || 'GET').toUpperCase();
  const isAvailabilityGet =
    upperMethod === 'GET' && path.startsWith('/availability?');

  if (res.status === 429 && isAvailabilityGet) {
    const resetHeader = Number(res.headers.get('x-ratelimit-reset') || '0');
    const waitMs =
      Number.isFinite(resetHeader) && resetHeader > 0
        ? (resetHeader + 1) * 1000
        : Math.min(15000, 2000 * (attempt + 1));

    if (attempt < 8) {
      await sleep(waitMs);
      return httpRaw(path, { method, token, body }, attempt + 1);
    }
  }

  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
  };
}

export async function http(path, opts = {}, attempt = 0) {
  const res = await httpRaw(path, opts);
  const method = String(opts.method ?? 'GET').toUpperCase();

  if (
    res.status === 429 &&
    method === 'GET' &&
    path.startsWith('/availability?')
  ) {
    if (attempt >= 6) {
      throw new Error(`HTTP_${res.status} ${method} ${path} :: ${res.text}`);
    }

    await sleep(1200 * (attempt + 1));
    return http(path, opts, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`HTTP_${res.status} ${method} ${path} :: ${res.text}`);
  }
  return res.json;
}

export async function authOwner() {
  const magicReq = await http('/auth/magic/request', {
    method: 'POST',
    body: { email: OWNER_EMAIL },
  });

  const code = magicReq?.devCode ?? magicReq?.code;
  assert(typeof code === 'string' && code.length > 0, 'MAGIC_CODE_NOT_FOUND');

  const verify = await http('/auth/magic/verify', {
    method: 'POST',
    body: { email: OWNER_EMAIL, code },
  });

  const token =
    verify?.accessToken ?? verify?.token ?? verify?.tokens?.accessToken;
  const userId = verify?.user?.id ?? verify?.userId ?? verify?.sub;

  assert(typeof token === 'string' && token.length > 0, 'TOKEN_NOT_FOUND');
  assert(typeof userId === 'string' && userId.length > 0, 'USER_ID_NOT_FOUND');

  return { token, userId };
}

export async function ensureDepositEnabledFixture() {
  const staff = await prisma.staff.findFirst({
    where: { businessId: BUSINESS_ID, active: true },
    select: { id: true },
  });

  assert(staff?.id, 'ACTIVE_STAFF_NOT_FOUND');

  const proofServiceName = '__payment-proof-service__';

  const existing = await prisma.service.findFirst({
    where: {
      businessId: BUSINESS_ID,
      name: proofServiceName,
      archivedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const service = existing
    ? await prisma.service.update({
        where: { id: existing.id },
        data: {
          active: true,
          archivedAt: null,
          visibility: 'PUBLIC',
          onlineBookingEnabled: true,
          durationMin: 50,
          priceCents: 5000,
          currency: 'EUR',
          depositPercent: 30,
          useBusinessDepositDefault: false,
        },
        select: { id: true },
      })
    : await prisma.service.create({
        data: {
          businessId: BUSINESS_ID,
          name: proofServiceName,
          durationMin: 50,
          priceCents: 5000,
          currency: 'EUR',
          depositPercent: 30,
          useBusinessDepositDefault: false,
          active: true,
          visibility: 'PUBLIC',
          onlineBookingEnabled: true,
        },
        select: { id: true },
      });

  await prisma.serviceStaff.upsert({
    where: {
      serviceId_staffId: {
        serviceId: service.id,
        staffId: staff.id,
      },
    },
    create: {
      serviceId: service.id,
      staffId: staff.id,
      isActive: true,
      onlineBookingEnabled: true,
      useStaffDepositDefault: false,
      depositPercent: 30,
    },
    update: {
      isActive: true,
      onlineBookingEnabled: true,
      useStaffDepositDefault: false,
      depositPercent: 30,
    },
  });

  return { serviceId: service.id, staffId: staff.id };
}

function addDays(dateYmd, offsetDays) {
  const [year, month, day] = dateYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return dt.toISOString().slice(0, 10);
}

export async function getFirstSlot({
  businessId,
  serviceId,
  staffId,
  dateYmd,
  searchDays = 45,
}) {
  for (let offset = 0; offset < searchDays; offset += 1) {
    const probeDate = addDays(dateYmd, offset);

    const qs = new URLSearchParams({
      businessId,
      serviceId,
      staffId,
      date: probeDate,
      tz: TZ_NAME,
    });

    const availability = await http(`/availability?${qs.toString()}`);
    const preferredRow =
      availability?.results?.find((row) => row.staffId === staffId) ??
      availability?.results?.[0];

    const slot = preferredRow?.slots?.[0];
    if (slot?.start) {
      return slot;
    }
  }

  throw new Error(`NO_SLOT_FOUND_IN_WINDOW_${dateYmd}_${searchDays}D`);
}
