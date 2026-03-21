import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingsService } from '../bookings/bookings.service';
import {
  DEFAULT_PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_EVENT,
  parsePaymentProviderContract,
  normalizePaymentProviderEventType,
  normalizePaymentProviderName,
} from './payment-provider-contract';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  private readonly paymentSessionSelect = {
    id: true,
    bookingId: true,
    businessId: true,
    provider: true,
    providerSessionRef: true,
    checkoutUrl: true,
    returnUrl: true,
    cancelUrl: true,
    status: true,
    amountCents: true,
    currency: true,
    expiresAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  private getWebhookSecret(): string {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
    if (!secret) {
      throw new BadRequestException('Payment webhook secret not configured');
    }
    return secret;
  }

  private computeSignature(rawBody: string): string {
    return crypto
      .createHmac('sha256', this.getWebhookSecret())
      .update(rawBody)
      .digest('hex');
  }

  private assertSignature(rawBody: string, signature: string): void {
    const expected = this.computeSignature(rawBody);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid payment webhook signature');
    }
  }

  private isExpired(at: Date | null | undefined): boolean {
    return Boolean(at && at.getTime() <= Date.now());
  }

  private mapPaymentSession(session: {
    id: string;
    bookingId: string;
    businessId: string;
    provider: string;
    providerSessionRef: string | null;
    checkoutUrl: string | null;
    returnUrl: string | null;
    cancelUrl: string | null;
    status: string;
    amountCents: number;
    currency: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: session.id,
      bookingId: session.bookingId,
      businessId: session.businessId,
      provider: session.provider,
      providerSessionRef: session.providerSessionRef,
      checkoutUrl: session.checkoutUrl,
      returnUrl: session.returnUrl,
      cancelUrl: session.cancelUrl,
      status: session.status,
      amountCents: session.amountCents,
      currency: session.currency,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private getProviderSessionRef(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';

    const rec = payload as Record<string, unknown>;
    const candidates = [
      rec.providerSessionRef,
      rec.provider_session_ref,
      rec.sessionRef,
      rec.sessionId,
      rec.providerReference,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return '';
  }

  private getFailureReason(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;

    const rec = payload as Record<string, unknown>;
    const candidates = [rec.failureReason, rec.reason, rec.message, rec.error];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }

  private async markPaymentSessionState(input: {
    sessionId: string;
    nextStatus: 'AUTHORIZED' | 'CONSUMED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';
    eventType: string;
    providerEventId: string;
    payload: unknown;
    failureReason?: string | null;
  }) {
    const now = new Date();

    const data: Prisma.PaymentSessionUpdateInput = {
      status: input.nextStatus,
      meta: {
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    };

    if (input.nextStatus === 'AUTHORIZED') {
      data.authorizedAt = now;
    }

    if (input.nextStatus === 'CONSUMED') {
      data.consumedAt = now;
    }

    if (input.nextStatus === 'CANCELLED') {
      data.cancelledAt = now;
    }

    if (input.nextStatus === 'FAILED') {
      data.failedAt = now;
      data.failureReason =
        input.failureReason ?? 'Provider marked payment session failed';
    }

    await this.prisma.paymentSession.update({
      where: { id: input.sessionId },
      data,
    });
  }

  private async createPaymentTransaction(input: {
    bookingId: string;
    businessId: string;
    transactionType: 'DEPOSIT_AUTHORIZATION' | 'DEPOSIT_VOID';
    amountCents: number;
    currency: string;
    meta: Prisma.InputJsonValue;
  }) {
    await this.prisma.paymentTransaction.create({
      data: {
        bookingId: input.bookingId,
        businessId: input.businessId,
        transactionType: input.transactionType,
        amountCents: input.amountCents,
        currency: input.currency,
        actorUserId: 'system:payment-webhook',
        actorRole: 'ADMIN',
        meta: input.meta,
      },
    });
  }

  async createBookingPaymentSession(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    idempotencyKey?: string;
    returnUrl?: string;
    cancelUrl?: string;
  }) {
    const businessId = String(input.businessId || '').trim();
    const bookingId = String(input.bookingId || '').trim();
    const actorUserId = String(input.actorUserId || '').trim();
    const idempotencyKey = String(input.idempotencyKey || '').trim() || null;
    const returnUrl = String(input.returnUrl || '').trim() || null;
    const cancelUrl = String(input.cancelUrl || '').trim() || null;

    if (!businessId) throw new BadRequestException('businessId is required');
    if (!bookingId) throw new BadRequestException('bookingId is required');
    if (!actorUserId) {
      throw new ForbiddenException('Authentication required');
    }

    const booking = await this.prisma.booking.findFirst({
      where: {
        id: bookingId,
        businessId,
      },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        status: true,
        paymentStatus: true,
        amountDepositCentsSnapshot: true,
        currencySnapshot: true,
        depositExpiresAt: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customerId !== actorUserId) {
      throw new ForbiddenException(
        'Not allowed to create payment session for this booking',
      );
    }

    if (booking.status !== 'PENDING') {
      throw new ConflictException('Booking is not payment-session eligible');
    }

    const depositAmountCents = booking.amountDepositCentsSnapshot ?? 0;
    if (depositAmountCents <= 0) {
      throw new BadRequestException('Booking has no deposit requirement');
    }

    if (booking.paymentStatus !== 'DEPOSIT_PENDING') {
      throw new ConflictException('Booking deposit is not pending');
    }

    if (!booking.depositExpiresAt || this.isExpired(booking.depositExpiresAt)) {
      throw new ConflictException('Deposit hold expired');
    }

    if (idempotencyKey) {
      const existingByKey = await this.prisma.paymentSession.findUnique({
        where: {
          businessId_idempotencyKey: {
            businessId,
            idempotencyKey,
          },
        },
        select: this.paymentSessionSelect,
      });

      if (existingByKey) {
        if (existingByKey.bookingId !== booking.id) {
          throw new ConflictException(
            'Idempotency key already used for different payment session',
          );
        }

        return this.mapPaymentSession(existingByKey);
      }
    }

    const existingOpen = await this.prisma.paymentSession.findFirst({
      where: {
        bookingId: booking.id,
        status: 'OPEN',
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: this.paymentSessionSelect,
    });

    if (existingOpen) {
      return this.mapPaymentSession(existingOpen);
    }

    const created = await this.prisma.paymentSession.create({
      data: {
        bookingId: booking.id,
        businessId: booking.businessId,
        provider: DEFAULT_PAYMENT_PROVIDER,
        status: 'OPEN',
        amountCents: depositAmountCents,
        currency: booking.currencySnapshot || 'EUR',
        expiresAt: booking.depositExpiresAt,
        idempotencyKey,
        returnUrl,
        cancelUrl,
      },
      select: this.paymentSessionSelect,
    });

    return this.mapPaymentSession(created);
  }

  async reconcileProviderEvent(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    businessId: string;
    bookingId: string;
    providerSessionRef?: string;
    payload?: unknown;
  }) {
    return this.processProviderEventInternal({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      businessId: input.businessId,
      bookingId: input.bookingId,
      signature: '',
      rawBody: JSON.stringify(input.payload ?? {}),
      payload: input.payload ?? {},
      providerSessionRef: input.providerSessionRef ?? '',
      verifySignature: false,
    });
  }

  async processProviderWebhook(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    businessId: string;
    bookingId: string;
    signature: string;
    rawBody: string;
    payload: unknown;
  }) {
    return this.processProviderEventInternal({
      ...input,
      providerSessionRef: '',
      verifySignature: true,
    });
  }

  private async processProviderEventInternal(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    businessId: string;
    bookingId: string;
    signature: string;
    rawBody: string;
    payload: unknown;
    providerSessionRef?: string;
    verifySignature: boolean;
  }) {
    const provider = normalizePaymentProviderName(input.provider);
    const providerEventId = String(input.providerEventId || '').trim();
    const eventType = normalizePaymentProviderEventType(input.eventType);
    const businessId = String(input.businessId || '').trim();
    const bookingId = String(input.bookingId || '').trim();

    if (!provider) throw new BadRequestException('provider is required');
    if (!providerEventId) {
      throw new BadRequestException('providerEventId is required');
    }
    if (!eventType) throw new BadRequestException('eventType is required');

    if (input.verifySignature) {
      this.assertSignature(input.rawBody, input.signature);
    }

    let row;
    try {
      row = await this.prisma.paymentProviderEvent.create({
        data: {
          provider,
          providerEventId,
          eventType,
          businessId,
          bookingId,
          payload: input.payload as Prisma.InputJsonValue,
          signatureVerifiedAt: new Date(),
        },
        select: {
          id: true,
          provider: true,
          providerEventId: true,
          eventType: true,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentProviderEvent.findUnique({
          where: {
            provider_providerEventId: {
              provider,
              providerEventId,
            },
          },
          select: {
            id: true,
            provider: true,
            providerEventId: true,
            eventType: true,
            processedAt: true,
            rejectedAt: true,
          },
        });

        if (existing && !existing.processedAt) {
          row = await this.prisma.paymentProviderEvent.update({
            where: { id: existing.id },
            data: {
              eventType,
              businessId,
              bookingId,
              payload: input.payload as Prisma.InputJsonValue,
              signatureVerifiedAt: new Date(),
              rejectedAt: null,
              rejectReason: null,
            },
            select: {
              id: true,
              provider: true,
              providerEventId: true,
              eventType: true,
            },
          });
        } else {
          return {
            ok: true,
            duplicate: true,
            provider,
            providerEventId,
            eventType: existing?.eventType ?? eventType,
            processed: Boolean(existing?.processedAt),
            rejected: Boolean(existing?.rejectedAt),
          };
        }
      }
      throw e;
    }

    const rowId = (row as { id: string }).id;

    try {
      const providerContract = parsePaymentProviderContract({
        provider,
        eventType,
      });
      if (!providerContract.ok) {
        throw new BadRequestException(providerContract.reason);
      }

      const providerSessionRef = providerContract.eventRule
        .requiresProviderSessionRef
        ? String(input.providerSessionRef || '').trim() ||
          this.getProviderSessionRef(input.payload)
        : '';

      if (
        providerContract.eventRule.requiresProviderSessionRef &&
        !providerSessionRef
      ) {
        throw new BadRequestException('providerSessionRef is required');
      }

      const session = await this.prisma.paymentSession.findFirst({
        where: {
          provider: providerContract.provider,
          providerSessionRef,
        },
        select: {
          id: true,
          businessId: true,
          bookingId: true,
          status: true,
          providerSessionRef: true,
          amountCents: true,
          currency: true,
          authorizedAt: true,
        },
      });

      if (!session) {
        throw new NotFoundException('Payment session not found');
      }

      if (businessId && businessId !== session.businessId) {
        throw new ConflictException('Payment session business mismatch');
      }

      if (bookingId && bookingId !== session.bookingId) {
        throw new ConflictException('Payment session booking mismatch');
      }

      const allowedStatusesByEvent = {
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED]: ['OPEN'],
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID]: ['AUTHORIZED'],
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_VOIDED]: ['AUTHORIZED'],
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED]: ['OPEN'],
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED]: ['OPEN'],
        [PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED]: ['OPEN', 'AUTHORIZED'],
      } as const;

      const allowedStatuses =
        allowedStatusesByEvent[providerContract.eventType] ?? [];

      if (!allowedStatuses.some((status) => status === session.status)) {
        throw new ConflictException(
          `Payment session status ${session.status} not allowed for ${providerContract.eventType}`,
        );
      }

      const resolvedBusinessId = session.businessId;
      const resolvedBookingId = session.bookingId;
      let result: unknown;

      switch (providerContract.eventType) {
        case PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED:
          await this.createPaymentTransaction({
            bookingId: resolvedBookingId,
            businessId: resolvedBusinessId,
            transactionType: 'DEPOSIT_AUTHORIZATION',
            amountCents: session.amountCents,
            currency: session.currency,
            meta: {
              providerEventId,
              eventType: providerContract.eventType,
              providerSessionRef,
            } as Prisma.InputJsonValue,
          });
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'AUTHORIZED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
          });
          result = { sessionId: session.id, status: 'AUTHORIZED' };
          break;

        case PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID:
          result = await this.bookings.markDepositPaid({
            businessId: resolvedBusinessId,
            bookingId: resolvedBookingId,
            actorUserId: 'system:payment-webhook',
            actorRole: 'ADMIN',
            idempotencyKey: `provider:${providerContract.provider}:${providerEventId}:deposit-paid`,
          });
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'CONSUMED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
          });
          break;

        case PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED:
          result = await this.bookings.expirePendingDeposit({
            businessId: resolvedBusinessId,
            bookingId: resolvedBookingId,
            actorUserId: 'system:payment-webhook',
            actorRole: 'ADMIN',
            idempotencyKey: `provider:${providerContract.provider}:${providerEventId}:deposit-expire`,
          });
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'EXPIRED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
          });
          break;

        case PAYMENT_PROVIDER_EVENT.DEPOSIT_VOIDED:
          await this.createPaymentTransaction({
            bookingId: resolvedBookingId,
            businessId: resolvedBusinessId,
            transactionType: 'DEPOSIT_VOID',
            amountCents: session.amountCents,
            currency: session.currency,
            meta: {
              providerEventId,
              eventType: providerContract.eventType,
              providerSessionRef,
            } as Prisma.InputJsonValue,
          });
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'CANCELLED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
          });
          result = { sessionId: session.id, status: 'CANCELLED' };
          break;

        case PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED:
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'CANCELLED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
          });
          result = { sessionId: session.id, status: 'CANCELLED' };
          break;

        case PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED:
          await this.markPaymentSessionState({
            sessionId: session.id,
            nextStatus: 'FAILED',
            eventType: providerContract.eventType,
            providerEventId,
            payload: input.payload,
            failureReason: this.getFailureReason(input.payload),
          });
          result = { sessionId: session.id, status: 'FAILED' };
          break;
      }

      await this.prisma.paymentProviderEvent.update({
        where: { id: rowId },
        data: {
          businessId: resolvedBusinessId,
          bookingId: resolvedBookingId,
          processedAt: new Date(),
          rejectedAt: null,
          rejectReason: null,
        },
      });

      return {
        ok: true,
        duplicate: false,
        provider: providerContract.provider,
        providerEventId,
        eventType: providerContract.eventType,
        processed: true,
        result,
      };
    } catch (e) {
      if (
        e instanceof BadRequestException ||
        e instanceof ConflictException ||
        e instanceof NotFoundException ||
        e instanceof ForbiddenException
      ) {
        await this.prisma.paymentProviderEvent.update({
          where: { id: rowId },
          data: {
            rejectedAt: new Date(),
            rejectReason: e.message,
          },
        });

        return {
          ok: true,
          duplicate: false,
          provider,
          providerEventId,
          eventType,
          rejected: true,
          reason: e.message,
        };
      }

      throw e;
    }
  }
}
