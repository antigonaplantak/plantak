import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import { assertIanaTz, localDateRangeToUtc } from '../common/time/time.util';
import { ServiceProfileService } from '../services/service-profile.service';
import { normalizeAddonIds } from './addon-ids.util';

type Slot = { start: string; end: string };

function addMinutes(d: Date, mins: number) {
  return new Date(d.getTime() + mins * 60_000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

function minutesToDateInTzAsUtc(
  dateYmd: string,
  minutes: number,
  tz: string,
): Date {
  const zone = assertIanaTz(tz);
  const base = DateTime.fromISO(dateYmd, { zone });

  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  const local = DateTime.fromObject(
    {
      year: base.year,
      month: base.month,
      day: base.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    { zone },
  );

  return local.toUTC().toJSDate();
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serviceProfiles: ServiceProfileService,
  ) {}

  async getAvailability(params: {
    businessId: string;
    serviceId: string;
    variantId?: string;
    addonIds?: string[];
    date: string;
    staffId?: string;
    intervalMin?: number;
    tz?: string;
  }): Promise<{
    totalMin: number | null;
    intervalMin: number;
    results: Array<{ staffId: string; totalMin: number; slots: Slot[] }>;
  }> {
    const intervalMin = params.intervalMin ?? 15;
    const tz = params.tz ?? 'UTC';
    const normalizedAddonIds = normalizeAddonIds(params.addonIds);

    const staff = await this.prisma.staff.findMany({
      where: {
        businessId: params.businessId,
        active: true,
        ...(params.staffId ? { id: params.staffId } : {}),
        serviceLinks: {
          some: {
            serviceId: params.serviceId,
            isActive: true,
            onlineBookingEnabled: true,
          },
        },
      },
      select: { id: true },
    });

    const { dayStartUtc, dayEndUtc, dayOfWeek } = localDateRangeToUtc(
      params.date,
      tz,
    );

    const results: Array<{ staffId: string; totalMin: number; slots: Slot[] }> = [];

    for (const s of staff) {
      const profile = await this.serviceProfiles.resolveForSelection({
        businessId: params.businessId,
        serviceId: params.serviceId,
        staffId: s.id,
        variantId: params.variantId,
        addonIds: normalizedAddonIds,
        requireOnlineBookingEnabled: true,
      });

      const totalMin = profile.totalMin;

      const working = await this.prisma.workingHour.findMany({
        where: { staffId: s.id, dayOfWeek },
        select: { startMin: true, endMin: true },
      });

      if (!working.length) {
        results.push({ staffId: s.id, totalMin, slots: [] });
        continue;
      }

      const bookings = await this.prisma.booking.findMany({
        where: {
          staffId: s.id,
          startAt: { lt: dayEndUtc },
          endAt: { gt: dayStartUtc },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        select: { startAt: true, endAt: true },
      });

      const timeOff = await this.prisma.timeOff.findMany({
        where: {
          staffId: s.id,
          startAt: { lt: dayEndUtc },
          endAt: { gt: dayStartUtc },
        },
        select: { startAt: true, endAt: true },
      });

      const slots: Slot[] = [];
      const seenStarts = new Set<string>();

      for (const w of working) {
        const windowStartUtc = minutesToDateInTzAsUtc(
          params.date,
          w.startMin,
          tz,
        );
        const windowEndUtc = minutesToDateInTzAsUtc(
          params.date,
          w.endMin,
          tz,
        );

        for (
          let cur = new Date(windowStartUtc.getTime());
          addMinutes(cur, totalMin) <= windowEndUtc;
          cur = addMinutes(cur, intervalMin)
        ) {
          const slotStartUtc = new Date(cur.getTime());
          const slotEndUtc = addMinutes(slotStartUtc, totalMin);
          const slotKey = slotStartUtc.toISOString();

          if (seenStarts.has(slotKey)) {
            continue;
          }

          if (
            bookings.some((b) =>
              overlaps(slotStartUtc, slotEndUtc, b.startAt, b.endAt),
            )
          ) {
            continue;
          }

          if (
            timeOff.some((t) =>
              overlaps(slotStartUtc, slotEndUtc, t.startAt, t.endAt),
            )
          ) {
            continue;
          }

          seenStarts.add(slotKey);
          slots.push({
            start: slotStartUtc.toISOString(),
            end: slotEndUtc.toISOString(),
          });
        }
      }

      results.push({ staffId: s.id, totalMin, slots });
    }

    return {
      totalMin: results[0]?.totalMin ?? null,
      intervalMin,
      results,
    };
  }
}
