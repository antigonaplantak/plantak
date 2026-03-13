import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisCacheModule } from '../infra/redis-cache.module';
import { ServicesService } from './services.service';
import { ServiceVariantsService } from './service-variants.service';
import { ServiceAddonsService } from './service-addons.service';
import { ServicesHttpController } from './services.http.controller';
import { ServiceVariantsController } from './service-variants.controller';
import { ServiceAddonsController } from './service-addons.controller';
import { ServiceCategoriesController } from '../service-categories/service-categories.controller';
import { ServiceProfileService } from './service-profile.service';

@Module({
  imports: [PrismaModule, RedisCacheModule],
  controllers: [
    ServicesHttpController,
    ServiceCategoriesController,
    ServiceVariantsController,
    ServiceAddonsController,
  ],
  providers: [
    ServicesService,
    ServiceVariantsService,
    ServiceAddonsService,
    ServiceProfileService,
  ],
  exports: [
    ServicesService,
    ServiceVariantsService,
    ServiceAddonsService,
    ServiceProfileService,
  ],
})
export class ServicesModule {}
