import { BadRequestException } from '@nestjs/common';
import { DateTime, IANAZone } from 'luxon';

export function assertIanaTz(tz: string): string {
  if (!tz || typeof tz !== 'string')
    throw new BadRequestException('tz is required');
  if (!IANAZone.isValidZone(tz)) throw new BadRequestException('tz invalid');
  return tz;
}

export function parseStartToUtc(input: {
  startAt?: string; // ISO with timezone (Z or +02:00)
  startLocal?: string; // "YYYY-MM-DDTHH:mm"
  tz?: string; // IANA, e.g. "UTC"
}): Date {
  if (input.startAt) {
    const d = new Date(input.startAt);
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException('startAt invalid');
    return d;
  }

  const tz = assertIanaTz(input.tz ?? '');
  const startLocal = input.startLocal ?? '';
  const dt = DateTime.fromISO(startLocal, { zone: tz });
  if (!dt.isValid) throw new BadRequestException('startLocal invalid');

  return dt.toUTC().toJSDate();
}

export function localDateRangeToUtc(
  dateYmd: string, // YYYY-MM-DD (local date)
  tz: string,
): { dayStartUtc: Date; dayEndUtc: Date; dayOfWeek: number } {
  const zone = assertIanaTz(tz);
  const localDayStart = DateTime.fromISO(dateYmd, { zone }).startOf('day');
  if (!localDayStart.isValid) throw new BadRequestException('date invalid');

  const localDayEnd = localDayStart.endOf('day');

  // Luxon weekday: 1..7 (Mon..Sun) => convert to 0..6 (Sun..Sat)
  const dayOfWeek = localDayStart.weekday % 7;

  return {
    dayStartUtc: localDayStart.toUTC().toJSDate(),
    dayEndUtc: localDayEnd.toUTC().toJSDate(),
    dayOfWeek,
  };
}

export function parseMaybeLocalToUtc(
  value?: string,
  tz?: string,
): Date | undefined {
  if (!value) return undefined;

  // If includes timezone info treat as absolute ISO
  if (value.includes('Z') || value.includes('+') || value.includes('-')) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException('from/to invalid');
    return d;
  }

  // Otherwise treat as local ISO "YYYY-MM-DDTHH:mm"
  return parseStartToUtc({ startLocal: value, tz });
}
