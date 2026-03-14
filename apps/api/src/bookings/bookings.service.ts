import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCacheService } from '../infra/redis-cache.service';
import { ServiceProfileService } from '../services/service-profile.service';
import { AppRole } from '../common/auth/roles.decorator';
import { Prisma } from '@prisma/client';
import { parseStartToUtc } from '../common/time/time.util';
import { normalizeAddonIds } from '../availability/addon-ids.util';
import { buildDepositExpiryDate } from '../payments/deposit-expiry.util';
import { toPrismaDepositResolvedFromScope } from '../payments/deposit-prisma-mapper.util';
type ActorRole = AppRole | 'OWNER' | 'ADMIN';

function isBusinessOperator(role: ActorRole) {
  return role === 'OWNER' || role === 'ADMIN' || role === 'STAFF';
}

// Detect exclusion overlap error (Postgres exclusion_violation 23P01 or constraint name)
function isOverlapError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const msg = String(e.message ?? '');
    const meta = e.meta ? JSON.stringify(e.meta) : '';
    return (
      msg.includes('Booking_no_overlap_per_staff') ||
      meta.includes('Booking_no_overlap_per_staff') ||
      msg.includes('23P01') ||
      meta.includes('23P01')
    );
  }

  if (e instanceof Error) {
    return (
      e.message.includes('Booking_no_overlap_per_staff') ||
      e.message.includes('23P01')
    );
  }

  return false;
}

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private readonly cache: RedisCacheService,
    private readonly serviceProfiles: ServiceProfileService,
  ) {}

  private async invalidateAvailabilityCacheForBooking(booking: {
    businessId?: string;
    serviceId?: string;
  }) {
    try {
      if (booking?.businessId && booking?.serviceId) {
        await this.cache.delByPrefix(
          this.cache.key(
            'availability',
            `businessId=${booking.businessId}`,
            `serviceId=${booking.serviceId}`,
          ),
        );
        return;
      }

      await this.cache.delByPrefix(this.cache.key('availability'));
    } catch {
      // never fail booking flow because of cache invalidation
    }
  }

  private async resolveBusinessActorRole(
    tx: Prisma.TransactionClient,
    businessId: string,
    actorUserId: string,
    fallbackRole: ActorRole = 'CUSTOMER',
  ): Promise<ActorRole> {
    const membership = await tx.businessMember.findUnique({
      where: {
        businessId_userId: {
          businessId,
          userId: actorUserId,
        },
      },
      select: { role: true },
    });

    if (
      membership?.role === 'OWNER' ||
      membership?.role === 'ADMIN' ||
      membership?.role === 'STAFF'
    ) {
      return membership.role;
    }

    return fallbackRole;
  }

  private writeBookingHistory(
    tx: Prisma.TransactionClient,
    input: {
      bookingId: string;
      businessId: string;
      staffId?: string | null;
      customerId?: string | null;
      action: string;
      status?: string | null;
      fromStartAt?: Date | null;
      fromEndAt?: Date | null;
      toStartAt?: Date | null;
      toEndAt?: Date | null;
      actorUserId?: string | null;
      actorRole?: string | null;
      meta?: Prisma.InputJsonValue | null;
    },
  ) {
    return tx.bookingHistory.create({
      data: {
        bookingId: input.bookingId,
        businessId: input.businessId,
        staffId: input.staffId ?? null,
        customerId: input.customerId ?? null,
        action: input.action,
        status: input.status ?? null,
        fromStartAt: input.fromStartAt ?? null,
        fromEndAt: input.fromEndAt ?? null,
        toStartAt: input.toStartAt ?? null,
        toEndAt: input.toEndAt ?? null,
        actorUserId: input.actorUserId ?? null,
        actorRole: input.actorRole ?? null,
        meta: input.meta ?? Prisma.JsonNull,
      },
    });
  }

  private getCustomerNoticeMinutes(action: 'cancel' | 'reschedule'): number {
    const envName =
      action === 'cancel'
        ? 'BOOKING_CUSTOMER_CANCEL_NOTICE_MINUTES'
        : 'BOOKING_CUSTOMER_RESCHEDULE_NOTICE_MINUTES';

    const raw = process.env[envName];
    const parsed = Number(raw);

    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }

    return 24 * 60;
  }

  private enforceCustomerNoticeWindow(input: {
    action: 'cancel' | 'reschedule';
    actorRole: ActorRole;
    startAt: Date;
  }) {
    if (isBusinessOperator(input.actorRole)) return;

    const requiredMinutes = this.getCustomerNoticeMinutes(input.action);
    if (requiredMinutes <= 0) return;

    const diffMs = input.startAt.getTime() - Date.now();
    if (diffMs >= requiredMinutes * 60_000) return;

    if (input.action === 'cancel') {
      throw new BadRequestException('Cancellation window has passed');
    }

    throw new BadRequestException('Reschedule window has passed');
  }

  private getLatePolicyMinutes(): number {
    const raw = Number(process.env.BOOKING_LATE_POLICY_MINUTES);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 10;
  }

  private getNoShowPolicyMinutes(): number {
    const raw = Number(process.env.BOOKING_NO_SHOW_POLICY_MINUTES);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return 30;
  }

  private buildAttendancePolicyMeta(input: {
    startAt: Date;
    actorRole: ActorRole;
  }): Prisma.InputJsonValue {
    const now = new Date();
    const lateAt = new Date(
      input.startAt.getTime() + this.getLatePolicyMinutes() * 60_000,
    );
    const noShowAt = new Date(
      input.startAt.getTime() + this.getNoShowPolicyMinutes() * 60_000,
    );

    const state =
      now >= noShowAt
        ? 'NO_SHOW_WINDOW'
        : now >= lateAt
          ? 'LATE_WINDOW'
          : 'ON_TIME';

    return {
      evaluatedAt: now.toISOString(),
      bookingStartAt: input.startAt.toISOString(),
      actorRole: input.actorRole,
      latePolicyMinutes: this.getLatePolicyMinutes(),
      noShowPolicyMinutes: this.getNoShowPolicyMinutes(),
      latePolicyTriggered: state == 'LATE_WINDOW',
      noShowPolicyTriggered: state == 'NO_SHOW_WINDOW',
      state,
    } as Prisma.InputJsonValue;
  }

  private idemGet(businessId: string, key?: string) {
    if (!key) return null;
    return this.prisma.idempotencyKey.findUnique({
      where: { businessId_key: { businessId, key } },
    });
  }

  private idemSave(args: {
    businessId: string;
    key: string;
    action: string;
    requestHash: string;
    response: unknown;
  }) {
    return this.prisma.idempotencyKey.upsert({
      where: { businessId_key: { businessId: args.businessId, key: args.key } },
      create: {
        businessId: args.businessId,
        key: args.key,
        action: args.action,
        requestHash: args.requestHash,
        response: args.response as Prisma.InputJsonValue,
      },
      update: {},
    });
  }

  private async resolveLegacyTotalMin(
    tx: Prisma.TransactionClient,
    booking: { serviceId: string; businessId: string },
  ) {
    const service = await tx.service.findFirst({
      where: {
        id: booking.serviceId,
        businessId: booking.businessId,
        active: true,
      },
      select: {
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
      },
    });

    if (!service) throw new BadRequestException('Service not found');

    return (
      service.durationMin + service.bufferBeforeMin + service.bufferAfterMin
    );
  }

  async create(input: {
    businessId: string;
    customerId: string;
    staffId: string;
    serviceId: string;
    variantId?: string;
    addonIds?: string[];

    startAt?: string;
    startLocal?: string;
    tz?: string;

    notes?: string;
    locationId?: string;

    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const normalizedAddonIds = normalizeAddonIds(input.addonIds);

    const start = parseStartToUtc({
      startAt: input.startAt,
      startLocal: input.startLocal,
      tz: input.tz,
    });

    const requestHash = JSON.stringify({
      businessId: input.businessId,
      customerId: input.customerId,
      staffId: input.staffId,
      serviceId: input.serviceId,
      variantId: input.variantId ?? null,
      addonIds: normalizedAddonIds,
      startAtUtc: start.toISOString(),
      notes: input.notes ?? null,
      locationId: input.locationId ?? null,
      action: 'create',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash != requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const profile = await this.serviceProfiles.resolveForSelection({
      businessId: input.businessId,
      serviceId: input.serviceId,
      staffId: input.staffId,
      variantId: input.variantId,
      addonIds: normalizedAddonIds,
      requireOnlineBookingEnabled: true,
    });

    const end = new Date(start.getTime() + profile.totalMin * 60_000);
    const depositExpiresAt =
      profile.amountDepositCents > 0 ? buildDepositExpiryDate() : null;
    const paymentStatus =
      profile.amountDepositCents > 0 ? 'DEPOSIT_PENDING' : 'NONE';

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const created = await tx.booking.create({
          data: {
            businessId: input.businessId,
            customerId: input.customerId,
            staffId: input.staffId,
            serviceId: input.serviceId,
            serviceVariantId: profile.serviceVariantId,
            addonIdsSnapshot: profile.addonIds,
            serviceNameSnapshot: profile.serviceName,
            serviceVariantNameSnapshot: profile.serviceVariantName,
            addonsSnapshot: profile.addons as Prisma.InputJsonValue,
            durationMinSnapshot: profile.durationMin,
            bufferBeforeMinSnapshot: profile.bufferBeforeMin,
            bufferAfterMinSnapshot: profile.bufferAfterMin,
            priceCentsSnapshot: profile.priceCents,
            currencySnapshot: profile.currency,
            totalMinSnapshot: profile.totalMin,
            amountTotalCentsSnapshot: profile.amountTotalCents,
            amountDepositCentsSnapshot: profile.amountDepositCents,
            amountRemainingCentsSnapshot: profile.amountRemainingCents,
            depositPercentSnapshot: profile.depositPercent,
            depositResolvedFromScope: toPrismaDepositResolvedFromScope(
              profile.depositResolvedFrom,
            ),
            paymentStatus,
            depositExpiresAt,
            locationId: input.locationId ?? null,
            startAt: start,
            endAt: end,
            status: 'PENDING',
            notes: input.notes ?? null,
          },
          select: {
            id: true,
            businessId: true,
            staffId: true,
            serviceId: true,
            serviceVariantId: true,
            addonIdsSnapshot: true,
            serviceNameSnapshot: true,
            serviceVariantNameSnapshot: true,
            addonsSnapshot: true,
            durationMinSnapshot: true,
            bufferBeforeMinSnapshot: true,
            bufferAfterMinSnapshot: true,
            priceCentsSnapshot: true,
            currencySnapshot: true,
            totalMinSnapshot: true,
            amountTotalCentsSnapshot: true,
            amountDepositCentsSnapshot: true,
            amountRemainingCentsSnapshot: true,
            depositPercentSnapshot: true,
            depositResolvedFromScope: true,
            paymentStatus: true,
            depositExpiresAt: true,
            customerId: true,
            locationId: true,
            startAt: true,
            endAt: true,
            status: true,
            createdAt: true,
          },
        });

        await this.writeBookingHistory(tx, {
          bookingId: created.id,
          businessId: created.businessId,
          staffId: created.staffId,
          customerId: created.customerId,
          action: 'CREATE',
          status: created.status,
          toStartAt: created.startAt,
          toEndAt: created.endAt,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          meta: {
            serviceId: created.serviceId,
            serviceVariantId: created.serviceVariantId,
            addonIdsSnapshot: created.addonIdsSnapshot,
          } as Prisma.InputJsonValue,
        });

        return created;
      });

      if (input.idempotencyKey) {
        await this.idemSave({
          businessId: input.businessId,
          key: input.idempotencyKey,
          action: 'create',
          requestHash,
          response: created,
        });
      }

      await this.invalidateAvailabilityCacheForBooking(created);
      return created;
    } catch (e) {
      if (isOverlapError(e)) throw new ConflictException('Slot not available');
      throw new BadRequestException('Create booking failed');
    }
  }

  async reschedule(input: {
    businessId: string;
    actorUserId: string;
    actorRole: ActorRole;
    bookingId: string;

    newStartAt?: string;
    newStartLocal?: string;
    tz?: string;

    idempotencyKey?: string;
  }) {
    const start = parseStartToUtc({
      startAt: input.newStartAt,
      startLocal: input.newStartLocal,
      tz: input.tz,
    });

    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      newStartAtUtc: start.toISOString(),
      action: 'reschedule',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: {
          id: input.bookingId,
          businessId: input.businessId,
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        select: {
          id: true,
          businessId: true,
          serviceId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          depositExpiresAt: true,
          amountDepositCentsSnapshot: true,
          startAt: true,
          endAt: true,
          totalMinSnapshot: true,
        },
      });

      if (!booking)
        throw new BadRequestException('Booking not found or not reschedulable');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      const operator = isBusinessOperator(actorRole);
      const isOwnCustomerBooking = booking.customerId === input.actorUserId;
      if (!operator && !isOwnCustomerBooking) {
        throw new ForbiddenException('Not allowed to reschedule this booking');
      }

      this.enforceCustomerNoticeWindow({
        action: 'reschedule',
        actorRole,
        startAt: booking.startAt,
      });

      const totalMin =
        booking.totalMinSnapshot ??
        (await this.resolveLegacyTotalMin(tx, {
          serviceId: booking.serviceId,
          businessId: booking.businessId,
        }));

      const end = new Date(start.getTime() + totalMin * 60_000);

      try {
        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: { startAt: start, endAt: end },
          select: {
            id: true,
            businessId: true,
            staffId: true,
            serviceId: true,
            serviceVariantId: true,
            addonIdsSnapshot: true,
            serviceNameSnapshot: true,
            serviceVariantNameSnapshot: true,
            addonsSnapshot: true,
            durationMinSnapshot: true,
            bufferBeforeMinSnapshot: true,
            bufferAfterMinSnapshot: true,
            priceCentsSnapshot: true,
            currencySnapshot: true,
            totalMinSnapshot: true,
            customerId: true,
            locationId: true,
            startAt: true,
            endAt: true,
            status: true,
            updatedAt: true,
          },
        });

        await this.writeBookingHistory(tx, {
          bookingId: updated.id,
          businessId: updated.businessId,
          staffId: updated.staffId,
          customerId: updated.customerId,
          action: 'RESCHEDULE',
          status: updated.status,
          fromStartAt: booking.startAt,
          fromEndAt: booking.endAt,
          toStartAt: updated.startAt,
          toEndAt: updated.endAt,
          actorUserId: input.actorUserId,
          actorRole,
          meta: this.buildAttendancePolicyMeta({
            startAt: booking.startAt,
            actorRole,
          }),
        });

        if (input.idempotencyKey) {
          await tx.idempotencyKey
            .create({
              data: {
                businessId: input.businessId,
                key: input.idempotencyKey,
                action: 'reschedule',
                requestHash,
                response: updated as Prisma.InputJsonValue,
              },
            })
            .catch(() => undefined);
        }

        await this.invalidateAvailabilityCacheForBooking(updated);
        return updated;
      } catch (e) {
        if (isOverlapError(e))
          throw new ConflictException('Slot not available');
        throw new BadRequestException('Reschedule failed');
      }
    });
  }

  async list(params: {
    businessId: string;
    actorUserId: string;
    actorRole?: string;
    from?: string;
    to?: string;
    tz?: string;
    staffId?: string;
    locationId?: string;
    status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
    cursor?: string;
    limit: number;
    order: 'asc' | 'desc';
  }) {
    const {
      businessId,
      actorUserId,
      from,
      to,
      staffId,
      locationId,
      status,
      cursor,
      limit,
      order,
    } = params;

    const membership = await this.prisma.businessMember.findUnique({
      where: {
        businessId_userId: { businessId, userId: actorUserId },
      },
      select: { role: true },
    });

    const role = membership?.role ?? 'CUSTOMER';

    if (role === 'CUSTOMER') {
      throw new ForbiddenException('Customers cannot access business calendar');
    }

    let enforcedStaffId = staffId;

    if (role === 'STAFF') {
      const staff = await this.prisma.staff.findFirst({
        where: { businessId, userId: actorUserId },
        select: { id: true },
      });

      if (!staff) {
        throw new ForbiddenException('Staff not linked to this business');
      }

      enforcedStaffId = staff.id;
    }

    const where: Prisma.BookingWhereInput = { businessId };

    if (enforcedStaffId) where.staffId = enforcedStaffId;
    if (locationId) where.locationId = locationId;
    if (status) where.status = status;

    if (from || to) {
      const startAt: Prisma.DateTimeFilter = {};
      if (from) startAt.gte = new Date(from);
      if (to) startAt.lte = new Date(to);
      where.startAt = startAt;
    }

    const items = await this.prisma.booking.findMany({
      where,
      take: limit,
      orderBy: { startAt: order },
      ...(cursor
        ? {
            skip: 1,
            cursor: { id: cursor },
          }
        : {}),
    });

    const nextCursor =
      items.length === limit ? items[items.length - 1].id : null;

    return { items, nextCursor };
  }

  async history(params: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    limit: number;
    order: 'asc' | 'desc';
  }) {
    const { businessId, bookingId, actorUserId, limit, order } = params;

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, businessId },
      select: { id: true, customerId: true, staffId: true },
    });

    if (!booking) throw new BadRequestException('Booking not found');

    const membership = await this.prisma.businessMember.findUnique({
      where: {
        businessId_userId: { businessId, userId: actorUserId },
      },
      select: { role: true },
    });

    if (membership?.role === 'STAFF') {
      const staff = await this.prisma.staff.findFirst({
        where: { businessId, userId: actorUserId },
        select: { id: true },
      });

      if (!staff || staff.id !== booking.staffId) {
        throw new ForbiddenException('Not allowed to view booking history');
      }
    }

    if (
      membership?.role !== 'STAFF' &&
      membership?.role !== 'OWNER' &&
      membership?.role !== 'ADMIN' &&
      booking.customerId !== actorUserId
    ) {
      throw new ForbiddenException('Not allowed to view booking history');
    }

    const items = await this.prisma.bookingHistory.findMany({
      where: { businessId, bookingId: booking.id },
      orderBy: { createdAt: order },
      take: limit,
    });

    return { items };
  }

  async cancel(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      action: 'cancel',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const res = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: input.bookingId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          depositExpiresAt: true,
          amountDepositCentsSnapshot: true,
          startAt: true,
          endAt: true,
        },
      });
      if (!b) throw new BadRequestException('Booking not found');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      const operator = isBusinessOperator(actorRole);
      if (!operator && b.customerId !== input.actorUserId) {
        throw new ForbiddenException('Not allowed to cancel this booking');
      }

      if (b.status === 'CANCELLED')
        return { id: b.id, status: 'CANCELLED' as const };

      if (b.status !== 'PENDING' && b.status !== 'CONFIRMED') {
        throw new BadRequestException('Booking not cancelable');
      }

      this.enforceCustomerNoticeWindow({
        action: 'cancel',
        actorRole,
        startAt: b.startAt,
      });

      const updated = await tx.booking.update({
        where: { id: b.id },
        data: { status: 'CANCELLED' },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          serviceId: true,
          customerId: true,
          locationId: true,
          startAt: true,
          endAt: true,
          status: true,
          updatedAt: true,
        },
      });

      await this.writeBookingHistory(tx, {
        bookingId: updated.id,
        businessId: updated.businessId,
        staffId: updated.staffId,
        customerId: updated.customerId,
        action: 'CANCEL',
        status: updated.status,
        fromStartAt: b.startAt,
        fromEndAt: b.endAt,
        toStartAt: updated.startAt,
        toEndAt: updated.endAt,
        actorUserId: input.actorUserId,
        actorRole,
        meta: this.buildAttendancePolicyMeta({
          startAt: b.startAt,
          actorRole,
        }),
      });

      return updated;
    });

    if (input.idempotencyKey) {
      await this.idemSave({
        businessId: input.businessId,
        key: input.idempotencyKey,
        action: 'cancel',
        requestHash,
        response: res,
      });
    }

    await this.invalidateAvailabilityCacheForBooking({
      businessId: input.businessId,
      serviceId: 'serviceId' in res ? res.serviceId : undefined,
    });
    return res;
  }

  async confirm(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      action: 'confirm',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const res = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: input.bookingId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          depositExpiresAt: true,
          amountDepositCentsSnapshot: true,
          startAt: true,
          endAt: true,
        },
      });
      if (!b) throw new BadRequestException('Booking not found');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      const operator = isBusinessOperator(actorRole);
      if (!operator) {
        throw new ForbiddenException('Not allowed to confirm this booking');
      }

      if (b.status === 'CONFIRMED')
        return { id: b.id, status: 'CONFIRMED' as const };

      if (b.status !== 'PENDING')
        throw new BadRequestException('Booking not confirmable');

      if (
        b.paymentStatus === 'DEPOSIT_PENDING' &&
        (b.amountDepositCentsSnapshot ?? 0) > 0
      ) {
        if (
          b.depositExpiresAt &&
          b.depositExpiresAt.getTime() <= Date.now()
        ) {
          throw new ConflictException('Deposit hold expired');
        }

        throw new ConflictException(
          'Deposit payment required before confirmation',
        );
      }

      const updated = await tx.booking.update({
        where: { id: b.id },
        data: { status: 'CONFIRMED' },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          serviceId: true,
          customerId: true,
          locationId: true,
          startAt: true,
          endAt: true,
          status: true,
          updatedAt: true,
        },
      });

      await this.writeBookingHistory(tx, {
        bookingId: updated.id,
        businessId: updated.businessId,
        staffId: updated.staffId,
        customerId: updated.customerId,
        action: 'CONFIRM',
        status: updated.status,
        fromStartAt: b.startAt,
        fromEndAt: b.endAt,
        toStartAt: updated.startAt,
        toEndAt: updated.endAt,
        actorUserId: input.actorUserId,
        actorRole,
        meta: this.buildAttendancePolicyMeta({
          startAt: b.startAt,
          actorRole,
        }),
      });

      return updated;
    });

    if (input.idempotencyKey) {
      await this.idemSave({
        businessId: input.businessId,
        key: input.idempotencyKey,
        action: 'confirm',
        requestHash,
        response: res,
      });
    }

    await this.invalidateAvailabilityCacheForBooking({
      businessId: input.businessId,
      serviceId: 'serviceId' in res ? res.serviceId : undefined,
    });
    return res;
  }

  /**
   * Calendar view (grouped by day). Light payload.
   * SECURITY: role is taken from BusinessMember (source of truth), not JWT role.
   * STAFF: forced to only their own staffId, even if query provides another.
   */
  async calendar(params: {
    businessId: string;
    actorUserId: string;
    from?: string;
    to?: string;
    tz?: string;
    staffId?: string;
    locationId?: string;
    status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
    order?: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
  }) {
    const {
      businessId,
      actorUserId,
      from,
      to,
      tz = 'UTC',
      staffId,
      locationId,
      status,
      order = 'asc',
      cursor,
      limit = 200,
    } = params;

    const bm = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId: actorUserId } },
      select: { role: true },
    });

    if (!bm) throw new ForbiddenException('Not a member of this business');

    const businessRole = bm.role as 'OWNER' | 'ADMIN' | 'STAFF';

    let enforcedStaffId: string | undefined;
    if (businessRole === 'STAFF') {
      const staffRow = await this.prisma.staff.findFirst({
        where: { businessId, userId: actorUserId },
        select: { id: true },
      });
      if (!staffRow)
        throw new ForbiddenException('Staff profile not found for this user');
      enforcedStaffId = staffRow.id;
    }

    const effectiveStaffId = enforcedStaffId ?? staffId;

    const where: Prisma.BookingWhereInput = { businessId };

    if (effectiveStaffId) where.staffId = effectiveStaffId;
    if (locationId) where.locationId = locationId;
    if (status) where.status = status;

    if (from || to) {
      where.startAt = {};
      if (from) where.startAt.gte = new Date(from);
      if (to) where.startAt.lte = new Date(to);
    }

    const take = Math.max(1, Math.min(500, Number(limit) || 200));

    const items = await this.prisma.booking.findMany({
      where,
      orderBy: { startAt: order },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        businessId: true,
        staffId: true,
        serviceId: true,
        locationId: true,
        customerId: true,
        startAt: true,
        endAt: true,
        status: true,
        notes: true,
        staff: {
          select: {
            id: true,
            user: { select: { email: true } },
          },
        },
      },
    });

    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    /** grouped: { [YYYY-MM-DD]: [...] } */
    type CalendarItem = {
      id: string;

      staffId: string;

      staffEmail: string | null;

      serviceId: string;

      locationId: string | null;

      customerId: string | null;

      startAt: Date;

      endAt: Date;

      status: string;

      notes: string | null;
    };

    const grouped: Record<string, CalendarItem[]> = {};
    for (const b of items) {
      const day = fmt.format(new Date(b.startAt));
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push({
        id: b.id,
        staffId: b.staffId,
        staffEmail: b.staff?.user?.email ?? null,
        serviceId: b.serviceId,
        locationId: b.locationId,
        customerId: b.customerId,
        startAt: b.startAt,
        endAt: b.endAt,
        status: b.status,
        notes: b.notes,
      });
    }

    const nextCursor =
      items.length === take ? items[items.length - 1].id : null;
    // fire-and-forget notification job
    return {
      tz,
      role: businessRole,
      enforcedStaffId: enforcedStaffId ?? null,
      items,
      grouped,
      nextCursor,
    };
  }


  async markDepositPaid(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      action: 'deposit-paid',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const res = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: input.bookingId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          depositExpiresAt: true,
          amountDepositCentsSnapshot: true,
          amountRemainingCentsSnapshot: true,
          startAt: true,
          endAt: true,
        },
      });

      if (!b) throw new BadRequestException('Booking not found');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      if (!isBusinessOperator(actorRole)) {
        throw new ForbiddenException(
          'Not allowed to settle deposit for this booking',
        );
      }

      if (b.status === 'CANCELLED') {
        throw new BadRequestException('Booking not deposit-payable');
      }

      if ((b.amountDepositCentsSnapshot ?? 0) <= 0) {
        throw new BadRequestException('Booking has no deposit requirement');
      }

      if (
        b.status === 'CONFIRMED' &&
        (b.paymentStatus === 'REMAINING_DUE_IN_SALON' ||
          b.paymentStatus === 'PAID')
      ) {
        return {
          id: b.id,
          status: b.status,
          paymentStatus: b.paymentStatus,
        };
      }

      if (b.paymentStatus !== 'DEPOSIT_PENDING') {
        throw new BadRequestException('Booking deposit is not pending');
      }

      if (b.depositExpiresAt && b.depositExpiresAt.getTime() <= Date.now()) {
        throw new ConflictException('Deposit hold expired');
      }

      const nextPaymentStatus =
        (b.amountRemainingCentsSnapshot ?? 0) > 0
          ? 'REMAINING_DUE_IN_SALON'
          : 'PAID';

      const updated = await tx.booking.update({
        where: { id: b.id },
        data: {
          status: 'CONFIRMED',
          paymentStatus: nextPaymentStatus,
          depositExpiresAt: null,
        },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          startAt: true,
          endAt: true,
        },
      });

      await this.writeBookingHistory(tx, {
        bookingId: updated.id,
        businessId: updated.businessId,
        staffId: updated.staffId,
        customerId: updated.customerId,
        action: 'CONFIRM',
        status: updated.status,
        toStartAt: updated.startAt,
        toEndAt: updated.endAt,
        actorUserId: input.actorUserId,
        actorRole,
        meta: {
          depositSettled: true,
          paymentStatus: updated.paymentStatus,
        } as Prisma.InputJsonValue,
      });

      return updated;
    });

    if (input.idempotencyKey) {
      await this.idemSave({
        businessId: input.businessId,
        key: input.idempotencyKey,
        action: 'deposit-paid',
        requestHash,
        response: res,
      });
    }

    return res;
  }



  async expirePendingDeposit(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      action: 'deposit-expire',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: input.bookingId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          serviceId: true,
          staffId: true,
          customerId: true,
          locationId: true,
          status: true,
          paymentStatus: true,
          depositExpiresAt: true,
          amountDepositCentsSnapshot: true,
          startAt: true,
          endAt: true,
        },
      });

      if (!b) throw new BadRequestException('Booking not found');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      if (!isBusinessOperator(actorRole)) {
        throw new ForbiddenException(
          'Not allowed to expire deposit hold for this booking',
        );
      }

      if ((b.amountDepositCentsSnapshot ?? 0) <= 0) {
        throw new BadRequestException('Booking has no deposit requirement');
      }

      if (b.status !== 'PENDING' || b.paymentStatus !== 'DEPOSIT_PENDING') {
        throw new BadRequestException('Booking deposit is not pending');
      }

      if (!b.depositExpiresAt || b.depositExpiresAt.getTime() > Date.now()) {
        throw new ConflictException('Deposit hold not expired');
      }

      const updated = await tx.booking.update({
        where: { id: b.id },
        data: {
          status: 'CANCELLED',
          paymentStatus: 'NONE',
          depositExpiresAt: null,
        },
        select: {
          id: true,
          businessId: true,
          serviceId: true,
          staffId: true,
          customerId: true,
          locationId: true,
          status: true,
          paymentStatus: true,
          startAt: true,
          endAt: true,
        },
      });

      await this.writeBookingHistory(tx, {
        bookingId: updated.id,
        businessId: updated.businessId,
        staffId: updated.staffId,
        customerId: updated.customerId,
        action: 'CANCEL',
        status: updated.status,
        toStartAt: updated.startAt,
        toEndAt: updated.endAt,
        actorUserId: input.actorUserId,
        actorRole,
        meta: {
          depositExpired: true,
        } as Prisma.InputJsonValue,
      });

      return updated;
    });

    if (input.idempotencyKey) {
      await this.idemSave({
        businessId: input.businessId,
        key: input.idempotencyKey,
        action: 'deposit-expire',
        requestHash,
        response: updated,
      });
    }

    await this.cache.delByPrefix(this.cache.key('availability'));
    return updated;
  }



  async settlePayment(input: {
    businessId: string;
    bookingId: string;
    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
    const requestHash = JSON.stringify({
      businessId: input.businessId,
      bookingId: input.bookingId,
      action: 'payment-settle',
    });

    if (input.idempotencyKey) {
      const existing = await this.idemGet(
        input.businessId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const res = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: input.bookingId, businessId: input.businessId },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          amountTotalCentsSnapshot: true,
          amountDepositCentsSnapshot: true,
          amountRemainingCentsSnapshot: true,
          startAt: true,
          endAt: true,
        },
      });

      if (!b) throw new BadRequestException('Booking not found');

      const actorRole = await this.resolveBusinessActorRole(
        tx,
        input.businessId,
        input.actorUserId,
        input.actorRole,
      );

      if (!isBusinessOperator(actorRole)) {
        throw new ForbiddenException(
          'Not allowed to settle payment for this booking',
        );
      }

      if (b.status === 'CANCELLED') {
        throw new BadRequestException('Booking not payable');
      }

      if (b.status !== 'CONFIRMED') {
        throw new BadRequestException(
          'Booking must be confirmed before final payment settlement',
        );
      }

      if (b.paymentStatus === 'PAID') {
        return {
          id: b.id,
          status: b.status,
          paymentStatus: b.paymentStatus,
        };
      }

      if (b.paymentStatus === 'DEPOSIT_PENDING') {
        throw new ConflictException(
          'Deposit payment required before final settlement',
        );
      }

      const updated = await tx.booking.update({
        where: { id: b.id },
        data: {
          paymentStatus: 'PAID',
        },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          customerId: true,
          status: true,
          paymentStatus: true,
          startAt: true,
          endAt: true,
        },
      });

      await this.writeBookingHistory(tx, {
        bookingId: updated.id,
        businessId: updated.businessId,
        staffId: updated.staffId,
        customerId: updated.customerId,
        action: 'PAYMENT_SETTLED',
        status: updated.status,
        toStartAt: updated.startAt,
        toEndAt: updated.endAt,
        actorUserId: input.actorUserId,
        actorRole,
        meta: {
          previousPaymentStatus: b.paymentStatus,
          amountTotalCentsSnapshot: b.amountTotalCentsSnapshot,
          amountDepositCentsSnapshot: b.amountDepositCentsSnapshot,
          amountRemainingCentsSnapshot: b.amountRemainingCentsSnapshot,
          paymentStatus: updated.paymentStatus,
        } as Prisma.InputJsonValue,
      });

      return updated;
    });

    if (input.idempotencyKey) {
      await this.idemSave({
        businessId: input.businessId,
        key: input.idempotencyKey,
        action: 'payment-settle',
        requestHash,
        response: res,
      });
    }

    return res;
  }

}
