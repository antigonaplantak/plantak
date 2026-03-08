import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  private async getStaffOrThrow(staffId: string) {
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        businessId: true,
        userId: true,
        displayName: true,
      },
    });

    if (!staff) {
      throw new NotFoundException('Staff not found');
    }

    return staff;
  }

  async getProfile(staffId: string, businessId: string) {
    const staff = await this.getStaffOrThrow(staffId);

    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
    }

    return staff;
  }

  async updateProfile(
    staffId: string,
    businessId: string,
    dto: UpdateStaffProfileDto,
  ) {
    const staff = await this.getStaffOrThrow(staffId);

    if (staff.businessId !== businessId) {
      throw new ForbiddenException('Forbidden');
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
      },
    });
  }
}
