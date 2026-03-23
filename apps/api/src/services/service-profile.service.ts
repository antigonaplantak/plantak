import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeAddonIds } from '../availability/addon-ids.util';

type ResolvedAddon = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
};

@Injectable()
export class ServiceProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForSelection(input: {
    businessId: string;
    serviceId: string;
    staffId: string;
    variantId?: string;
    addonIds?: string[];
    requireOnlineBookingEnabled?: boolean;
  }) {
    const addonIds = normalizeAddonIds(input.addonIds);
    const requireOnline = input.requireOnlineBookingEnabled !== false;

    const service = await this.prisma.service.findFirst({
      where: {
        id: input.serviceId,
        businessId: input.businessId,
        active: true,
        archivedAt: null,
        ...(requireOnline
          ? {
              visibility: 'PUBLIC',
              onlineBookingEnabled: true,
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        currency: true,
        durationMin: true,
        priceCents: true,
        bufferBeforeMin: true,
        bufferAfterMin: true,
      },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    const [business, staff] = await Promise.all([
      this.prisma.business.findFirst({
        where: { id: input.businessId },
        select: {
          id: true,
        },
      }),
      this.prisma.staff.findFirst({
        where: {
          id: input.staffId,
          businessId: input.businessId,
          active: true,
        },
        select: {
          id: true,
        },
      }),
    ]);

    if (!business) {
      throw new NotFoundException('Business not found');
    }

    if (!staff) {
      throw new BadRequestException('Staff not found');
    }

    const staffAssignment = await this.prisma.serviceStaff.findFirst({
      where: {
        serviceId: input.serviceId,
        staffId: input.staffId,
        isActive: true,
        ...(requireOnline ? { onlineBookingEnabled: true } : {}),
      },
      select: {
        durationMinOverride: true,
        priceCentsOverride: true,
        bufferBeforeMinOverride: true,
        bufferAfterMinOverride: true,
      },
    });

    if (!staffAssignment) {
      throw new BadRequestException('Staff not assigned to service');
    }

    const variant = input.variantId
      ? await this.prisma.serviceVariant.findFirst({
          where: {
            id: input.variantId,
            serviceId: input.serviceId,
            archivedAt: null,
            ...(requireOnline
              ? {
                  visibility: 'PUBLIC',
                  onlineBookingEnabled: true,
                }
              : {}),
          },
          select: {
            id: true,
            name: true,
            durationMin: true,
            priceCents: true,
            bufferBeforeMin: true,
            bufferAfterMin: true,
          },
        })
      : null;

    if (input.variantId && !variant) {
      throw new BadRequestException('Variant not available');
    }

    let durationMin = variant?.durationMin ?? service.durationMin;
    let priceCents = variant?.priceCents ?? service.priceCents;
    let bufferBeforeMin = variant?.bufferBeforeMin ?? service.bufferBeforeMin;
    let bufferAfterMin = variant?.bufferAfterMin ?? service.bufferAfterMin;

    if (staffAssignment.durationMinOverride !== null) {
      durationMin = staffAssignment.durationMinOverride;
    }
    if (staffAssignment.priceCentsOverride !== null) {
      priceCents = staffAssignment.priceCentsOverride;
    }
    if (staffAssignment.bufferBeforeMinOverride !== null) {
      bufferBeforeMin = staffAssignment.bufferBeforeMinOverride;
    }
    if (staffAssignment.bufferAfterMinOverride !== null) {
      bufferAfterMin = staffAssignment.bufferAfterMinOverride;
    }

    let addons: ResolvedAddon[] = [];
    if (addonIds.length) {
      const rows = await this.prisma.serviceAddon.findMany({
        where: {
          id: { in: addonIds },
          serviceId: input.serviceId,
          archivedAt: null,
          ...(requireOnline
            ? {
                visibility: 'PUBLIC',
                onlineBookingEnabled: true,
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          durationMin: true,
          priceCents: true,
          bufferBeforeMin: true,
          bufferAfterMin: true,
        },
      });

      if (rows.length !== addonIds.length) {
        throw new BadRequestException('One or more addons not available');
      }

      const byId = new Map(rows.map((x) => [x.id, x]));
      addons = addonIds.map((id) => {
        const row = byId.get(id);
        if (!row)
          throw new BadRequestException('One or more addons not available');
        return row;
      });
    }

    const addonDurationMin = addons.reduce((sum, x) => sum + x.durationMin, 0);
    const addonPriceCents = addons.reduce((sum, x) => sum + x.priceCents, 0);
    const addonBufferBeforeMin = addons.reduce(
      (sum, x) => sum + x.bufferBeforeMin,
      0,
    );
    const addonBufferAfterMin = addons.reduce(
      (sum, x) => sum + x.bufferAfterMin,
      0,
    );

    const finalDurationMin = durationMin + addonDurationMin;
    const finalPriceCents = priceCents + addonPriceCents;
    const finalBufferBeforeMin = bufferBeforeMin + addonBufferBeforeMin;
    const finalBufferAfterMin = bufferAfterMin + addonBufferAfterMin;
    const totalMin =
      finalDurationMin + finalBufferBeforeMin + finalBufferAfterMin;


    return {
      serviceId: service.id,
      serviceName: service.name,
      currency: service.currency,
      serviceVariantId: variant?.id ?? null,
      serviceVariantName: variant?.name ?? null,
      addonIds,
      addons,
      durationMin: finalDurationMin,
      priceCents: finalPriceCents,
      bufferBeforeMin: finalBufferBeforeMin,
      bufferAfterMin: finalBufferAfterMin,
      totalMin,
      amountTotalCents: finalPriceCents,
    };
  }
}
