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
        provider: 'stub',
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
    const provider = String(input.provider || '').trim();
    const providerEventId = String(input.providerEventId || '').trim();
    const eventType = String(input.eventType || '').trim();
    const businessId = String(input.businessId || '').trim();
    const bookingId = String(input.bookingId || '').trim();

    if (!provider) throw new BadRequestException('provider is required');
    if (!providerEventId) {
      throw new BadRequestException('providerEventId is required');
    }
    if (!eventType) throw new BadRequestException('eventType is required');
    if (!businessId) throw new BadRequestException('businessId is required');
    if (!bookingId) throw new BadRequestException('bookingId is required');

    this.assertSignature(input.rawBody, input.signature);

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
      throw e;
    }

    const rowId = (row as { id: string }).id;

    try {
      let result: unknown;

      switch (eventType) {
        case 'deposit.paid':
          result = await this.bookings.markDepositPaid({
            businessId,
            bookingId,
            actorUserId: 'system:payment-webhook',
            actorRole: 'ADMIN',
            idempotencyKey: `provider:${provider}:${providerEventId}:deposit-paid`,
          });
          break;

        case 'deposit.expired':
          result = await this.bookings.expirePendingDeposit({
            businessId,
            bookingId,
            actorUserId: 'system:payment-webhook',
            actorRole: 'ADMIN',
            idempotencyKey: `provider:${provider}:${providerEventId}:deposit-expire`,
          });
          break;

        default:
          await this.prisma.paymentProviderEvent.update({
            where: { id: rowId },
            data: {
              rejectedAt: new Date(),
              rejectReason: `Unsupported event type: ${eventType}`,
            },
          });

          return {
            ok: true,
            duplicate: false,
            provider,
            providerEventId,
            eventType,
            rejected: true,
          };
      }

      await this.prisma.paymentProviderEvent.update({
        where: { id: rowId },
        data: {
          processedAt: new Date(),
        },
      });

      return {
        ok: true,
        duplicate: false,
        provider,
        providerEventId,
        eventType,
        processed: true,
        result,
      };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof ConflictException) {
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
