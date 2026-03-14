import {
  BadRequestException,
  ConflictException,
  Injectable,
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
            where: { id: row.id },
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
        where: { id: row.id },
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
      if (
        e instanceof BadRequestException ||
        e instanceof ConflictException
      ) {
        await this.prisma.paymentProviderEvent.update({
          where: { id: row.id },
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
