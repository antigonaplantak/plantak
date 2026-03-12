import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCacheService } from '../infra/redis-cache.service';
import { ReplaceWorkingHoursDto } from './dto/replace-working-hours.dto';

type BusinessRole = 'OWNER' | 'ADMIN' | 'STAFF';

type WorkingHourShape = {
  dayOfWeek: number;
  startMin: number;
  endMin: number;
};

@Injectable()
export class WorkingHoursService {
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

  private validateItems(items: WorkingHourShape[]) {
    for (const item of items) {
      if (item.endMin <= item.startMin) {
        throw new BadRequestException('endMin must be greater than startMin');
      }
    }

    const byDay = new Map<number, WorkingHourShape[]>();
    for (const item of items) {
      const arr = byDay.get(item.dayOfWeek) ?? [];
      arr.push(item);
      byDay.set(item.dayOfWeek, arr);
    }

    for (const [day, arr] of byDay.entries()) {
      arr.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

      for (let i = 0; i < arr.length; i++) {
        const cur = arr[i];
        if (cur.startMin < 0 || cur.endMin > 1440) {
          throw new BadRequestException(`Invalid minute range on day ${day}`);
        }

        if (i === 0) continue;
        const prev = arr[i - 1];
        if (cur.startMin < prev.endMin) {
          throw new BadRequestException(`Working hour overlap on day ${day}`);
        }
      }
    }
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

    return this.prisma.workingHour.findMany({
      where: { staffId },
      select: {
        id: true,
        staffId: true,
        dayOfWeek: true,
        startMin: true,
        endMin: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startMin: 'asc' }, { endMin: 'asc' }],
    });
  }

  async replace(userId: string, staffId: string, dto: ReplaceWorkingHoursDto) {
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
      throw new ForbiddenException('Cannot edit another staff working hours');
    }

    this.validateItems(dto.items);

    await this.prisma.$transaction(async (tx) => {
      await tx.workingHour.deleteMany({
        where: { staffId },
      });

      if (dto.items.length) {
        await tx.workingHour.createMany({
          data: dto.items.map((item) => ({
            staffId,
            dayOfWeek: item.dayOfWeek,
            startMin: item.startMin,
            endMin: item.endMin,
          })),
        });
      }
    });

    await this.invalidateAvailabilityCache();

    return {
      ok: true,
      staffId,
      replacedCount: dto.items.length,
      items: await this.prisma.workingHour.findMany({
        where: { staffId },
        select: {
          id: true,
          staffId: true,
          dayOfWeek: true,
          startMin: true,
          endMin: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startMin: 'asc' }, { endMin: 'asc' }],
      }),
    };
  }
}
