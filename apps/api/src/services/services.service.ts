import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCacheService } from '../infra/redis-cache.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { CreateServiceCategoryDto } from '../service-categories/dto/create-service-category.dto';
import { UpdateServiceCategoryDto } from '../service-categories/dto/update-service-category.dto';
import { SetServiceStatusDto } from './dto/set-service-status.dto';
import { ReplaceStaffServicesDto } from './dto/replace-staff-services.dto';

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  private publicTtlSec() {
    return Number(process.env.CACHE_TTL_PUBLIC_SEC ?? 60);
  }

  private async bustPublicCache(businessId: string) {
    await this.cache.delKeys(
      this.cache.key('public', 'service-categories', businessId),
      this.cache.key('public', 'services', businessId),
    );
  }

  private async memberRole(userId: string, businessId: string) {
    const member = await this.prisma.businessMember.findFirst({
      where: { businessId, userId },
      select: { role: true },
    });
    if (!member) throw new ForbiddenException('No business access');
    return member.role as 'OWNER' | 'ADMIN' | 'STAFF';
  }

  async assertBusinessAccess(
    userId: string,
    businessId: string,
    allowed: Array<'OWNER' | 'ADMIN' | 'STAFF'>,
  ) {
    const role = await this.memberRole(userId, businessId);
    if (!allowed.includes(role))
      throw new ForbiddenException('Insufficient role');
    return role;
  }

  private async getServiceOrThrow(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        businessId: true,
        categoryId: true,
        archivedAt: true,
      },
    });
    if (!service || service.archivedAt)
      throw new NotFoundException('Service not found');
    return service;
  }

  async createCategory(userId: string, dto: CreateServiceCategoryDto) {
    await this.assertBusinessAccess(userId, dto.businessId, ['OWNER', 'ADMIN']);
    const created = await this.prisma.serviceCategory.create({
      data: {
        businessId: dto.businessId,
        name: dto.name,
        position: dto.position ?? 0,
        isPinned: dto.isPinned ?? false,
        isVisible: dto.isVisible ?? true,
      },
    });
    await this.bustPublicCache(dto.businessId);
    return created;
  }

  async listCategories(userId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);
    return this.prisma.serviceCategory.findMany({
      where: { businessId, archivedAt: null },
      orderBy: [
        { isPinned: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  async listPublicCategories(businessId: string) {
    const key = this.cache.key('public', 'service-categories', businessId);
    const cached = await this.cache.getJson<any[]>(key);
    if (cached) return cached;

    const data = await this.prisma.serviceCategory.findMany({
      where: { businessId, archivedAt: null, isVisible: true },
      orderBy: [
        { isPinned: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    await this.cache.setJson(key, data, this.publicTtlSec());
    return data;
  }

  async updateCategory(
    userId: string,
    id: string,
    dto: UpdateServiceCategoryDto,
  ) {
    const existing = await this.prisma.serviceCategory.findUnique({
      where: { id },
    });
    if (!existing || existing.archivedAt)
      throw new NotFoundException('Category not found');
    await this.assertBusinessAccess(userId, existing.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    const updated = await this.prisma.serviceCategory.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
        ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
      },
    });
    await this.bustPublicCache(existing.businessId);
    return updated;
  }

  async archiveCategory(userId: string, id: string) {
    const existing = await this.prisma.serviceCategory.findUnique({
      where: { id },
    });
    if (!existing || existing.archivedAt)
      throw new NotFoundException('Category not found');
    await this.assertBusinessAccess(userId, existing.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    const archived = await this.prisma.serviceCategory.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await this.bustPublicCache(existing.businessId);
    return archived;
  }

  async createService(userId: string, dto: CreateServiceDto) {
    await this.assertBusinessAccess(userId, dto.businessId, ['OWNER', 'ADMIN']);
    const created = await this.prisma.service.create({
      data: {
        businessId: dto.businessId,
        categoryId: dto.categoryId ?? null,
        name: dto.name,
        description: dto.description ?? null,
        durationMin: dto.durationMin,
        priceCents: dto.priceCents,
        currency: dto.currency ?? 'EUR',
        bufferBeforeMin: dto.bufferBeforeMin ?? 0,
        bufferAfterMin: dto.bufferAfterMin ?? 0,
        visibility: (dto.visibility as any) ?? 'PUBLIC',
        onlineBookingEnabled: dto.onlineBookingEnabled ?? true,
        isPinned: dto.isPinned ?? false,
        position: dto.position ?? 0,
        color: dto.color ?? null,
      },
    });
    await this.bustPublicCache(dto.businessId);
    return created;
  }

  async listAdminServices(userId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);
    return this.prisma.service.findMany({
      where: { businessId, archivedAt: null },
      include: {
        category: true,
        variants: {
          where: { archivedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
        addons: {
          where: { archivedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [
        { isPinned: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  async listPublicServices(businessId: string) {
    const key = this.cache.key('public', 'services', businessId);
    const cached = await this.cache.getJson<any[]>(key);
    if (cached) return cached;

    const data = await this.prisma.service.findMany({
      where: {
        businessId,
        archivedAt: null,
        visibility: 'PUBLIC',
        onlineBookingEnabled: true,
      },
      include: {
        category: true,
        variants: {
          where: {
            archivedAt: null,
            visibility: 'PUBLIC',
            onlineBookingEnabled: true,
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
        addons: {
          where: {
            archivedAt: null,
            visibility: 'PUBLIC',
            onlineBookingEnabled: true,
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        },
      },
      orderBy: [
        { isPinned: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    await this.cache.setJson(key, data, this.publicTtlSec());
    return data;
  }

  async getService(userId: string, serviceId: string) {
    const service = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, service.businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const base = await this.prisma.service.findUnique({
      where: { id: serviceId },
    });
    if (!base) throw new NotFoundException('Service not found');

    const [category, variants, addons, staffAssignments] = await Promise.all([
      base.categoryId
        ? this.prisma.serviceCategory.findUnique({
            where: { id: base.categoryId },
          })
        : Promise.resolve(null),
      this.prisma.serviceVariant.findMany({
        where: { serviceId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.serviceAddon.findMany({
        where: { serviceId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.serviceStaff.findMany({
        where: { serviceId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      ...base,
      category,
      variants,
      addons,
      staffAssignments,
    };
  }

  async updateService(
    userId: string,
    serviceId: string,
    dto: UpdateServiceDto,
  ) {
    const existing = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, existing.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: {
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.durationMin !== undefined
          ? { durationMin: dto.durationMin }
          : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
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
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
      },
    });
    await this.bustPublicCache(existing.businessId);
    return updated;
  }

  async setServiceStatus(
    userId: string,
    serviceId: string,
    dto: SetServiceStatusDto,
  ) {
    const existing = await this.getServiceOrThrow(serviceId);
    await this.assertBusinessAccess(userId, existing.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    const updated = await this.prisma.service.update({
      where: { id: serviceId },
      data: {
        ...(dto.visibility !== undefined
          ? { visibility: dto.visibility as any }
          : {}),
        ...(dto.onlineBookingEnabled !== undefined
          ? { onlineBookingEnabled: dto.onlineBookingEnabled }
          : {}),
        ...(dto.archived !== undefined
          ? { archivedAt: dto.archived ? new Date() : null }
          : {}),
      },
    });
    await this.bustPublicCache(existing.businessId);
    return updated;
  }

  async archiveService(userId: string, id: string) {
    const existing = await this.getServiceOrThrow(id);
    await this.assertBusinessAccess(userId, existing.businessId, [
      'OWNER',
      'ADMIN',
    ]);
    const archived = await this.prisma.service.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    await this.bustPublicCache(existing.businessId);
    return archived;
  }

  async replaceStaffServices(
    userId: string,
    staffId: string,
    dto: ReplaceStaffServicesDto,
  ) {
    await this.assertBusinessAccess(userId, dto.businessId, ['OWNER', 'ADMIN']);

    const staff = await this.prisma.staff.findFirst({
      where: { id: staffId, businessId: dto.businessId },
      select: { id: true, businessId: true },
    });
    if (!staff) throw new NotFoundException('Staff not found');

    const serviceIds = [...new Set(dto.items.map((x) => x.serviceId))];
    const services = await this.prisma.service.findMany({
      where: {
        id: { in: serviceIds },
        businessId: dto.businessId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (services.length !== serviceIds.length) {
      throw new NotFoundException('One or more services not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceStaff.deleteMany({
        where: { staffId, serviceId: { notIn: serviceIds } },
      });

      for (const item of dto.items) {
        await tx.serviceStaff.upsert({
          where: {
            serviceId_staffId: {
              serviceId: item.serviceId,
              staffId,
            },
          },
          create: {
            serviceId: item.serviceId,
            staffId,
            isActive: item.isActive ?? true,
            onlineBookingEnabled: item.onlineBookingEnabled ?? true,
            durationMinOverride: item.durationMinOverride ?? null,
            priceCentsOverride: item.priceCentsOverride ?? null,
            bufferBeforeMinOverride: item.bufferBeforeMinOverride ?? null,
            bufferAfterMinOverride: item.bufferAfterMinOverride ?? null,
          },
          update: {
            isActive: item.isActive ?? true,
            onlineBookingEnabled: item.onlineBookingEnabled ?? true,
            durationMinOverride: item.durationMinOverride ?? null,
            priceCentsOverride: item.priceCentsOverride ?? null,
            bufferBeforeMinOverride: item.bufferBeforeMinOverride ?? null,
            bufferAfterMinOverride: item.bufferAfterMinOverride ?? null,
          },
        });
      }
    });

    await this.bustPublicCache(dto.businessId);

    const assignments = await this.prisma.serviceStaff.findMany({
      where: { staffId },
      orderBy: { createdAt: 'asc' },
    });

    const assignedServiceIds = assignments.map((x) => x.serviceId);
    const assignedServices = assignedServiceIds.length
      ? await this.prisma.service.findMany({
          where: { id: { in: assignedServiceIds } },
          include: { category: true },
        })
      : [];

    const serviceMap = new Map(assignedServices.map((s) => [s.id, s]));
    return assignments.map((a) => ({
      ...a,
      service: serviceMap.get(a.serviceId) ?? null,
    }));
  }

  async listStaffServices(userId: string, staffId: string, businessId: string) {
    await this.assertBusinessAccess(userId, businessId, [
      'OWNER',
      'ADMIN',
      'STAFF',
    ]);

    const staff = await this.prisma.staff.findFirst({
      where: { id: staffId, businessId },
      select: { id: true },
    });
    if (!staff) throw new NotFoundException('Staff not found');

    const assignments = await this.prisma.serviceStaff.findMany({
      where: { staffId },
      orderBy: { createdAt: 'asc' },
    });

    const serviceIds = assignments.map((x) => x.serviceId);
    const services = serviceIds.length
      ? await this.prisma.service.findMany({
          where: {
            id: { in: serviceIds },
            businessId,
            archivedAt: null,
          },
          include: {
            category: true,
            variants: {
              where: { archivedAt: null },
              orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            },
            addons: {
              where: { archivedAt: null },
              orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            },
          },
        })
      : [];

    const serviceMap = new Map(services.map((s) => [s.id, s]));

    return assignments
      .filter((a) => serviceMap.has(a.serviceId))
      .map((a) => ({
        ...a,
        service: serviceMap.get(a.serviceId),
      }));
  }
}
