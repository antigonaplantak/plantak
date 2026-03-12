import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceVariantDto } from './dto/create-service-variant.dto';
import { UpdateServiceVariantDto } from './dto/update-service-variant.dto';

@Injectable()
export class ServiceVariantsService {
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
    if (!allowed.includes(member.role as any))
      throw new ForbiddenException('Insufficient role');
  }

  async create(
    userId: string,
    serviceId: string,
    dto: CreateServiceVariantDto,
  ) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    return this.prisma.serviceVariant.create({
      data: {
        serviceId,
        name: dto.name,
        durationMin: dto.durationMin,
        priceCents: dto.priceCents,
        bufferBeforeMin: dto.bufferBeforeMin ?? 0,
        bufferAfterMin: dto.bufferAfterMin ?? 0,
        visibility: (dto.visibility as any) ?? 'PUBLIC',
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
    return this.prisma.serviceVariant.findMany({
      where: { serviceId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async update(
    userId: string,
    serviceId: string,
    variantId: string,
    dto: UpdateServiceVariantDto,
  ) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);

    const existing = await this.prisma.serviceVariant.findFirst({
      where: { id: variantId, serviceId, archivedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Variant not found');

    return this.prisma.serviceVariant.update({
      where: { id: variantId },
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
        ...(dto.visibility !== undefined
          ? { visibility: dto.visibility as any }
          : {}),
        ...(dto.onlineBookingEnabled !== undefined
          ? { onlineBookingEnabled: dto.onlineBookingEnabled }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
    });
  }

  async archive(userId: string, serviceId: string, variantId: string) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
    ]);

    const existing = await this.prisma.serviceVariant.findFirst({
      where: { id: variantId, serviceId, archivedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Variant not found');

    return this.prisma.serviceVariant.update({
      where: { id: variantId },
      data: { archivedAt: new Date() },
    });
  }
}
