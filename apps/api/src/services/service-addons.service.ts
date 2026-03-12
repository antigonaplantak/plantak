import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceAddonDto } from './dto/create-service-addon.dto';
import { UpdateServiceAddonDto } from './dto/update-service-addon.dto';

@Injectable()
export class ServiceAddonsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getServiceOrThrow(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, businessId: true, archivedAt: true },
    });
    if (!service || service.archivedAt)
      throw new NotFoundException('Service not found');
    return service;
  }

  private async assertBusinessAccess(
    userId: string,
    businessId: string,
    allowed: Array<'OWNER' | 'ADMIN' | 'STAFF'>,
  ) {
    const member = await this.prisma.businessMember.findFirst({
      where: { businessId, userId },
      select: { role: true },
    });
    if (!member) throw new ForbiddenException('No business access');
    if (!allowed.includes(member.role))
      throw new ForbiddenException('Insufficient role');
  }

  async create(userId: string, serviceId: string, dto: CreateServiceAddonDto) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    return this.prisma.serviceAddon.create({
      data: {
        serviceId,
        name: dto.name,
        durationMin: dto.durationMin ?? 0,
        priceCents: dto.priceCents,
        bufferBeforeMin: dto.bufferBeforeMin ?? 0,
        bufferAfterMin: dto.bufferAfterMin ?? 0,
        visibility: dto.visibility ?? 'PUBLIC',
        onlineBookingEnabled: dto.onlineBookingEnabled ?? true,
        position: dto.position ?? 0,
      },
    });
  }

  async list(userId: string, serviceId: string) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);
    return this.prisma.serviceAddon.findMany({
      where: { serviceId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async update(
    userId: string,
    serviceId: string,
    addonId: string,
    dto: UpdateServiceAddonDto,
  ) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);

    const existing = await this.prisma.serviceAddon.findFirst({
      where: { id: addonId, serviceId, archivedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Addon not found');

    return this.prisma.serviceAddon.update({
      where: { id: addonId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.durationMin !== undefined
          ? { durationMin: dto.durationMin }
          : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.bufferBeforeMin !== undefined
          ? { bufferBeforeMin: dto.bufferBeforeMin }
          : {}),
        ...(dto.bufferAfterMin !== undefined
          ? { bufferAfterMin: dto.bufferAfterMin }
          : {}),
        ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
        ...(dto.onlineBookingEnabled !== undefined
          ? { onlineBookingEnabled: dto.onlineBookingEnabled }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
    });
  }

  async archive(userId: string, serviceId: string, addonId: string) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);

    const existing = await this.prisma.serviceAddon.findFirst({
      where: { id: addonId, serviceId, archivedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Addon not found');

    return this.prisma.serviceAddon.update({
      where: { id: addonId },
      data: { archivedAt: new Date() },
    });
  }
}
