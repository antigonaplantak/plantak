import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import { RedisCacheService } from '../infra/redis-cache.service';
import { AppRole } from '../common/auth/roles.decorator';
import { Prisma } from '@prisma/client';
import { parseStartToUtc } from '../common/time/time.util';
type ActorRole = AppRole;

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
  constructor(private prisma: PrismaService, private readonly cache: RedisCacheService) {}

  private async invalidateAvailabilityCacheForBooking(
    booking: {
      businessId?: string;
      serviceId?: string;
      staffId?: string;
      startAt?: Date | string | null;
    },
    tz = 'Europe/Paris',
  ) {
    try {
      if (booking?.businessId && booking?.serviceId && booking?.staffId && booking?.startAt) {
        const start =
          booking.startAt instanceof Date
            ? booking.startAt
            : new Date(booking.startAt);

        const date = DateTime.fromJSDate(start, { zone: 'utc' })
          .setZone(tz)
          .toFormat('yyyy-LL-dd');

        const keyWithTz = this.cache.key(
          'availability',
          `businessId=${booking.businessId}`,
          `serviceId=${booking.serviceId}`,
          `date=${date}`,
          `staffId=${booking.staffId}`,
          'intervalMin=',
          `tz=${tz}`,
        );

        const keyNoTz = this.cache.key(
          'availability',
          `businessId=${booking.businessId}`,
          `serviceId=${booking.serviceId}`,
          `date=${date}`,
          `staffId=${booking.staffId}`,
          'intervalMin=',
          'tz=',
        );

        await this.cache.delKeys(keyWithTz, keyNoTz);
      }

      await this.cache.delByPrefix(this.cache.key('availability'));
    } catch {
      // never fail booking flow because of cache invalidation
    }
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

  async create(input: {
    businessId: string;
    customerId: string;
    staffId: string;
    serviceId: string;

    // timezone contract (either startAt OR startLocal+tz)
    startAt?: string;
    startLocal?: string;
    tz?: string;

    notes?: string;
    locationId?: string;

    actorUserId: string;
    actorRole: ActorRole;
    idempotencyKey?: string;
  }) {
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
        if (existing.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key reused with different request',
          );
        }
        return existing.response;
      }
    }

    const service = await this.prisma.service.findFirst({
      where: {
        id: input.serviceId,
        businessId: input.businessId,
        active: true,
      },
      select: {
        id: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
      },
    });
    if (!service) throw new BadRequestException('Service not found');

    const totalMin =
      service.durationMin + service.bufferBeforeMin + service.bufferAfterMin;
    const end = new Date(start.getTime() + totalMin * 60_000);

    try {
      const created = await this.prisma.booking.create({
        data: {
          businessId: input.businessId,
          customerId: input.customerId,
          staffId: input.staffId,
          serviceId: input.serviceId,
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
          customerId: true,
          locationId: true,
          startAt: true,
          endAt: true,
          status: true,
          createdAt: true,
        },
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

      await this.invalidateAvailabilityCacheForBooking(created, 'Europe/Paris');
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

    // timezone contract (either newStartAt OR newStartLocal+tz)
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
        },
      });

      if (!booking)
        throw new BadRequestException('Booking not found or not reschedulable');

      const operator = isBusinessOperator(input.actorRole);
      const isOwnCustomerBooking = booking.customerId === input.actorUserId;
      if (!operator && !isOwnCustomerBooking) {
        throw new ForbiddenException('Not allowed to reschedule this booking');
      }

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

      const totalMin =
        service.durationMin + service.bufferBeforeMin + service.bufferAfterMin;
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
            customerId: true,
            locationId: true,
            startAt: true,
            endAt: true,
            status: true,
            updatedAt: true,
          },
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

        await this.invalidateAvailabilityCacheForBooking(updated, 'Europe/Paris');
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
        select: { id: true, customerId: true, status: true },
      });
      if (!b) throw new BadRequestException('Booking not found');

      const operator = isBusinessOperator(input.actorRole);
      if (!operator && b.customerId !== input.actorUserId) {
        throw new ForbiddenException('Not allowed to cancel this booking');
      }

      if (b.status === 'CANCELLED')
        return { id: b.id, status: 'CANCELLED' as const };

      if (b.status !== 'PENDING' && b.status !== 'CONFIRMED') {
        throw new BadRequestException('Booking not cancelable');
      }

      return tx.booking.update({
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
        select: { id: true, customerId: true, status: true },
      });
      if (!b) throw new BadRequestException('Booking not found');

      const operator = isBusinessOperator(input.actorRole);
      if (!operator && b.customerId !== input.actorUserId) {
        throw new ForbiddenException('Not allowed to confirm this booking');
      }

      if (b.status === 'CONFIRMED')
        return { id: b.id, status: 'CONFIRMED' as const };

      if (b.status !== 'PENDING')
        throw new BadRequestException('Booking not confirmable');

      return tx.booking.update({
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
      tz = 'Europe/Paris',
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
}
