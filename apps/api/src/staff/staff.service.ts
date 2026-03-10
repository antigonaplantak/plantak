import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';

type BusinessRole = 'OWNER' | 'ADMIN' | 'STAFF';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

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
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    if (!staff) {
      throw new NotFoundException('Staff not found');
    }

    return staff;
  }

  async listForBusiness(userId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, ['OWNER', 'ADMIN', 'STAFF']);

    return this.prisma.staff.findMany({
      where: { businessId },
      select: {
        id: true,
        businessId: true,
        userId: true,
        displayName: true,
        active: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  async getProfile(userId: string, staffId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, ['OWNER', 'ADMIN', 'STAFF']);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    return staff;
  }

  async updateProfile(
    userId: string,
    staffId: string,
    businessId: string,
    dto: UpdateStaffProfileDto,
  ) {
    const role = await this.assertBusinessAccess(userId, businessId, ['OWNER', 'ADMIN', 'STAFF']);
    const staff = await this.getStaffOrThrow(staffId);

    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    if (role === 'STAFF' && staff.userId !== userId) {
      throw new ForbiddenException('Cannot edit another staff profile');
    }

    return this.prisma.staff.update({
      where: { id: staffId },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName }
          : {}),
      },
      select: {
        id: true,
        businessId: true,
        userId: true,
        displayName: true,
        active: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            email: true,
          },
        },
      },
    });
  }

  async getReadiness(userId: string, staffId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, ['OWNER', 'ADMIN', 'STAFF']);

    const staff = await this.getStaffOrThrow(staffId);
    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    const [workingHoursCount, futureTimeOffCount, activeServiceLinks] = await Promise.all([
      this.prisma.workingHour.count({
        where: { staffId },
      }),
      this.prisma.timeOff.count({
        where: {
          staffId,
          endAt: { gte: new Date() },
        },
      }),
      this.prisma.serviceStaff.count({
        where: {
          staffId,
          isActive: true,
        },
      }),
    ]);

    const hasDisplayName = Boolean(String(staff.displayName ?? '').trim());
    const linkedUser = Boolean(staff.userId);

    return {
      id: staff.id,
      businessId: staff.businessId,
      userId: staff.userId,
      email: staff.user?.email ?? null,
      displayName: staff.displayName,
      active: staff.active,
      createdAt: staff.createdAt,
      updatedAt: staff.updatedAt,
      readiness: {
        hasDisplayName,
        linkedUser,
        workingHoursCount,
        futureTimeOffCount,
        activeServiceLinks,
        profileReady: hasDisplayName,
        schedulingBaseReady: workingHoursCount > 0,
      },
    };
  }
}
