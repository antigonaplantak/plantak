import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { RedisCacheService } from "../infra/redis-cache.service";
import { AvailabilityService } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@ApiTags('Availability')
@Controller('availability')
export class AvailabilityController {
  constructor(
    private readonly availabilityService: AvailabilityService,
    private readonly cache: RedisCacheService,
  ) {}

  @Get()
  @ApiQuery({ name: 'businessId', required: true, type: String })
  @ApiQuery({ name: 'serviceId', required: true, type: String })
  @ApiQuery({ name: 'variantId', required: false, type: String })
  @ApiQuery({ name: 'addonIds', required: false, type: String, example: 'id1,id2' })
  @ApiQuery({
    name: 'date',
    required: true,
    type: String,
    example: '2026-03-02',
  })
  @ApiQuery({ name: 'staffId', required: false, type: String })
  @ApiQuery({ name: 'intervalMin', required: false, type: Number, example: 15 })
  @ApiQuery({
    name: 'tz',
    required: false,
    type: String,
    example: 'Europe/Paris',
  })
  async getAvailability(@Query() q: AvailabilityQueryDto) {
    const addonIdsKey = (q.addonIds ?? []).slice().sort().join(',');

    const cacheKey = this.cache.key(
      "availability",
      `businessId=${q.businessId}`,
      `serviceId=${q.serviceId}`,
      `variantId=${q.variantId ?? ""}`,
      `addonIds=${addonIdsKey}`,
      `date=${q.date}`,
      `staffId=${q.staffId ?? ""}`,
      `intervalMin=${q.intervalMin ?? ""}`,
      `tz=${q.tz ?? ""}`,
    );

    const cached = await this.cache.getJson<any>(cacheKey);
    if (cached) return cached;

    const result = await this.availabilityService.getAvailability({
      businessId: q.businessId,
      serviceId: q.serviceId,
      variantId: q.variantId,
      addonIds: q.addonIds,
      date: q.date,
      staffId: q.staffId,
      intervalMin: q.intervalMin,
      tz: q.tz,
    });

    await this.cache.setJson(
      cacheKey,
      result,
      Number(process.env.CACHE_TTL_AVAILABILITY_SEC ?? 20),
    );

    return result;
  }
}
