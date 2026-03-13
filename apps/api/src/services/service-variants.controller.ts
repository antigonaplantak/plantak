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
import type { Request } from 'express';

type ReqUser = { sub?: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@Controller('services/:serviceId/variants')
@UseGuards(JwtAuthGuard)
export class ServiceVariantsController {
  constructor(private readonly svc: ServiceVariantsService) {}

  @Post()
  create(
    @Req() req: ReqWithUser,
    @Param('serviceId') serviceId: string,
    @Body() dto: CreateServiceVariantDto,
  ) {
    return this.svc.create(String(req.user?.sub ?? ''), serviceId, dto);
  }

  @Get()
  list(@Req() req: ReqWithUser, @Param('serviceId') serviceId: string) {
    return this.svc.list(String(req.user?.sub ?? ''), serviceId);
  }

  @Patch(':variantId')
  update(
    @Req() req: ReqWithUser,
    @Param('serviceId') serviceId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateServiceVariantDto,
  ) {
    return this.svc.update(
      String(req.user?.sub ?? ''),
      serviceId,
      variantId,
      dto,
    );
  }

  @Delete(':variantId')
  archive(
    @Req() req: ReqWithUser,
    @Param('serviceId') serviceId: string,
    @Param('variantId') variantId: string,
  ) {
    return this.svc.archive(String(req.user?.sub ?? ''), serviceId, variantId);
  }
}
