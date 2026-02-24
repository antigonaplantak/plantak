import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async create(businessId: string, dto: CreateServiceDto) {
    return this.prisma.service.create({
      data: {
        businessId,
        name: dto.name,
        durationMin: dto.durationMin,
        bufferBeforeMin: dto.bufferBeforeMin ?? 0,
        bufferAfterMin: dto.bufferAfterMin ?? 0,
        priceCents: dto.priceCents ?? 0,
        currency: dto.currency ?? 'EUR',
        isActive: dto.isActive ?? true,
      },
      select: {
        id: true,
        name: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
        priceCents: true,
        currency: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async list(businessId: string, includeInactive = false) {
    return this.prisma.service.findMany({
      where: {
        businessId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
        priceCents: true,
        currency: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async get(businessId: string, serviceId: string) {
    const svc = await this.prisma.service.findFirst({
      where: { id: serviceId, businessId },
      select: {
        id: true,
        name: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
        priceCents: true,
        currency: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!svc) throw new NotFoundException('Service not found');
    return svc;
  }

  async update(businessId: string, serviceId: string, dto: UpdateServiceDto) {
    // 10/10 isolation: first check it belongs to the business
    const exists = await this.prisma.service.findFirst({
      where: { id: serviceId, businessId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Service not found');

    return this.prisma.service.update({
      where: { id: serviceId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.durationMin !== undefined
          ? { durationMin: dto.durationMin }
          : {}),
        ...(dto.bufferBeforeMin !== undefined
          ? { bufferBeforeMin: dto.bufferBeforeMin }
          : {}),
        ...(dto.bufferAfterMin !== undefined
          ? { bufferAfterMin: dto.bufferAfterMin }
          : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: {
        id: true,
        name: true,
        durationMin: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
        priceCents: true,
        currency: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async status(businessId: string, serviceId: string, isActive: boolean) {
    const exists = await this.prisma.service.findFirst({
      where: { id: serviceId, businessId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Service not found');

    return this.prisma.service.update({
      where: { id: serviceId },
      data: { isActive },
      select: { id: true, isActive: true, updatedAt: true },
    });
  }

  // placeholders (do implementohen kur të vijmë te staff_services)
  async replaceStaffServices(
    _businessId: string,
    _staffId: string,
    _body: any,
  ) {
    throw new ForbiddenException('Not implemented yet');
  }
  async staffServices(_businessId: string, _staffId: string) {
    throw new ForbiddenException('Not implemented yet');
  }
}
