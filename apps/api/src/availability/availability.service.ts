import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DateTime } from 'luxon';
import { assertIanaTz, localDateRangeToUtc } from '../common/time/time.util';

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
  const local = DateTime.fromISO(dateYmd, { zone })
    .startOf('day')
    .plus({ minutes });
  return local.toUTC().toJSDate();
}

@Injectable()
export class AvailabilityService {
  constructor(private prisma: PrismaService) {}

  async getAvailability(params: {
    businessId: string;
    serviceId: string;
    date: string; // YYYY-MM-DD (local date in tz)
    staffId?: string;
    intervalMin?: number;
    tz?: string; // IANA
  }): Promise<{
    totalMin: number;
    intervalMin: number;
    results: Array<{ staffId: string; slots: Slot[] }>;
  }> {
    const intervalMin = params.intervalMin ?? 15;
    const tz = params.tz ?? 'Europe/Paris';

    const service = await this.prisma.service.findFirst({
      where: {
        id: params.serviceId,
        businessId: params.businessId,
        active: true,
      },
      select: {
        id: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
      },
    });

    if (!service) throw new NotFoundException('Service not found');

    const totalMin =
      service.durationMin + service.bufferBeforeMin + service.bufferAfterMin;

    const staff = await this.prisma.staff.findMany({
      where: {
        businessId: params.businessId,
        active: true,
        ...(params.staffId ? { id: params.staffId } : {}),
        serviceLinks: { some: { serviceId: params.serviceId } },
      },
      select: { id: true },
    });

    const { dayStartUtc, dayEndUtc, dayOfWeek } = localDateRangeToUtc(
      params.date,
      tz,
    );

    const results: Array<{ staffId: string; slots: Slot[] }> = [];

    for (const s of staff) {
      const working = await this.prisma.workingHour.findMany({
        where: { staffId: s.id, dayOfWeek },
        select: { startMin: true, endMin: true },
      });

      if (!working.length) {
        results.push({ staffId: s.id, slots: [] });
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

      for (const w of working) {
        for (let m = w.startMin; m + totalMin <= w.endMin; m += intervalMin) {
          const slotStartUtc = minutesToDateInTzAsUtc(params.date, m, tz);
          const slotEndUtc = addMinutes(slotStartUtc, totalMin);

          if (
            bookings.some((b) =>
              overlaps(slotStartUtc, slotEndUtc, b.startAt, b.endAt),
            )
          )
            continue;
          if (
            timeOff.some((t) =>
              overlaps(slotStartUtc, slotEndUtc, t.startAt, t.endAt),
            )
          )
            continue;

          slots.push({
            start: slotStartUtc.toISOString(),
            end: slotEndUtc.toISOString(),
          });
        }
      }

      results.push({ staffId: s.id, slots });
    }

    return { totalMin, intervalMin, results };
  }
}
