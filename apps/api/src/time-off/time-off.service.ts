import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCacheService } from '../infra/redis-cache.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { UpdateTimeOffDto } from './dto/update-time-off.dto';

type BusinessRole = 'OWNER' | 'ADMIN' | 'STAFF';

@Injectable()
export class TimeOffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  private async assertBusinessAccess(
    userId: string,
    businessId: string,
    allowed: BusinessRole[],
  ) {
    const member = await this.prisma.businessMember.findFirst({
      where: { businessId, userId },
      select: { role: true },
    });

    if (!member) {
      throw new ForbiddenException('No business access');
    }

    const role = member.role as BusinessRole;
    if (!allowed.includes(role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return role;
  }

  private async getStaffOrThrow(staffId: string) {
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        businessId: true,
        userId: true,
        displayName: true,
        active: true,
      },
    });

    if (!staff) {
      throw new NotFoundException('Staff not found');
    }

    return staff;
  }

  private parseRange(startAt?: string, endAt?: string) {
    const start = startAt ? new Date(startAt) : undefined;
    const end = endAt ? new Date(endAt) : undefined;

    if (startAt && (!start || Number.isNaN(start.getTime()))) {
      throw new BadRequestException('startAt invalid');
    }

    if (endAt && (!end || Number.isNaN(end.getTime()))) {
      throw new BadRequestException('endAt invalid');
    }

    if (start && end && end <= start) {
      throw new BadRequestException('endAt must be greater than startAt');
    }

    return { start, end };
  }

  private async invalidateAvailabilityCache() {
    await this.cache.delByPrefix(this.cache.key('availability'));
  }

  async list(userId: string, staffId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    return this.prisma.timeOff.findMany({
      where: { staffId },
      select: {
        id: true,
        staffId: true,
        startAt: true,
        endAt: true,
        reason: true,
        createdAt: true,
      },
      orderBy: [{ startAt: 'asc' }, { endAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: string, staffId: string, dto: CreateTimeOffDto) {
    const role = await this.assertBusinessAccess(userId, dto.businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== dto.businessId) {
      throw new ForbiddenException('Forbidden');
    }

    if (role === 'STAFF' && staff.userId !== userId) {
      throw new ForbiddenException('Cannot create time off for another staff');
    }

    const { start, end } = this.parseRange(dto.startAt, dto.endAt);

    const created = await this.prisma.timeOff.create({
      data: {
        staffId,
        startAt: start!,
        endAt: end!,
        reason: dto.reason?.trim() || null,
      },
      select: {
        id: true,
        staffId: true,
        startAt: true,
        endAt: true,
        reason: true,
        createdAt: true,
      },
    });

    await this.invalidateAvailabilityCache();
    return created;
  }

  async update(
    userId: string,
    staffId: string,
    timeOffId: string,
    dto: UpdateTimeOffDto,
  ) {
    const businessId = String(dto.businessId ?? '');
    if (!businessId) {
      throw new BadRequestException('businessId is required');
    }

    const role = await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    if (role === 'STAFF' && staff.userId !== userId) {
      throw new ForbiddenException('Cannot update time off for another staff');
    }

    const existing = await this.prisma.timeOff.findFirst({
      where: { id: timeOffId, staffId },
      select: { id: true, startAt: true, endAt: true },
    });

    if (!existing) {
      throw new NotFoundException('Time off not found');
    }

    const nextStartAt = dto.startAt ?? existing.startAt.toISOString();
    const nextEndAt = dto.endAt ?? existing.endAt.toISOString();
    const { start, end } = this.parseRange(nextStartAt, nextEndAt);

    const updated = await this.prisma.timeOff.update({
      where: { id: timeOffId },
      data: {
        startAt: start!,
        endAt: end!,
        ...(dto.reason !== undefined
          ? { reason: dto.reason?.trim() || null }
          : {}),
      },
      select: {
        id: true,
        staffId: true,
        startAt: true,
        endAt: true,
        reason: true,
        createdAt: true,
      },
    });

    await this.invalidateAvailabilityCache();
    return updated;
  }

  async remove(
    userId: string,
    staffId: string,
    timeOffId: string,
    businessId: string,
  ) {
    const role = await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    if (role === 'STAFF' && staff.userId !== userId) {
      throw new ForbiddenException('Cannot delete time off for another staff');
    }

    const existing = await this.prisma.timeOff.findFirst({
      where: { id: timeOffId, staffId },
      select: {
        id: true,
        staffId: true,
        startAt: true,
        endAt: true,
        reason: true,
        createdAt: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Time off not found');
    }

    await this.prisma.timeOff.delete({
      where: { id: timeOffId },
    });

    await this.invalidateAvailabilityCache();

    return {
      ok: true,
      deleted: existing,
    };
  }
}
