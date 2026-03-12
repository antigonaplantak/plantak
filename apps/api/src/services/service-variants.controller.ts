import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ServiceVariantsService } from './service-variants.service';
import { CreateServiceVariantDto } from './dto/create-service-variant.dto';
import { UpdateServiceVariantDto } from './dto/update-service-variant.dto';

@Controller('services/:serviceId/variants')
@UseGuards(JwtAuthGuard)
export class ServiceVariantsController {
  constructor(private readonly svc: ServiceVariantsService) {}

  @Post()
  create(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Body() dto: CreateServiceVariantDto,
  ) {
    return this.svc.create(req.user.sub, serviceId, dto);
  }

  @Get()
  list(@Req() req: any, @Param('serviceId') serviceId: string) {
    return this.svc.list(req.user.sub, serviceId);
  }

  @Patch(':variantId')
  update(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateServiceVariantDto,
  ) {
    return this.svc.update(req.user.sub, serviceId, variantId, dto);
  }

  @Delete(':variantId')
  archive(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Param('variantId') variantId: string,
  ) {
    return this.svc.archive(req.user.sub, serviceId, variantId);
  }
}
